#!/usr/bin/env python3
"""Regression check: parse + route every Oklahoma PDF in Desktop/Permits.

Mirrors js/ok-route.js candidate selection (start-end / corridor / primary)
and requires mapped miles within ~25% of the permit mileage.
"""

from __future__ import annotations

import json
import math
import re
import urllib.parse
import urllib.request
from pathlib import Path

TOKEN = "pk.eyJ1Ijoic2VhbmxlZTkyIiwiYSI6ImNtZTAyeG0wbzAwamgybHE2cmwzenJtM2cifQ.DE8FeoDvc3EzuyR5uPopzA"
BBOX = "-103.002455,33.615833,-94.430662,37.002312"
PERMITS = Path("/Users/seanlee/Desktop/Permits")

COORDS_RE = re.compile(r"\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]")
NEXT_FIELD_RE = re.compile(
    r"\s+(?:Starting\s*From|Going\s*To|Starting\s*State|Arrival\s*State|Starting\s*County|Arrival\s*County|Trailer\s*Load|Permit\s*Restrictions|Permit\s*Number)\s*:",
    re.I,
)
APPROX = re.compile(r"Approximate\s*Mileage:\s*([\d.]+)\s*mi", re.I)
STEP_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*mi\s+(.+)$", re.I)
ROAD_RE = re.compile(
    r"\b(?:onto|on)\s+((?:I|IH|US|OK|SH)\s*-?\s*\d+[A-Z]?(?:\s*Alt(?:\s*[NS])?)?)",
    re.I,
)

BORDER = [
    (re.compile(r"\bI-?40\b.*\b(TX|TEXAS)", re.I), -100.0003, 35.2271),
    (re.compile(r"\bUS-?183\b.*\b(TX|TEXAS)", re.I), -99.081751, 34.211226),
    (re.compile(r"\bUS-?81\b.*\b(TX|TEXAS)", re.I), -97.93377, 33.879015),
    (re.compile(r"\bUS-?83\b.*\b(TX|TEXAS)", re.I), -100.806, 36.5),
    (re.compile(r"\bUS-?60\b.*\b(TX|TEXAS)", re.I), -100.001, 36.131),
    (re.compile(r"\bOK-?34\b.*\b(KS|KANSAS)", re.I), -99.629, 36.985),
    (re.compile(r"\bUS-?270\b.*\b(KS|KANSAS)", re.I), -100.87, 36.999),
    (re.compile(r"\bUS-?83\b.*\b(KS|KANSAS)", re.I), -100.87, 36.999),
]


def main() -> int:
    from pypdf import PdfReader

    files = sorted(p for p in PERMITS.glob("*.pdf") if re.search(r"ok|OKDOT", p.name, re.I))
    if not files:
        print("No OK PDFs found in", PERMITS)
        return 1

    failed = 0
    for path in files:
        text = "\n".join((p.extract_text() or "") for p in PdfReader(str(path)).pages)
        origin = extract(text, "Starting From")
        dest = extract(text, "Going To")
        steps = parse_steps(text)
        approx = APPROX.search(re.sub(r"\s+", " ", text))
        expected = float(approx.group(1)) if approx else sum(s["mi"] for s in steps)
        print("=" * 60, path.name)
        if not origin or not dest or origin["lng"] is None or dest["lng"] is None or not steps:
            print(" FAIL parse/resolve", origin, dest, "steps", len(steps))
            failed += 1
            continue
        best, cands = build_route(origin, dest, steps, expected)
        for c in cands:
            print("  ", c)
        ratio = (best[1] / expected) if best and best[1] else None
        ok = ratio is not None and 0.75 <= ratio <= 1.3
        print(" BEST", best, "OK" if ok else "FAIL", f"ratio={ratio and round(ratio, 2)}")
        if not ok:
            failed += 1

    print("=" * 60)
    print("PASS" if failed == 0 else f"FAILED {failed}")
    return 0 if failed == 0 else 1


def normalize(text: str) -> str:
    t = text.replace("\r", "")
    t = re.sub(r"Starting\s*\n\s*From\s*:", "Starting From:", t, flags=re.I)
    t = re.sub(r"Going\s*\n\s*To\s*:", "Going To:", t, flags=re.I)
    t = re.sub(r"Starting\s*From\s*:\s*\n\s*", "Starting From: ", t, flags=re.I)
    t = re.sub(r"Going\s*To\s*:\s*\n\s*", "Going To: ", t, flags=re.I)
    return t


def extract(text: str, label: str):
    flat = re.sub(r"\s+", " ", normalize(text))
    label_re = re.compile(
        r"Starting\s*From\s*:" if label == "Starting From" else r"Going\s*To\s*:",
        re.I,
    )
    m = label_re.search(flat)
    if not m:
        return None
    rest = flat[m.end() :].strip()
    cut = NEXT_FIELD_RE.search(rest)
    if cut:
        rest = rest[: cut.start()].strip()
    coords = COORDS_RE.search(rest)
    place = rest
    lat = lng = None
    if coords:
        lat = float(coords.group(1))
        lng = float(coords.group(2))
        place = rest[: coords.start()].strip()
    place = re.sub(r"\s+", " ", place).strip(" ,")
    place = re.sub(r"\s*\((?:Outbound|Inbound)\)\s*$", "", place, flags=re.I).strip()
    if lat is None:
        for rx, x, y in BORDER:
            if rx.search(place):
                lng, lat = x, y
                break
    return {"text": place, "lng": lng, "lat": lat}


def norm_road(raw: str) -> str:
    s = raw.upper().replace(" ", "")
    s = re.sub(r"^IH", "I", s)
    s = re.sub(r"^(I|US|OK|SH)(\d+)", r"\1-\2", s)
    s = re.sub(r"ALT.*", "", s)
    return s


def parse_steps(text: str):
    out = []
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if re.match(r"Page\s+\d+", line, re.I):
            continue
        m = STEP_RE.match(line)
        if not m:
            continue
        instr = m.group(2)
        rm = ROAD_RE.search(instr)
        road = norm_road(rm.group(1)) if rm else None
        out.append({"mi": float(m.group(1)), "instruction": instr, "road": road})
    return out


def spoken(road: str) -> str:
    m = re.match(r"(I|US|OK|SH)-(\d+)", road or "")
    if not m:
        return road or ""
    return {
        "I": f"Interstate {m.group(2)}",
        "US": f"US Highway {m.group(2)}",
        "OK": f"Oklahoma State Highway {m.group(2)}",
        "SH": f"Oklahoma State Highway {m.group(2)}",
    }[m.group(1)]


def haversine(a, b):
    r = 3958.8
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dphi = math.radians(b[1] - a[1])
    dl = math.radians(b[0] - a[0])
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def geocode(q, prox):
    params = {
        "access_token": TOKEN,
        "limit": "5",
        "autocomplete": "false",
        "country": "US",
        "bbox": BBOX,
        "types": "address,place,locality,neighborhood,district,region",
        "proximity": f"{prox[0]},{prox[1]}",
    }
    url = (
        "https://api.mapbox.com/geocoding/v5/mapbox.places/"
        f"{urllib.parse.quote(q)}.json?{urllib.parse.urlencode(params)}"
    )
    with urllib.request.urlopen(url) as res:
        return json.load(res).get("features") or []


def snap_road(road, prox, max_d=22):
    feats = geocode(f"{spoken(road)} Oklahoma", prox) + geocode(f"{road} Oklahoma", prox)
    best = None
    best_score = 1e9
    num = road.split("-")[-1] if road else ""
    for f in feats:
        c = tuple(f["center"])
        d = haversine(prox, c)
        if d > max_d:
            continue
        name = f.get("place_name") or ""
        score = d
        if num and num in name:
            score -= 3
        if "oklahoma" in name.lower() or ", ok" in name.lower():
            score -= 1
        if score < best_score:
            best_score = score
            best = c
    return best


def directions(coords):
    clean = [coords[0]]
    for p in coords[1:]:
        if haversine(clean[-1], p) > 0.5:
            clean.append(p)
    if len(clean) > 22:
        sampled = [clean[0]]
        for i in range(1, 21):
            sampled.append(clean[round(i * (len(clean) - 1) / 21)])
        if sampled[-1] != clean[-1]:
            sampled.append(clean[-1])
        clean = sampled
    path = ";".join(f"{c[0]},{c[1]}" for c in clean)
    params = urllib.parse.urlencode(
        {
            "access_token": TOKEN,
            "geometries": "geojson",
            "overview": "full",
            "continue_straight": "true",
        }
    )
    url = f"https://api.mapbox.com/directions/v5/mapbox/driving/{path}?{params}"
    with urllib.request.urlopen(url) as res:
        data = json.load(res)
    r = data["routes"][0]
    return r["distance"] / 1609.34, len(clean)


def segments(steps):
    segs = []
    cur = None
    for s in steps:
        road = s["road"]
        if not road:
            if cur:
                cur["mi"] += s["mi"]
            continue
        if cur and cur["road"] == road:
            cur["mi"] += s["mi"]
        else:
            cur = {"road": road, "mi": s["mi"]}
            segs.append(cur)
    return segs


def build_route(o, d, steps, expected):
    origin = (o["lng"], o["lat"])
    dest = (d["lng"], d["lat"])
    segs = segments(steps)
    total = sum(s["mi"] for s in segs) or expected or 1
    candidates = []

    mi, w = directions([origin, dest])
    candidates.append(("start-end", mi, w, abs(mi - expected)))

    wps = [origin]
    cum = 0
    for seg in segs:
        if seg["mi"] < max(6, total * 0.08):
            cum += seg["mi"]
            continue
        t0 = cum / total
        t1 = (cum + seg["mi"]) / total
        ts = [(t0 + t1) / 2]
        if seg["mi"] > 30:
            ts = [t0 + 0.25 * (t1 - t0), (t0 + t1) / 2, t1 - 0.25 * (t1 - t0)]
        for t in ts:
            est = lerp(origin, dest, min(0.95, max(0.05, t)))
            snapped = snap_road(seg["road"], est, max_d=22)
            if snapped:
                wps.append(snapped)
        cum += seg["mi"]
    wps.append(dest)
    try:
        mi, w = directions(wps)
        candidates.append(("corridor", mi, w, abs(mi - expected)))
    except Exception:
        pass

    if segs:
        primary = max(segs, key=lambda s: s["mi"])
        wps = [origin]
        for t in [0.2, 0.4, 0.6, 0.8]:
            est = lerp(origin, dest, t)
            snapped = snap_road(primary["road"], est, max_d=25)
            if snapped:
                wps.append(snapped)
        wps.append(dest)
        try:
            mi, w = directions(wps)
            candidates.append((f"primary-{primary['road']}", mi, w, abs(mi - expected)))
        except Exception:
            pass

    best = min(candidates, key=lambda c: c[3])
    return best, candidates


if __name__ == "__main__":
    raise SystemExit(main())
