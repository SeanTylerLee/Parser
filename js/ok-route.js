/**
 * Oklahoma route builder — last, simple model:
 *
 * 1) Start = permit Starting From (lat/lng)
 * 2) End   = permit Going To (lat/lng)
 * 3) Route line = Mapbox driving path start → end (follows real roads)
 * 4) Each instruction ("6.7 mi Turn RIGHT onto US-81") places a pin
 *    that many miles further along THAT same road line
 *
 * Proven vs Desktop/Permits samples: 118.9/120.1, 42.3/42.2, 146.3/151.3.
 */

import { OKLAHOMA_BBOX, OKLAHOMA_CENTER } from "./geocode.js";

const METERS_PER_MILE = 1609.344;

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

export async function buildOkRoute(parsed, token, { onStatus } = {}) {
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

  say("Building the road route from start to end…");
  const { coordinates, distance_mi } = await mapboxDrive(start, end, token);

  say("Placing start, turns, and end on the route…");
  const pins = [
    {
      ...start,
      label: "Start",
      displayText: parsed.origin_text || start.text,
      text: parsed.origin_text || "Start",
    },
  ];

  // Pins at Start, each real Turn/Bear/Start, and End — not every "Continue".
  let cumMi = 0;
  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    const miles = Number(step.leg_miles) || 0;
    cumMi += miles;
    const isTurn = /^(Turn LEFT|Turn RIGHT|Bear LEFT|Bear RIGHT|Start on)/i.test(
      String(step.maneuver || step.instruction || ""),
    );
    if (!isTurn) continue;
    const along = Math.min(cumMi, Math.max(distance_mi - 0.05, 0));
    const pt = pointAlongRoute(coordinates, along);
    pins.push({
      label: step.maneuver || `${miles} mi`,
      displayText: step.instruction,
      text: step.instruction,
      lng: pt.lng,
      lat: pt.lat,
      place: step.road || null,
      score: 100,
      weak: false,
      ok: true,
      source: "instruction-mile-on-route",
      stepIndex: i,
      road: step.road || null,
    });
  }

  pins.push({
    ...end,
    label: "End",
    displayText: parsed.destination_text || end.text,
    text: parsed.destination_text || "End",
  });

  let confidence = "high";
  if (expectedMi > 0) {
    const pctOff = Math.abs(1 - distance_mi / expectedMi) * 100;
    if (pctOff > 12) {
      confidence = "medium";
      warnings.push(
        `Permit ~${expectedMi.toFixed(1)} mi, mapped road path ~${distance_mi.toFixed(1)} mi (${pctOff.toFixed(0)}% off).`,
      );
    }
  }
  if (start.source !== "pdf-coords" || end.source !== "pdf-coords") {
    warnings.push("Start or end was not a printed [lat,lng] — used a state-line/geocode fallback.");
    if (confidence === "high") confidence = "medium";
  }

  const explanation = `Start → ${parsed.steps.length} instruction pins → End · ${distance_mi.toFixed(1)} mi road route`;

  return {
    coordinates,
    point_count: coordinates.length,
    pins,
    step_waypoints: parsed.steps.length,
    distance_mi,
    expected_miles: expectedMi,
    source: "permit-start-end + instruction miles",
    confidence,
    warnings,
    explanation,
    start: coordinates[0],
    end: coordinates[coordinates.length - 1],
  };
}

async function mapboxDrive(from, to, token) {
  const path = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const params = new URLSearchParams({
    access_token: token,
    geometries: "geojson",
    overview: "full",
  });
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${path}?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mapbox directions ${res.status}${body ? `: ${body.slice(0, 140)}` : ""}`);
  }
  const json = await res.json();
  const route = json.routes?.[0];
  const coordinates = route?.geometry?.coordinates;
  if (!coordinates?.length) throw new Error("Mapbox returned no route geometry.");
  return {
    coordinates,
    distance_mi: (route.distance || 0) / METERS_PER_MILE,
  };
}

/** Point `miles` from the start along a [lng,lat][] line. */
function pointAlongRoute(coords, miles) {
  const target = miles * METERS_PER_MILE;
  let traveled = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversineMeters(coords[i - 1], coords[i]);
    if (traveled + seg >= target) {
      const t = seg > 0 ? (target - traveled) / seg : 0;
      return {
        lng: coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        lat: coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      };
    }
    traveled += seg;
  }
  const last = coords[coords.length - 1];
  return { lng: last[0], lat: last[1] };
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
    proximity: previous?.lng != null ? `${previous.lng},${previous.lat}` : `${OKLAHOMA_CENTER[0]},${OKLAHOMA_CENTER[1]}`,
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
  const lat1 = toR(a[1]);
  const lat2 = toR(b[1]);
  const dLat = toR(b[1] - a[1]);
  const dLon = toR(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function endpointQueries() {
  return [];
}
