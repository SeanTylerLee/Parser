#!/usr/bin/env python3
"""Local static server + TxPROS proxy.

TxDMV APIs have no CORS headers, so the browser cannot call them directly.
This server serves the site and proxies permit/route fetches server-side.

  python3 server.py
  open http://127.0.0.1:8765/
"""

from __future__ import annotations

import json
import math
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
OK_LOCAL_URL = (
    "https://services6.arcgis.com/RBtoEUQ2lmN0K3GY/arcgis/rest/services/"
    "Local_Roadways/FeatureServer/0/query"
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


_STREET_CACHE: dict[str, dict] = {}
_STREET_TYPES = {
    "rd", "st", "ave", "blvd", "dr", "ln", "hwy", "byp", "cir", "pkwy", "trl", "pl", "ct",
    "road", "street", "avenue", "drive", "lane", "highway", "bypass",
}
_STREET_DIRS = {
    "n", "s", "e", "w", "ne", "nw", "se", "sw",
    "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest",
}
_DIR_NORM = {
    "north": "n", "south": "s", "east": "e", "west": "w",
    "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw",
}
_ORDS = {
    "first": "1st", "second": "2nd", "third": "3rd", "fourth": "4th", "fifth": "5th",
    "sixth": "6th", "seventh": "7th", "eighth": "8th", "ninth": "9th", "tenth": "10th",
}


def _street_tokens(name: str) -> list[str]:
    raw = re.sub(r"[^a-z0-9]+", " ", str(name or "").lower().replace(".", " ")).strip()
    return [_ORDS.get(w, _DIR_NORM.get(w, w)) for w in raw.split()]


def _street_match(a: str, b: str) -> bool:
    ta, tb = _street_tokens(a), _street_tokens(b)
    if not ta or not tb:
        return False
    if ta == tb:
        return True
    sa = [w for w in ta if w not in _STREET_TYPES]
    sb = [w for w in tb if w not in _STREET_TYPES]
    return bool(sa) and sa == sb


def _local_needles(names: list[str]) -> list[str]:
    """Search tokens for ODOT STREETNAME. Grid roads keep the direction letter."""
    needles: list[str] = []
    for name in names:
        raw = re.sub(r"[^A-Za-z0-9]+", " ", name).upper().strip()
        raw = re.sub(r"\b(ROAD|STREET|AVENUE|DRIVE|LANE|BOULEVARD|HIGHWAY|HWY|RD|ST|AVE|DR|LN|BLVD)\b", " ", raw)
        raw = re.sub(r"\s+", " ", raw).strip()
        grid = re.search(r"\b([NSEW])\s*(\d+)\b", raw.replace(" ", ""))
        spaced = re.sub(r"([A-Z])(\d)", r"\1 \2", raw)
        grid = re.search(r"\b([NSEW])\s+(\d+)\b", spaced)
        token = None
        if grid:
            token = f"{grid.group(1)}{grid.group(2)}"
        else:
            words = [w for w in spaced.split() if len(w) >= 4 and w not in {"NORTH", "SOUTH", "EAST", "WEST", "NORTHWEST", "NORTHEAST", "SOUTHWEST", "SOUTHEAST"}]
            token = words[0] if words else None
        if token and token not in needles:
            needles.append(token)
    return needles[:8]


def ok_local_fetch(lat: float, lng: float, radius_m: float, names: list[str]) -> dict:
    """ODOT local-road centerlines near a point, matched to permit street names."""
    names = [n.strip() for n in names if n and n.strip()]
    needles = _local_needles(names)
    if not names or not needles:
        return {"ok": True, "ways": []}

    radius_m = max(800.0, min(float(radius_m), 20000.0))
    dlat = radius_m / 111320.0
    dlng = radius_m / (111320.0 * max(0.2, abs(__import__("math").cos(__import__("math").radians(lat)))))
    west, south, east, north = lng - dlng, lat - dlat, lng + dlng, lat + dlat
    key = f"local:{round(lat,3)},{round(lng,3)},{int(radius_m)//500}|{'|'.join(needles)}"
    cached = _STREET_CACHE.get(key)
    if cached:
        return cached

    likes = " OR ".join(f"UPPER(STREETNAME) LIKE '%{re.sub(chr(39), '', n)}%'" for n in needles)
    params = urllib.parse.urlencode(
        {
            "where": likes,
            "geometry": f"{west},{south},{east},{north}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "STREETNAME,MLENGTH",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
        }
    )
    try:
        req = urllib.request.Request(
            f"{OK_LOCAL_URL}?{params}",
            headers={"User-Agent": UA, "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=25) as res:
            gj = json.loads(res.read().decode("utf-8"))
    except Exception as exc:
        return {"ok": True, "ways": [], "warning": f"Local roads unavailable ({exc})"}

    ways = []
    for feat in gj.get("features") or []:
        props = feat.get("properties") or {}
        street = props.get("STREETNAME") or ""
        matched = next((n for n in names if _street_match(n, street) or _street_match(_compact_road(n), street)), None)
        if matched is None and not any(n.upper().replace(" ", "") in street.upper().replace(" ", "") or _compact_road(n).replace(" ", "") in street.upper().replace(" ", "") for n in names):
            # Grid form E1650 vs permit "E 1650 Rd" is handled by _street_match after compact.
            matched = next((n for n in names if _grid_match(n, street)), None)
        if not matched:
            continue
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates") or []
        parts = [coords] if gtype == "LineString" else coords if gtype == "MultiLineString" else []
        for part in parts:
            cleaned = [[float(p[0]), float(p[1])] for p in part if isinstance(p, (list, tuple)) and len(p) >= 2]
            if len(cleaned) >= 2:
                ways.append({"name": street, "matched": matched, "coords": cleaned})

    if not ways:
        ways = _osm_named_ways(lat, lng, radius_m, names)
    result = {"ok": True, "ways": ways}
    if ways:
        _STREET_CACHE[key] = result
    return result


def _compact_road(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", " ", str(name or "")).upper()
    s = re.sub(r"\b(ROAD|STREET|AVENUE|DRIVE|LANE|BOULEVARD|HIGHWAY|HWY|RD|ST|AVE|DR|LN|BLVD)\b", " ", s)
    s = re.sub(r"\bBYPASS\b", "BYP", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\b([NSEW])\s+(\d+)\b", r"\1\2", s)
    return s


def _grid_match(permit_name: str, street: str) -> bool:
    a = _compact_road(permit_name).replace(" ", "")
    b = _compact_road(street).replace(" ", "")
    if not a or not b:
        return False
    if a == b:
        return True
    # "EBLACKBURN" vs "BLACKBURN", "JENSENE" vs "JENSENW" — same core, direction is not the road.
    def core(s: str) -> str:
        s = re.sub(r"^(NW|NE|SW|SE|N|S|E|W)", "", s)
        s = re.sub(r"(NW|NE|SW|SE|N|S|E|W)$", "", s)
        return s
    ca, cb = core(a), core(b)
    if not ca or not cb or ca != cb:
        return False
    # Grid numbers must keep their letter: E1650 is not N1650.
    if re.search(r"\d", ca):
        return a == b
    return True


def _osm_named_ways(lat: float, lng: float, radius_m: float, names: list[str]) -> list[dict]:
    """Named roads the ODOT local layer does not label.

    Uses the OpenStreetMap map API in a small box. A wide Overpass query
    times out and was dropping real roads that sit under the turn.
    """
    if not _local_needles(names):
        return []
    radius = float(max(1200, min(float(radius_m), 4500)))
    dlat = radius / 111320.0
    dlng = radius / (111320.0 * max(0.2, abs(math.cos(math.radians(lat)))))
    west, south, east, north = lng - dlng, lat - dlat, lng + dlng, lat + dlat
    if (east - west) * (north - south) > 0.02:
        return []
    url = (
        "https://api.openstreetmap.org/api/0.6/map.json?bbox="
        f"{west:.5f},{south:.5f},{east:.5f},{north:.5f}"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except Exception:
        return []
    nodes = {}
    for el in payload.get("elements") or []:
        if el.get("type") == "node" and "lat" in el and "lon" in el:
            nodes[el["id"]] = (float(el["lon"]), float(el["lat"]))
    ways = []
    for el in payload.get("elements") or []:
        if el.get("type") != "way":
            continue
        tags = el.get("tags") or {}
        if "highway" not in tags:
            continue
        street = tags.get("name") or ""
        matched = next((n for n in names if _grid_match(n, street)), None)
        if not matched:
            continue
        cleaned = [list(nodes[nid]) for nid in (el.get("nodes") or []) if nid in nodes]
        if len(cleaned) >= 2:
            ways.append({"name": street, "matched": matched, "coords": cleaned})
    return ways


def ok_streets_fetch(names: list[str], bbox: list[float] | None = None, around: tuple[float, float, float] | None = None) -> dict:
    """Named local roads matched against permit street names.

    around = (lat, lng, radius_meters). bbox is west,south,east,north.
    """
    names = [n.strip() for n in names if n and n.strip()]
    if not names or (around is None and (not bbox or len(bbox) != 4)):
        return {"ok": False, "error": "Pass names plus bbox or lat/lng"}

    if around is not None:
        lat, lng, radius_m = around
        radius_m = int(max(400, min(float(radius_m), 8000)))
        spatial = f"(around:{radius_m},{lat},{lng})"
        key = (
            f"a:{round(lat, 3)},{round(lng, 3)},{radius_m // 500}|"
            + "|".join(sorted(n.lower() for n in names))
        )
    else:
        west, south, east, north = bbox or []
        west -= 0.05
        south -= 0.05
        east += 0.05
        north += 0.05
        spatial = f"({south},{west},{north},{east})"
        key = (
            f"{round(west, 2)},{round(south, 2)},{round(east, 2)},{round(north, 2)}|"
            + "|".join(sorted(n.lower() for n in names))
        )
    cached = _STREET_CACHE.get(key)
    if cached:
        return cached

    frags: list[str] = []
    for name in names:
        toks = _street_tokens(name)
        sig = [t for t in toks if t not in _STREET_TYPES and t not in _STREET_DIRS]
        if not sig:
            sig = [t for t in toks if t]
        if not sig:
            continue
        parts = []
        for t in sig:
            # Short numbers like "22" must not match 122 or 220.
            if t.isdigit() and len(t) <= 3:
                parts.append(rf"(^|[^0-9]){re.escape(t)}([^0-9]|$)")
            else:
                parts.append(re.escape(t))
        frag = r"[^a-zA-Z0-9]+".join(parts)
        if frag not in frags:
            frags.append(frag)
    if not frags:
        return {"ok": True, "ways": []}

    regex = "|".join(frags[:16])
    query = (
        "[out:json][timeout:12];"
        f'way["highway"]["name"~"{regex}",i]{spatial};'
        "out geom;"
    )
    payload = None
    last_err: Exception | None = None
    # One short lookup. A dead map server must not stall every local step.
    try:
        req = urllib.request.Request(
            "https://overpass-api.de/api/interpreter",
            data=urllib.parse.urlencode({"data": query}).encode(),
            method="POST",
            headers={"User-Agent": UA, "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=8) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except Exception as exc:
        last_err = exc
    if payload is None:
        return {"ok": True, "ways": [], "warning": f"Local roads unavailable ({last_err})"}

    ways = []
    for el in payload.get("elements") or []:
        name = (el.get("tags") or {}).get("name") or ""
        matched = next((n for n in names if _street_match(n, name)), None)
        if not matched:
            continue
        coords = [
            [float(g["lon"]), float(g["lat"])]
            for g in (el.get("geometry") or [])
            if "lon" in g and "lat" in g
        ]
        if len(coords) >= 2:
            ways.append({"name": name, "matched": matched, "coords": coords})

    result = {"ok": True, "ways": ways}
    _STREET_CACHE[key] = result
    return result


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
        if parsed.path == "/api/ok/streets":
            return self._ok_streets(parsed)
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

    def _ok_streets(self, parsed):
        qs = parse_qs(parsed.query)
        names_raw = (qs.get("names") or [""])[0]
        bbox_raw = (qs.get("bbox") or [""])[0]
        names = [n.strip() for n in names_raw.split("|") if n.strip()]
        lat_raw = (qs.get("lat") or [""])[0]
        lng_raw = (qs.get("lng") or [""])[0]
        rad_raw = (qs.get("radius_m") or ["2000"])[0]
        around = None
        bbox = None
        if lat_raw and lng_raw:
            try:
                around = (float(lat_raw), float(lng_raw), float(rad_raw))
            except ValueError:
                around = None
        else:
            try:
                bbox = [float(x) for x in bbox_raw.split(",")]
            except ValueError:
                bbox = []
            if len(bbox) != 4:
                bbox = None
        if not names or (around is None and bbox is None):
            return self._json(400, {"ok": False, "error": "Pass lat, lng, names or a bbox"})
        try:
            if around is not None:
                return self._json(200, ok_local_fetch(around[0], around[1], around[2], names))
            return self._json(200, ok_streets_fetch(names, bbox=bbox, around=None))
        except Exception as e:
            return self._json(200, {"ok": True, "ways": [], "warning": str(e)})

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
    print("OK streets: /api/ok/streets?bbox=west,south,east,north&names=E 1650 Rd")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
