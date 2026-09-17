#!/usr/bin/env python3
"""Local static server + TxPROS proxy.

TxDMV APIs have no CORS headers, so the browser cannot call them directly.
This server serves the site and proxies permit/route fetches server-side.

  python3 server.py
  open http://127.0.0.1:8765/
"""

from __future__ import annotations

import json
import re
import http.cookiejar
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
PORT = 8765
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 FleetBordPermitParser/1.0"


def txpros_fetch(permit_id: int) -> dict:
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    # Establish ASP.NET session (required by RouteService).
    page = urllib.request.Request(
        f"https://txpros.txdmv.gov/PermitDetails02.aspx?PermitID={permit_id}&QRUSER=1",
        headers={"User-Agent": UA},
    )
    opener.open(page, timeout=45).read()

    def post(url: str, payload: dict) -> dict:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Accept": "application/json",
                "User-Agent": UA,
                "Origin": "https://txpros.txdmv.gov",
                "Referer": f"https://txpros.txdmv.gov/PermitDetails02.aspx?PermitID={permit_id}&QRUSER=1",
            },
        )
        with opener.open(req, timeout=60) as res:
            return json.loads(res.read().decode("utf-8"))

    permit = post(
        "https://txpros.txdmv.gov/Services/PermitService.svc/GetQRPermit",
        {"PermitID": permit_id},
    ).get("d") or {}

    route = post(
        "https://txpros.txdmv.gov/Services/RouteService.asmx/GetLatLonForPermit",
        {"PermitID": permit_id, "UseHistoryDB": False, "AuditPermitID": -1},
    ).get("d") or {}

    latlons = route.get("LatLons") or []
    coords = [[p["Lon"], p["Lat"]] for p in latlons if p.get("Lat") is not None and p.get("Lon") is not None]

    trips = permit.get("Trips") or []
    driving = []
    if trips:
        for d in trips[0].get("DrivingDirs") or []:
            driving.append(
                {
                    "miles": d.get("Miles"),
                    "distance": d.get("Distance"),
                    "route": d.get("Route") or "",
                    "to": d.get("To") or "",
                    "sequence": d.get("SequenceNo"),
                    "time_sec": d.get("Time"),
                }
            )

    return {
        "ok": True,
        "permit_id": permit_id,
        "permit_no": permit.get("PermitNo"),
        "status": permit.get("Status"),
        "permit_type": permit.get("PermitTypeName") or permit.get("PermitPrintName"),
        "company": permit.get("CompanyName") or "",
        "driving_dirs": driving,
        "conditions": [
            c.get("Condition") for c in (permit.get("ConditionItems") or []) if c.get("Condition")
        ],
        "route": {
            "coordinates": coords,  # [lng, lat] for Mapbox
            "point_count": len(coords),
            "pts_indices": route.get("ptsIndices") or [],
            "leg_types": route.get("legTypes") or [],
            "start": coords[0] if coords else None,
            "end": coords[-1] if coords else None,
        },
        "txpros_url": f"https://txpros.txdmv.gov/PermitDetails02.aspx?PermitID={permit_id}&QRUSER=1",
    }


OK_LRS_URL = (
    "https://services6.arcgis.com/RBtoEUQ2lmN0K3GY/arcgis/rest/services/"
    "OKRoads_LRS/FeatureServer/0/query"
)


def ok_lrs_fetch(routes: list[str], bbox: list[float]) -> dict:
    """Fetch ODOT LRS centerlines for route codes inside a WGS84 bbox.

    bbox = [west, south, east, north]
    routes = ['U081', 'I040', 'S034', ...]
    """
    if not routes:
        return {"ok": False, "error": "Pass ?routes=U081,I040"}
    if len(bbox) != 4:
        return {"ok": False, "error": "Pass ?bbox=west,south,east,north"}

    # Pad bbox so mid-route jogs are included.
    pad = 0.15
    west, south, east, north = bbox
    west -= pad
    south -= pad
    east += pad
    north += pad

    quoted = ",".join("'" + re.sub(r"[^A-Za-z0-9]", "", r) + "'" for r in routes)
    where = f"ODOTROUTE IN ({quoted})"
    params = urllib.parse.urlencode(
        {
            "where": where,
            "geometry": f"{west},{south},{east},{north}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "ODOTROUTE,MLENGTH",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
        }
    )
    req = urllib.request.Request(
        f"{OK_LRS_URL}?{params}",
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        gj = json.loads(res.read().decode("utf-8"))

    by_route: dict[str, list] = {r: [] for r in routes}
    for feat in gj.get("features") or []:
        props = feat.get("properties") or {}
        code = props.get("ODOTROUTE")
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates") or []
        lines = []
        if gtype == "LineString":
            lines = [coords]
        elif gtype == "MultiLineString":
            lines = coords
        if code in by_route:
            for line in lines:
                # GeoJSON is [lng, lat]
                cleaned = [[float(p[0]), float(p[1])] for p in line if len(p) >= 2]
                if len(cleaned) >= 2:
                    by_route[code].append(cleaned)

    return {
        "ok": True,
        "routes": {k: v for k, v in by_route.items() if v},
        "bbox": [west, south, east, north],
    }


SAFEHAUL_VIEWER = (
    "https://permitmanager.okladot.state.ok.us/safehaul/permitting/services/"
    "permitinfo/PermitViewer/"
)
SAFEHAUL_PDF = (
    "https://permitmanager.okladot.state.ok.us/safehaul/permitting/services/"
    "permitinfo/PermitViewer/PermitViewer/DownloadPdf"
)


def safehaul_fetch(permit_no: str) -> dict:
    """Scrape OK SafeHaul PermitViewer details for a permit number."""
    pid = re.sub(r"\D", "", str(permit_no or ""))
    if len(pid) < 10:
        return {"ok": False, "error": "Pass a full Oklahoma permit number"}

    viewer_url = f"{SAFEHAUL_VIEWER}?id={pid}&v="
    req = urllib.request.Request(
        viewer_url,
        headers={"User-Agent": UA, "Accept": "text/html"},
    )
    with urllib.request.urlopen(req, timeout=45) as res:
        html = res.read().decode("utf-8", "ignore")

    def cell(label: str) -> str | None:
        m = re.search(
            rf"<th>\s*{re.escape(label)}\s*</th>\s*<td>\s*(.*?)\s*</td>",
            html,
            re.I | re.S,
        )
        if not m:
            return None
        return re.sub(r"<[^>]+>", "", m.group(1)).strip()

    origin = cell("Origin") or ""
    dest = cell("Destination") or ""
    coords = None
    cm = re.search(r"\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]", origin)
    if cm:
        a, b = float(cm.group(1)), float(cm.group(2))
        # printed [lat,lng]
        lat, lng = (a, b) if abs(a) <= 90 else (b, a)
        coords = {"lat": lat, "lng": lng}

    return {
        "ok": True,
        "permit_number": pid,
        "status": cell("Status"),
        "start_date": cell("Start Date"),
        "end_date": cell("End Date"),
        "company": cell("Company Name"),
        "origin": origin,
        "destination": dest,
        "origin_coords": coords,
        "safe_route": cell("Safe Route"),
        "viewer_url": viewer_url,
        "pdf_url": f"{SAFEHAUL_PDF}?id={pid}",
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        if self.path.startswith("/api/"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/txpros/permit":
            return self._txpros(parsed)
        if parsed.path == "/api/ok/lrs":
            return self._ok_lrs(parsed)
        if parsed.path == "/api/ok/safehaul":
            return self._ok_safehaul(parsed)
        return super().do_GET()

    def _ok_safehaul(self, parsed):
        qs = parse_qs(parsed.query)
        raw = (qs.get("id") or qs.get("permit") or qs.get("permitNumber") or [""])[0]
        try:
            payload = safehaul_fetch(raw)
            status = 200 if payload.get("ok") else 400
            return self._json(status, payload)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")[:300]
            return self._json(502, {"ok": False, "error": f"SafeHaul HTTP {e.code}", "detail": body})
        except Exception as e:
            return self._json(502, {"ok": False, "error": str(e)})

    def _ok_lrs(self, parsed):
        qs = parse_qs(parsed.query)
        routes_raw = (qs.get("routes") or [""])[0]
        bbox_raw = (qs.get("bbox") or [""])[0]
        routes = [r.strip().upper() for r in routes_raw.split(",") if r.strip()]
        try:
            bbox = [float(x) for x in bbox_raw.split(",")]
        except ValueError:
            bbox = []
        if len(bbox) != 4:
            return self._json(400, {"ok": False, "error": "Pass ?bbox=west,south,east,north&routes=U081"})
        try:
            payload = ok_lrs_fetch(routes, bbox)
            status = 200 if payload.get("ok") else 400
            return self._json(status, payload)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")[:300]
            return self._json(502, {"ok": False, "error": f"ODOT LRS HTTP {e.code}", "detail": body})
        except Exception as e:
            return self._json(502, {"ok": False, "error": str(e)})

    def _txpros(self, parsed):
        qs = parse_qs(parsed.query)
        raw = (qs.get("id") or qs.get("permitId") or qs.get("PermitID") or [""])[0].strip()
        m = re.search(r"(\d{6,})", raw) or re.search(r"PermitID=(\d+)", raw, re.I)
        if not m:
            return self._json(400, {"ok": False, "error": "Pass ?id=15256348 or a TxPROS URL"})
        permit_id = int(m.group(1))
        try:
            payload = txpros_fetch(permit_id)
            if not payload["route"]["coordinates"]:
                return self._json(502, {"ok": False, "error": "TxPROS returned no route geometry", "permit_id": permit_id})
            return self._json(200, payload)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")[:300]
            return self._json(502, {"ok": False, "error": f"TxPROS HTTP {e.code}", "detail": body, "permit_id": permit_id})
        except Exception as e:
            return self._json(502, {"ok": False, "error": str(e), "permit_id": permit_id})

    def _json(self, status: int, obj: dict):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Serving {ROOT} at http://127.0.0.1:{PORT}/")
    print("TxPROS proxy: /api/txpros/permit?id=15256348")
    print("OK LRS proxy: /api/ok/lrs?routes=U081&bbox=west,south,east,north")
    print("OK SafeHaul: /api/ok/safehaul?id=20260003543389")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
