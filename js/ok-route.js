/**
 * Oklahoma route builder — follow the permit Driving Directions literally.
 *
 * Example (OKDOTD_20260003543389):
 *   0.6 mi Start on OK-6 NB
 *   0.5 mi Continue onto OK-6 NB
 *   0.3 mi Take exit
 *   38.6 mi Continue onto I-40 W   ← WEST only, never east
 *
 * Each step walks that many miles along the named ODOT highway in the
 * stated compass direction (NB/SB/EB/WB). Mapbox is only used for short
 * "Take exit" connectors between highways.
 */

import { OKLAHOMA_BBOX, OKLAHOMA_CENTER } from "./geocode.js";

const METERS_PER_MILE = 1609.344;
const THIN_MILES = 0.02;

const BORDER_HINTS = [
  { re: /\bI-?40\b.*\b(TX|TEXAS)\b/i, lng: -100.0003, lat: 35.2271, label: "I-40 @ TX line" },
  { re: /\bUS-?183\b.*\b(TX|TEXAS)\b/i, lng: -99.081751, lat: 34.211226, label: "US-183 @ TX line" },
  { re: /\bUS-?81\b.*\b(TX|TEXAS)\b/i, lng: -97.93377, lat: 33.879015, label: "US-81 @ TX / Terral" },
  { re: /\bUS-?83\b.*\b(TX|TEXAS)\b/i, lng: -100.806, lat: 36.5, label: "US-83 @ TX panhandle" },
  { re: /\bUS-?60\b.*\b(TX|TEXAS)\b/i, lng: -100.001, lat: 36.131, label: "US-60 @ TX (Higgins)" },
  { re: /\bOK-?34\b.*\b(KS|KANSAS)\b/i, lng: -99.629, lat: 36.985, label: "OK-34 @ KS line" },
  { re: /\bUS-?270\b.*\b(KS|KANSAS)\b/i, lng: -100.87, lat: 36.999, label: "US-270/83 @ KS line" },
  { re: /\bUS-?83\b.*\b(KS|KANSAS)\b/i, lng: -100.87, lat: 36.999, label: "US-83 @ KS line" },
];

export async function buildOkRoute(parsed, token, { onStatus, baseUrl = "" } = {}) {
  const say = (m) => onStatus && onStatus(m);
  const warnings = [];

  if (!parsed?.origin?.text) throw new Error("Permit is missing Starting From.");
  if (!parsed?.destination?.text) throw new Error("Permit is missing Going To.");
  if (!parsed?.steps?.length) throw new Error("Permit has no Driving Directions.");

  say("Reading start / end from the permit…");
  const start = await resolveEndpoint(parsed.origin, "Start", token, null);
  const end = await resolveEndpoint(parsed.destination, "End", token, start);
  if (start?.lng == null) throw new Error(`Could not locate Starting From “${parsed.origin.text}”.`);
  if (end?.lng == null) throw new Error(`Could not locate Going To “${parsed.destination.text}”.`);

  const expectedMi =
    parsed.expected_miles ||
    parsed.approximate_miles ||
    parsed.steps.reduce((s, st) => s + (Number(st.leg_miles) || 0), 0);

  // Collect ODOT codes we need for every named step.
  const codes = [];
  for (const step of parsed.steps) {
    const code = step.road ? toOdotRoute(step.road) : null;
    if (code && !codes.includes(code)) codes.push(code);
  }
  if (!codes.length) throw new Error("No highway names found in Driving Directions.");

  const origin = { lng: start.lng, lat: start.lat };
  const dest = { lng: end.lng, lat: end.lat };
  const pad = Math.max(0.5, (expectedMi || 40) * 0.01);
  const bbox = [
    Math.min(origin.lng, dest.lng) - pad,
    Math.min(origin.lat, dest.lat) - pad,
    Math.max(origin.lng, dest.lng) + pad,
    Math.max(origin.lat, dest.lat) + pad,
  ];

  say(`Loading ODOT highways for steps (${codes.join(", ")})…`);
  const lrs = await fetchOkLrs(codes, bbox, baseUrl);

  say("Following permit directions step by step…");
  let pos = origin;
  const coordinates = [[pos.lng, pos.lat]];
  let lastRoad = null;
  let lastCompass = null;

  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    const miles = Number(step.leg_miles) || 0;
    const instr = String(step.instruction || "");
    const isExit = /^Take exit/i.test(instr) || /^Merge/i.test(instr) || /^\(Ramp\)$/i.test(instr);

    if (step.road) lastRoad = step.road;
    if (step.compass) lastCompass = step.compass;

    const road = step.road || lastRoad;
    const compass = step.compass || lastCompass;
    const code = road ? toOdotRoute(road) : null;

    say(
      `Step ${i + 1}/${parsed.steps.length}: ${miles} mi ${road || "exit"} ${compass || ""}`.trim(),
    );

    // "Take exit" / ramp — short hop toward the NEXT named highway.
    if (isExit || !code) {
      const next = parsed.steps.slice(i + 1).find((s) => s.road);
      const nextCode = next?.road ? toOdotRoute(next.road) : null;
      const nextLines = nextCode ? lrs.routes?.[nextCode] || [] : [];
      let target = null;
      if (nextLines.length) {
        target = nearestOnLines(nextLines, pos);
      }
      if (!target) {
        // Fall toward final destination a short distance.
        target = moveToward(pos, dest, Math.max(miles, 0.2));
      }
      const hop = await mapboxDrivePair(pos, target, token);
      if (hop?.coordinates?.length) {
        appendCoords(coordinates, hop.coordinates);
        const last = hop.coordinates[hop.coordinates.length - 1];
        pos = { lng: last[0], lat: last[1] };
      } else {
        coordinates.push([target.lng, target.lat]);
        pos = target;
      }
      continue;
    }

    const lines = lrs.routes?.[code] || [];
    if (!lines.length) {
      warnings.push(`No ODOT centerline for ${road} (${code})`);
      // Keep moving in the compass direction so we don't invent the wrong way.
      const fallback = moveByCompass(pos, compass, miles) || moveToward(pos, dest, miles);
      const hop = await mapboxDrivePair(pos, fallback, token);
      if (hop?.coordinates?.length) {
        appendCoords(coordinates, hop.coordinates);
        const last = hop.coordinates[hop.coordinates.length - 1];
        pos = { lng: last[0], lat: last[1] };
      } else {
        coordinates.push([fallback.lng, fallback.lat]);
        pos = fallback;
      }
      continue;
    }

    const walked = walkHighway(lines, pos, compass, miles, dest);
    if (!walked?.coords?.length) {
      warnings.push(`Could not walk ${miles} mi on ${road} ${compass || ""}`.trim());
      const fallback = moveByCompass(pos, compass, miles) || moveToward(pos, dest, miles);
      coordinates.push([fallback.lng, fallback.lat]);
      pos = fallback;
      continue;
    }

    // Enforce compass: reject a walk that goes the wrong way on the axis.
    if (compass && !directionOk(pos, walked.coords[walked.coords.length - 1], compass)) {
      warnings.push(`Rejected wrong-way walk on ${road} ${compass}`);
      const forced = walkHighway(lines, pos, compass, miles, dest, { strict: true });
      if (forced?.coords?.length) {
        appendCoords(coordinates, forced.coords.map((p) => [p.lng ?? p[0], p.lat ?? p[1]]));
        pos = forced.end;
        continue;
      }
    }

    appendCoords(
      coordinates,
      walked.coords.map((p) => (Array.isArray(p) ? p : [p.lng, p.lat])),
    );
    pos = walked.end;
  }

  // Finish at permit destination if still short.
  if (haversineMiles(pos, dest) > 0.4) {
    // Only continue along last highway toward dest if compass allows.
    const lastCode = lastRoad ? toOdotRoute(lastRoad) : null;
    const lines = lastCode ? lrs.routes?.[lastCode] || [] : [];
    let finished = false;
    if (lines.length && lastCompass) {
      const remain = haversineMiles(pos, dest) + 2;
      const walked = walkHighway(lines, pos, lastCompass, remain, dest, { strict: true });
      if (walked?.coords?.length) {
        appendCoords(
          coordinates,
          walked.coords.map((p) => (Array.isArray(p) ? p : [p.lng, p.lat])),
        );
        pos = walked.end;
        finished = haversineMiles(pos, dest) <= 1.5;
      }
    }
    if (!finished) {
      const hop = await mapboxDrivePair(pos, dest, token);
      // Guard: Mapbox must not reverse the final highway compass (e.g. go east on I-40 W).
      if (hop?.coordinates?.length && (!lastCompass || pathRespectsCompass(hop.coordinates, lastCompass))) {
        appendCoords(coordinates, hop.coordinates);
      } else {
        coordinates.push([dest.lng, dest.lat]);
      }
    } else {
      coordinates.push([dest.lng, dest.lat]);
    }
  } else {
    coordinates.push([dest.lng, dest.lat]);
  }

  const thin = thinCoords(coordinates, THIN_MILES);
  const distance_mi = pathMiles(thin);

  // Final safety check for this critical case: I-40 W must not net eastbound.
  const i40West = parsed.steps.some(
    (s) => /I-?40/i.test(s.road || "") && (s.compass === "WB" || /\bW\b/.test(s.instruction || "")),
  );
  if (i40West) {
    const netEast = thin[thin.length - 1][0] > thin[0][0] + 0.05;
    // More precise: from first I-40-ish midpoint onward, lng should trend down.
    const mid = thin[Math.floor(thin.length * 0.25)];
    const late = thin[Math.floor(thin.length * 0.9)];
    if (late[0] > mid[0] + 0.05) {
      warnings.push("Route still trends east on an I-40 West permit — check geometry.");
    }
    if (netEast) {
      warnings.push("Overall route ends east of start on an I-40 West permit.");
    }
  }

  const pins = [
    {
      ...start,
      label: "Start",
      displayText: parsed.origin_text || start.text,
      text: parsed.origin_text || "Start",
    },
    {
      ...end,
      label: "End",
      displayText: parsed.destination_text || end.text,
      text: parsed.destination_text || "End",
    },
  ];

  let confidence = warnings.length ? "medium" : "high";
  if (expectedMi > 0) {
    const pctOff = Math.abs(1 - distance_mi / expectedMi) * 100;
    if (pctOff > 20) {
      confidence = "medium";
      warnings.push(
        `Permit ~${expectedMi.toFixed(1)} mi, traced ~${distance_mi.toFixed(1)} mi (${pctOff.toFixed(0)}% off).`,
      );
    }
  }

  return {
    coordinates: thin,
    point_count: thin.length,
    pins,
    step_waypoints: 0,
    distance_mi,
    expected_miles: expectedMi,
    source: "permit-steps+odot-lrs",
    confidence,
    warnings,
    explanation: `Followed ${parsed.steps.length} permit steps · ${distance_mi.toFixed(1)} mi`,
    start: thin[0],
    end: thin[thin.length - 1],
  };
}

/**
 * Walk `miles` along ODOT lines from `from`, only in `compass` direction.
 */
function walkHighway(lines, from, compass, miles, dest, { strict = false } = {}) {
  const targetMeters = Math.max(miles, 0.05) * METERS_PER_MILE;
  const startPt = [from.lng, from.lat];

  // Nearest vertex on any piece.
  let best = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (let i = 0; i < line.length; i++) {
      const d = haversineMeters(startPt, line[i]);
      if (!best || d < best.d) best = { li, i, d, line };
    }
  }
  if (!best || best.d > 20 * METERS_PER_MILE) return null;

  let line = best.line;
  let liCur = best.li;
  let i = best.i;
  let dir = pickCompassDirection(line, i, compass, dest);

  const out = [xy(line[i])];
  let traveled = 0;
  const used = new Set([`${liCur}:${i}`]);

  while (traveled < targetMeters) {
    const nextIdx = i + dir;
    if (nextIdx >= 0 && nextIdx < line.length) {
      const a = line[i];
      const b = line[nextIdx];
      if (compass && !segmentRespectsCompass(a, b, compass) && strict) {
        break;
      }
      if (compass && !segmentRespectsCompass(a, b, compass) && !strict) {
        // Try flipping direction once if we started the wrong way.
        const other = -dir;
        const alt = i + other;
        if (alt >= 0 && alt < line.length && segmentRespectsCompass(line[i], line[alt], compass)) {
          dir = other;
          continue;
        }
      }
      traveled += haversineMeters(a, b);
      out.push(xy(b));
      i = nextIdx;
      used.add(`${liCur}:${i}`);
      continue;
    }

    // Join next piece that continues in compass direction.
    const tip = line[i];
    let jump = null;
    for (let li = 0; li < lines.length; li++) {
      const other = lines[li];
      for (const [j, endIsTail] of [
        [0, false],
        [other.length - 1, true],
      ]) {
        const key = `${li}:${j}`;
        if (used.has(key)) continue;
        const p = other[j];
        const d = haversineMeters(tip, p);
        if (d > 1.5 * METERS_PER_MILE) continue;
        if (compass && !segmentRespectsCompass(tip, p, compass) && d > 0.05 * METERS_PER_MILE) {
          continue;
        }
        // Orient so we leave the join point in compass direction.
        const oriented = endIsTail ? other.slice().reverse() : other.slice();
        // After joining at oriented[0], next step should respect compass.
        if (oriented.length >= 2 && compass && !segmentRespectsCompass(oriented[0], oriented[1], compass)) {
          continue;
        }
        if (!jump || d < jump.d) jump = { li, j, d, line: oriented };
      }
    }
    if (!jump) break;
    traveled += jump.d;
    out.push(xy(jump.line[0]));
    line = jump.line;
    liCur = jump.li;
    i = 0;
    dir = 1;
    used.add(`${liCur}:0`);
  }

  if (out.length < 2) return null;
  return { coords: out, end: out[out.length - 1] };
}

function pickCompassDirection(line, index, compass, dest) {
  if (!compass) {
    // Fall back: move toward destination.
    const cur = line[index];
    const destPt = [dest.lng, dest.lat];
    let bestDir = 1;
    let best = Infinity;
    for (const d of [1, -1]) {
      const j = index + d;
      if (j < 0 || j >= line.length) continue;
      const dist = haversineMeters(line[j], destPt);
      if (dist < best) {
        best = dist;
        bestDir = d;
      }
    }
    return bestDir;
  }
  for (const d of [1, -1]) {
    const j = index + d;
    if (j < 0 || j >= line.length) continue;
    if (segmentRespectsCompass(line[index], line[j], compass)) return d;
  }
  return 1;
}

function segmentRespectsCompass(a, b, compass) {
  const aa = Array.isArray(a) ? a : [a.lng, a.lat];
  const bb = Array.isArray(b) ? b : [b.lng, b.lat];
  const dLng = bb[0] - aa[0];
  const dLat = bb[1] - aa[1];
  // Allow tiny noise; require dominant axis matches.
  const eps = 1e-7;
  switch (compass) {
    case "NB":
      return dLat >= -eps;
    case "SB":
      return dLat <= eps;
    case "EB":
      return dLng >= -eps;
    case "WB":
      return dLng <= eps;
    default:
      return true;
  }
}

function directionOk(from, to, compass) {
  const a = Array.isArray(from) ? from : [from.lng, from.lat];
  const b = Array.isArray(to) ? to : [to.lng, to.lat];
  return segmentRespectsCompass(a, b, compass);
}

function pathRespectsCompass(coords, compass) {
  if (!coords || coords.length < 2) return true;
  // Net movement must match compass.
  return segmentRespectsCompass(coords[0], coords[coords.length - 1], compass);
}

function moveByCompass(from, compass, miles) {
  if (!compass) return null;
  const deg = miles / 69; // rough degrees
  const lngDeg = miles / (Math.cos((from.lat * Math.PI) / 180) * 69);
  switch (compass) {
    case "NB":
      return { lng: from.lng, lat: from.lat + deg };
    case "SB":
      return { lng: from.lng, lat: from.lat - deg };
    case "EB":
      return { lng: from.lng + lngDeg, lat: from.lat };
    case "WB":
      return { lng: from.lng - lngDeg, lat: from.lat };
    default:
      return null;
  }
}

function moveToward(from, to, miles) {
  const total = haversineMiles(from, to) || 1;
  const t = Math.min(0.99, miles / total);
  return {
    lng: from.lng + (to.lng - from.lng) * t,
    lat: from.lat + (to.lat - from.lat) * t,
  };
}

function nearestOnLines(lines, from) {
  const startPt = [from.lng, from.lat];
  let best = null;
  for (const line of lines) {
    for (const p of line) {
      const d = haversineMeters(startPt, p);
      if (!best || d < best.d) best = { d, p };
    }
  }
  return best ? xy(best.p) : null;
}

function xy(p) {
  return Array.isArray(p) ? { lng: p[0], lat: p[1] } : p;
}

export function toOdotRoute(road) {
  const s = String(road || "").trim();
  const m = /^(I|IH|US|OK|SH)\s*-?\s*(\d+)([A-Z])?(?:\s*Alt(?:\s*[NS])?)?/i.exec(s);
  if (!m) return null;
  let prefix = m[1].toUpperCase();
  if (prefix === "IH") prefix = "I";
  if (prefix === "OK" || prefix === "SH") prefix = "S";
  if (prefix === "US") prefix = "U";
  const num = String(m[2]).padStart(3, "0");
  let suffix = (m[3] || "").toUpperCase();
  if (/Alt/i.test(s) && !suffix) suffix = "A";
  return `${prefix}${num}${suffix}`;
}

async function fetchOkLrs(routes, bbox, baseUrl) {
  const params = new URLSearchParams({
    routes: routes.join(","),
    bbox: bbox.join(","),
  });
  const res = await fetch(`${baseUrl}/api/ok/lrs?${params}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.error || `ODOT LRS fetch failed (${res.status})`);
  return json;
}

async function mapboxDrivePair(from, to, token) {
  const miles = haversineMiles(from, to);
  if (miles < 0.04) {
    return {
      coordinates: [
        [from.lng, from.lat],
        [to.lng, to.lat],
      ],
    };
  }
  if (miles > 30) return null;
  const path = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const params = new URLSearchParams({
    access_token: token,
    geometries: "geojson",
    overview: "full",
  });
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${path}?${params}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const coordinates = json.routes?.[0]?.geometry?.coordinates;
  return coordinates?.length ? { coordinates } : null;
}

function appendCoords(into, next) {
  if (!next?.length) return;
  for (const p of next) {
    const pt = Array.isArray(p) ? p : [p.lng, p.lat];
    const prev = into[into.length - 1];
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) into.push(pt);
  }
}

function thinCoords(coords, minMiles) {
  if (!coords?.length) return [];
  const out = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    if (haversineMiles(out[out.length - 1], coords[i]) >= minMiles) out.push(coords[i]);
  }
  const last = coords[coords.length - 1];
  const prev = out[out.length - 1];
  if (!prev || prev[0] !== last[0] || prev[1] !== last[1]) out.push(last);
  return out;
}

function pathMiles(coords) {
  let mi = 0;
  for (let i = 1; i < coords.length; i++) mi += haversineMiles(coords[i - 1], coords[i]);
  return mi;
}

async function resolveEndpoint(endpoint, label, token, previous) {
  if (endpoint?.lat != null && endpoint?.lng != null) {
    return {
      label,
      displayText: endpoint.text,
      text: endpoint.text,
      lng: endpoint.lng,
      lat: endpoint.lat,
      score: 100,
      weak: false,
      ok: true,
      source: "pdf-coords",
    };
  }
  const text = String(endpoint?.text || "")
    .replace(/\s*\((?:Outbound|Inbound)\)\s*$/i, "")
    .trim();
  for (const h of BORDER_HINTS) {
    if (h.re.test(text)) {
      return {
        label,
        displayText: text,
        text,
        place: h.label,
        lng: h.lng,
        lat: h.lat,
        score: 85,
        weak: false,
        ok: true,
        source: "border-hint",
      };
    }
  }
  const params = new URLSearchParams({
    access_token: token,
    limit: "5",
    country: "US",
    bbox: OKLAHOMA_BBOX.join(","),
    proximity:
      previous?.lng != null
        ? `${previous.lng},${previous.lat}`
        : `${OKLAHOMA_CENTER[0]},${OKLAHOMA_CENTER[1]}`,
  });
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(text + ", Oklahoma")}.json?${params}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  const f = json.features?.[0];
  if (!f?.center) return null;
  return {
    label,
    displayText: text,
    text,
    place: f.place_name,
    lng: f.center[0],
    lat: f.center[1],
    score: 60,
    weak: true,
    ok: true,
    source: "geocode",
  };
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const aa = Array.isArray(a) ? a : [a.lng, a.lat];
  const bb = Array.isArray(b) ? b : [b.lng, b.lat];
  const lat1 = toR(aa[1]);
  const lat2 = toR(bb[1]);
  const dLat = toR(bb[1] - aa[1]);
  const dLon = toR(bb[0] - aa[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

function haversineMiles(a, b) {
  return haversineMeters(a, b) / METERS_PER_MILE;
}

export function endpointQueries() {
  return [];
}

/** SafeHaul PermitViewer lookup by permit number. */
export async function fetchSafehaulPermit(permitNumber, { baseUrl = "" } = {}) {
  const id = String(permitNumber || "").replace(/\D/g, "");
  if (!id) throw new Error("Need an Oklahoma permit number.");
  const res = await fetch(`${baseUrl}/api/ok/safehaul?id=${encodeURIComponent(id)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.error || `SafeHaul fetch failed (${res.status})`);
  return json;
}

export function safehaulViewerUrl(permitNumber) {
  const id = String(permitNumber || "").replace(/\D/g, "");
  return `https://permitmanager.okladot.state.ok.us/safehaul/permitting/services/permitinfo/PermitViewer/?id=${id}&v=`;
}
