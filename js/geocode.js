/**
 * Geocode permit junctions with Mapbox.
 *
 * The last attempt failed when a whole highway (e.g. "IH 35 Texas") geocoded to
 * one arbitrary point. This layer scores candidates by whether BOTH road numbers
 * from a crossing appear in the result, and biases later pins toward the previous one.
 */

export const TEXAS_BBOX = [-106.645646, 25.837377, -93.508039, 36.500704];
export const TEXAS_CENTER = [-99.2, 31.3];

const GEOCODE_LIMIT = 3;
const MAX_QUERIES_PER_PIN = 3;

export async function geocodeSegments(segments, token, { onPin, originText, destinationText } = {}) {
  const enriched = enrichQueriesWithCorridorHints(segments, originText, destinationText);

  // Pass 1: geocode every pin in parallel (no proximity) — much faster.
  const rough = await Promise.all(
    enriched.map((seg, i) => geocodeSegment(seg, token, null, i, {})),
  );

  // Pass 2: only re-hit weak short-leg pins with proximity from the previous good pin.
  const pins = [...rough];
  for (let i = 1; i < pins.length; i++) {
    const prevSeg = enriched[i - 1];
    const seg = enriched[i];
    const expectedMi = expectedLegMiles(prevSeg, seg);
    const prevPin = pins[i - 1];
    if (
      pins[i].weak &&
      prevPin?.lng != null &&
      expectedMi != null &&
      expectedMi < 35
    ) {
      pins[i] = await geocodeSegment(seg, token, [prevPin.lng, prevPin.lat], i, {
        previous: prevPin,
        expectedMi,
      });
    } else if (prevPin?.lng != null && pins[i].lng != null && expectedMi != null) {
      // Re-score distance consistency without another network call when possible.
      const bonus = distanceConsistencyBonus(prevPin, pins[i], expectedMi);
      pins[i] = {
        ...pins[i],
        score: pins[i].score + bonus,
        weak: pins[i].score + bonus < 55,
      };
    }
    if (onPin) onPin(pins[i], i, pins.length);
  }
  return pins;
}

/** Pull Houston / Dallas / county words from origin & destination into nearby pin queries. */
function enrichQueriesWithCorridorHints(segments, originText, destinationText) {
  const originHints = placeHintsFromText(
    [originText, segments[0]?.displayText, segments[0]?.text].filter(Boolean).join(" · "),
  );
  const destHints = placeHintsFromText(
    [
      destinationText,
      segments[segments.length - 1]?.displayText,
      segments[segments.length - 1]?.text,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  return segments.map((seg, i) => {
    const t = segments.length <= 1 ? 0 : i / (segments.length - 1);
    const hints = t <= 0.45 ? originHints : destHints;
    const hint = hints[0];
    const extra = [];
    if (seg.roads && seg.roads.length >= 2) {
      const [a, b] = seg.roads;
      extra.push(`${a} and ${b} intersection Texas`);
      extra.push(`${spokenRoad(a)} and ${spokenRoad(b)} Texas`);
      if (hint) extra.push(`${spokenRoad(a)} and ${spokenRoad(b)} ${hint} Texas`);
    } else if (seg.queries?.[0]) {
      extra.push(seg.queries[0]);
      if (hint) extra.push(`${seg.queries[0]} ${hint}`);
    }
    return {
      ...seg,
      queries: dedupe([...extra, ...(seg.queries || [])]).slice(0, MAX_QUERIES_PER_PIN),
    };
  });
}

function placeHintsFromText(text) {
  const hints = [];
  const t = String(text || "");
  const cities = [
    "Houston",
    "Dallas",
    "Fort Worth",
    "Austin",
    "San Antonio",
    "El Paso",
    "Midland",
    "Odessa",
    "Lubbock",
    "Amarillo",
    "Beaumont",
    "Waco",
    "Tyler",
    "Laredo",
    "Corpus Christi",
    "Decatur",
  ];
  for (const c of cities) {
    if (new RegExp(`\\b${c}\\b`, "i").test(t)) hints.push(c);
  }
  const county = t.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+County\b/);
  if (county) hints.push(`${county[1]} County`);
  return dedupe(hints);
}

function spokenRoad(road) {
  const s = String(road || "");
  let m;
  if ((m = /^IH\s+(\d+)/i.exec(s))) return `Interstate ${m[1]}`;
  if ((m = /^US\s+(\d+)/i.exec(s))) return `US Highway ${m[1]}`;
  if ((m = /^SH\s+(\d+)/i.exec(s))) return `State Highway ${m[1]}`;
  if ((m = /^FM\s+(\d+)/i.exec(s))) return `Farm to Market Road ${m[1]}`;
  if ((m = /^RM\s+(\d+)/i.exec(s))) return `Ranch Road ${m[1]}`;
  if ((m = /^SL\s+(\d+)/i.exec(s))) return `Loop ${m[1]}`;
  if ((m = /^BU\s+(\d+)/i.exec(s))) return `Business US ${m[1]}`;
  return s;
}

function expectedLegMiles(prevSeg, seg) {
  if (!prevSeg) return null;
  if (
    seg.cumulative_permit_mi != null &&
    prevSeg.cumulative_permit_mi != null &&
    Number.isFinite(seg.cumulative_permit_mi) &&
    Number.isFinite(prevSeg.cumulative_permit_mi)
  ) {
    return Math.abs(seg.cumulative_permit_mi - prevSeg.cumulative_permit_mi);
  }
  if (prevSeg.leg_miles_to_next != null && Number.isFinite(prevSeg.leg_miles_to_next)) {
    return prevSeg.leg_miles_to_next;
  }
  return null;
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const v = String(x || "").replace(/\s+/g, " ").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export async function geocodeSegment(seg, token, proximity, index, opts = {}) {
  const queries = dedupe(
    (seg.queries && seg.queries.length ? seg.queries : [seg.text]).filter(Boolean),
  ).slice(0, MAX_QUERIES_PER_PIN);

  // Fire the short query list in parallel instead of one-by-one.
  const batches = await Promise.all(
    queries.map(async (query) => {
      const features = await mapboxGeocode(query, token, proximity);
      return features.map((feature) => {
        const lng = feature.center?.[0];
        const lat = feature.center?.[1];
        let score = scoreFeature(feature, seg);
        if (opts.previous && lng != null && lat != null && opts.expectedMi != null) {
          score += distanceConsistencyBonus(opts.previous, { lng, lat }, opts.expectedMi);
        }
        return {
          query,
          feature,
          score,
          place: feature.place_name || feature.text || query,
          lng,
          lat,
        };
      });
    }),
  );

  const tried = batches.flat();
  let best = null;
  for (const scored of tried) {
    if (!best || scored.score > best.score) best = scored;
  }

  return {
    index,
    label: seg.label || "Point",
    text: seg.text,
    displayText: seg.displayText || seg.text,
    roads: seg.roads || [],
    dirHint: seg.dir_hint || null,
    cumulative_permit_mi: seg.cumulative_permit_mi ?? null,
    leg_miles_to_next: seg.leg_miles_to_next ?? null,
    lng: best?.lng ?? null,
    lat: best?.lat ?? null,
    place: best?.place || null,
    query: best?.query || queries[0] || seg.text,
    score: best?.score ?? 0,
    alternatives: tried
      .filter((t) => t !== best && t.lng != null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3),
    ok: best?.lng != null && (best.score >= 35 || queries.length === 1),
    weak: !best || best.score < 55,
  };
}

function distanceConsistencyBonus(prev, next, expectedMi) {
  const miles = haversineMiles(prev.lat, prev.lng, next.lat, next.lng);
  if (!Number.isFinite(miles) || !Number.isFinite(expectedMi) || expectedMi <= 0) return 0;
  const ratio = miles / expectedMi;
  if (ratio >= 0.55 && ratio <= 1.6) return 25;
  if (ratio >= 0.35 && ratio <= 2.2) return 8;
  if (miles < expectedMi * 0.15 && expectedMi > 40) return -50;
  if (ratio > 3 || ratio < 0.2) return -30;
  return 0;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function mapboxGeocode(query, token, proximity) {
  const params = new URLSearchParams({
    access_token: token,
    country: "US",
    bbox: TEXAS_BBOX.join(","),
    limit: String(GEOCODE_LIMIT),
    autocomplete: "false",
  });
  if (proximity) params.set("proximity", `${proximity[0]},${proximity[1]}`);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mapbox geocode ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
  }
  const json = await res.json();
  return Array.isArray(json.features) ? json.features : [];
}

function roadNumbers(seg) {
  const nums = new Set();
  const add = (s) => {
    if (!s) return;
    for (const m of String(s).matchAll(/\b(?:IH|I|US|SH|FM|RM|SL|BU|BI|SS|SP|CR|LOOP|TX)\s*[-–]?\s*(\d{1,4})/gi)) {
      nums.add(m[1].replace(/^0+/, "") || m[1]);
    }
    for (const m of String(s).matchAll(/\b(\d{1,4})\b/g)) {
      if (m[1].length >= 1) nums.add(m[1].replace(/^0+/, "") || m[1]);
    }
  };
  (seg.roads || []).forEach(add);
  add(seg.text);
  return [...nums];
}

function scoreFeature(feature, seg) {
  const name = `${feature.place_name || ""} ${feature.text || ""}`.toLowerCase();
  const ctx = (feature.context || []).map((c) => (c.text || "").toLowerCase());
  const inTexas = name.includes("texas") || name.includes(" tx") || ctx.some((c) => c === "texas" || c === "tx");
  let score = (feature.relevance || 0) * 40;
  if (inTexas) score += 12;
  else score -= 25;

  const nums = roadNumbers(seg);
  let hits = 0;
  for (const n of nums) {
    const re = new RegExp(`(?:^|\\D)${n}(?:\\D|$)`);
    if (re.test(name)) hits += 1;
  }
  if (nums.length >= 2) {
    if (hits >= 2) score += 55;
    else if (hits === 1) score -= 10;
    else score -= 35;
  } else if (nums.length === 1 && hits >= 1) {
    score += 18;
  }

  if (/\b(junction|interchange|&| and )\b/i.test(name)) score += 10;
  // Street addresses like "Avenue S" are usually wrong for highway×highway pins.
  if ((feature.place_type || []).includes("address") && nums.length >= 2 && hits < 2) score -= 20;
  if ((feature.place_type || []).includes("address")) score += 2;
  return score;
}

const MAX_WAYPOINTS = 24;

export async function fetchPermitRoute(pins, token) {
  const coords = pins.filter((p) => p.lng != null && p.lat != null);
  if (coords.length < 2) {
    throw new Error("Need at least two geocoded points to draw a route.");
  }

  const pieces = [];
  for (let i = 0; i < coords.length - 1; i += MAX_WAYPOINTS - 1) {
    const slice = coords.slice(i, Math.min(i + MAX_WAYPOINTS, coords.length));
    if (slice.length < 2) break;
    pieces.push(await fetchDirectionsChunk(slice, token));
  }

  const coordinates = [];
  let distanceM = 0;
  let durationS = 0;
  for (const piece of pieces) {
    const geom = piece.geometry?.coordinates || [];
    if (!geom.length) continue;
    if (coordinates.length) geom.shift();
    coordinates.push(...geom);
    distanceM += piece.distance || 0;
    durationS += piece.duration || 0;
  }

  return {
    type: "Feature",
    properties: {
      distance_mi: distanceM / 1609.344,
      duration_min: durationS / 60,
    },
    geometry: { type: "LineString", coordinates },
  };
}

async function fetchDirectionsChunk(pins, token) {
  const path = pins.map((p) => `${p.lng},${p.lat}`).join(";");
  const params = new URLSearchParams({
    access_token: token,
    geometries: "geojson",
    overview: "full",
    steps: "false",
    continue_straight: "true",
  });
  let url = `https://api.mapbox.com/directions/v5/mapbox/driving/${path}?${params}`;
  let res = await fetch(url);
  if (!res.ok) {
    params.delete("continue_straight");
    url = `https://api.mapbox.com/directions/v5/mapbox/driving/${path}?${params}`;
    res = await fetch(url);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mapbox directions ${res.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
  }
  const json = await res.json();
  const route = json.routes && json.routes[0];
  if (!route) throw new Error("Mapbox returned no driving route for these pins.");
  return route;
}
