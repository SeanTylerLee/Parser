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
        return super().do_GET()

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
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
