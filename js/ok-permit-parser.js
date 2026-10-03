/**
 * Parse Oklahoma ODOT / OkiePROS OS/OW permit PDF text.
 *
 * Handles real PDF quirks learned from Desktop/Permits samples:
 * - Wrapped "Starting From:" / split "Starting\\nFrom:"
 * - Optional [lat,lng] (some permits only have highway @ state line)
 * - "(Outbound)" suffixes, multi-page direction tables
 */

export const OK_PARSER_VERSION = "oklahoma-directions";

const PERMIT_NO_RE = /Permit\s*Number:\s*(\d{10,})/i;
const APPROX_MI_RE = /Approximate\s*Mileage:\s*([\d.]+)\s*mi/i;
const STEP_RE = /^(\d+(?:\.\d+)?)\s*mi\s+(.+)$/i;
const COORDS_RE = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/;
const ROAD_RE =
  /\b((?:I|IH|US|OK|SH|STATE HIGHWAY|HIGHWAY)\s*-?\s*\d+[A-Z]?|(?:US|OK)\s*-?\s*\d+\s*Alt(?:\s*[NS])?)\b/i;
const COMPASS_RE = /\b(NB|SB|EB|WB|NORTH|SOUTH|EAST|WEST|N|S|E|W)\b/i;

const NEXT_FIELD_RE =
  /\s+(?:Starting\s*From|Going\s*To|Starting\s*State|Arrival\s*State|Starting\s*County|Arrival\s*County|Statewide\s*Travel|Trailer\s*Load|Permit\s*Restrictions|Permit\s*Number)\s*:/i;

export function parseOkPermitText(raw) {
  const original = String(raw || "").replace(/\r/g, "");
  if (!original.trim()) return emptyResult("No text to parse.");

  const flat = normalizeOkText(original);
  const origin = extractEndpoint(flat, "Starting From");
  const destination = extractEndpoint(flat, "Going To");
  const permit_number = (flat.match(PERMIT_NO_RE) || [])[1] || null;
  const approx = flat.match(APPROX_MI_RE);
  const approximate_miles = approx ? Number(approx[1]) : null;
  const steps = parseSteps(original);

  const errors = [];
  if (!origin?.text) errors.push("Missing Starting From.");
  if (!destination?.text) errors.push("Missing Going To.");
  if (!steps.length) errors.push("No driving-direction steps found.");

  const stepMiles = steps.reduce((s, st) => s + (Number(st.leg_miles) || 0), 0);
  const expected_miles = approximate_miles || (stepMiles > 0 ? stepMiles : null);

  return {
    state: "OK",
    parser_version: OK_PARSER_VERSION,
    permit_number,
    origin,
    destination,
    approximate_miles,
    expected_miles,
    steps,
    origin_text: origin?.text || null,
    destination_text: destination?.text || null,
    ok: Boolean(origin?.text && destination?.text && steps.length),
    errors,
  };
}

function emptyResult(msg) {
  return {
    state: "OK",
    parser_version: OK_PARSER_VERSION,
    permit_number: null,
    origin: null,
    destination: null,
    approximate_miles: null,
    expected_miles: null,
    steps: [],
    origin_text: null,
    destination_text: null,
    ok: false,
    errors: [msg],
  };
}

export function normalizeOkText(text) {
  let t = String(text || "").replace(/\r/g, "");
  t = t.replace(/Starting\s*\n\s*From\s*:/gi, "Starting From:");
  t = t.replace(/Going\s*\n\s*To\s*:/gi, "Going To:");
  t = t.replace(/Starting\s*From\s*:\s*\n\s*/gi, "Starting From: ");
  t = t.replace(/Going\s*To\s*:\s*\n\s*/gi, "Going To: ");
  t = t.replace(/[ \t\f\v]+/g, " ");
  t = t.replace(/\n+/g, "\n");
  return t;
}

function parseLatLng(a, b) {
  let lat = Number(a);
  let lng = Number(b);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { lat: null, lng: null };
  // Printed as [lng,lat] (lng is ~-97, lat is ~35)
  if (lat < -50 && lng > 20 && lng < 50) {
    const t = lat;
    lat = lng;
    lng = t;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { lat: null, lng: null };
  return { lat, lng };
}

function extractEndpoint(text, label) {
  const labelRe =
    label.toLowerCase() === "starting from" ? /Starting\s*From\s*:/i : /Going\s*To\s*:/i;

  const flat = text.replace(/\s+/g, " ");
  const m = labelRe.exec(flat);
  if (!m) return null;

  // Only read until the next labeled field. Never steal coords from a later
  // field (e.g. Going To must not pick up Starting From's [lat,lng]).
  let rest = flat.slice(m.index + m[0].length).trim();
  const cut2 = rest.match(NEXT_FIELD_RE);
  let placeSource = cut2 ? rest.slice(0, cut2.index) : rest.slice(0, 450);

  // Coords count only if they sit inside this field's own text.
  const coords = COORDS_RE.exec(placeSource);
  let lat = null;
  let lng = null;
  if (coords) {
    const parsed = parseLatLng(coords[1], coords[2]);
    lat = parsed.lat;
    lng = parsed.lng;
    placeSource = placeSource.slice(0, coords.index);
  }

  let placeText = String(placeSource || "")
    .replace(/\s+/g, " ")
    .replace(/\s*\((?:Outbound|Inbound)\)\s*$/i, "")
    .replace(/[,\s]+$/g, "")
    .trim();

  if (!placeText && lat == null) return null;

  return {
    text: placeText || (lat != null ? `${lat},${lng}` : ""),
    lat,
    lng,
    has_coords: lat != null && lng != null,
  };
}

function parseSteps(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const startIdx = lines.findIndex(
    (l) => /^Driving Directions/i.test(l) || /^Miles Instruction$/i.test(l),
  );
  const slice = startIdx >= 0 ? lines.slice(startIdx + 1) : lines;

  const steps = [];
  for (const line of slice) {
    if (/^Restrictions Violated/i.test(line)) break;
    if (steps.length && /^Permit Number:/i.test(line)) break;
    if (/^Approximate Mileage:/i.test(line)) continue;
    if (/^Miles Instruction$/i.test(line)) continue;
    if (/^Driving Directions/i.test(line)) continue;
    if (/^Page\s+\d+/i.test(line)) continue;

    const m = STEP_RE.exec(line);
    if (!m) continue;
    steps.push(annotateStep(Number(m[1]), m[2].trim()));
  }
  return steps;
}

function annotateStep(leg_miles, instruction) {
  let maneuver = null;
  const man =
    /^(Start on|Turn LEFT|Turn RIGHT|Bear LEFT|Bear RIGHT|Continue(?:\s+(?:NORTH|SOUTH|EAST|WEST))?\s+onto|Take exit|Merge)/i.exec(
      instruction,
    );
  if (man) {
    maneuver = /Continue/i.test(man[1]) ? "Continue onto" : man[1];
  } else if (/^\(Ramp\)$/i.test(instruction)) {
    maneuver = "Ramp";
  }

  const roadMatch = instruction.match(
    /\b(?:onto|on)\s+((?:I|IH|US|OK|SH)\s*-?\s*\d+[A-Z]?(?:\s*Alt(?:\s*[NS])?)?|[A-Za-z][A-Za-z0-9 .'-]{2,40}?)(?:\s*\(|\s+(?:NB|SB|EB|WB|[NSEW])\b|$)/i,
  );
  let road = null;
  if (roadMatch) road = normalizeRoad(roadMatch[1]);
  else {
    const fallback = ROAD_RE.exec(instruction);
    if (fallback) road = normalizeRoad(fallback[1]);
  }

  // Prefer direction attached to the highway: "I-40 W", "OK-6 NB", "US-81 SB".
  // Parentheticals like "(OK-34 S)" must NOT steal the travel direction.
  let compass = null;
  const hwyDir = instruction.match(
    /\b(?:I|IH|US|OK|SH)\s*-?\s*\d+[A-Z]?\s+(NB|SB|EB|WB|NORTH|SOUTH|EAST|WEST|[NSEW])\b/i,
  );
  if (hwyDir) compass = hwyDir[1].toUpperCase();
  else {
    const trail = instruction.match(/\b(NB|SB|EB|WB)\b/i);
    if (trail) compass = trail[1].toUpperCase();
  }
  if (!compass) {
    const lead = instruction.match(/\b(?:Continue|Turn|Bear)\s+(NORTH|SOUTH|EAST|WEST)\b/i);
    if (lead) compass = lead[1].toUpperCase();
  }
  // "Byp S" is a travel direction. "Rd E" / "St W" is part of the street name.
  if (!compass) {
    const tail = instruction.match(/\s([NSEW])\s*$/);
    const streetSuffix =
      /\b(?:RD|ST|AVE|DR|LN|BLVD|HWY|ROAD|STREET|AVENUE|DRIVE|LANE|CT|CIR|PL|PKWY)\s+[NSEW]\s*$/i.test(
        instruction,
      );
    if (tail && !streetSuffix) compass = tail[1].toUpperCase();
  }
  if (compass === "N" || compass === "NORTH") compass = "NB";
  if (compass === "S" || compass === "SOUTH") compass = "SB";
  if (compass === "E" || compass === "EAST") compass = "EB";
  if (compass === "W" || compass === "WEST") compass = "WB";

  const aliases = extractAliases(instruction, road);

  return {
    leg_miles,
    instruction,
    maneuver,
    road,
    aliases,
    compass,
    label: maneuver || "Dir",
    displayText: instruction,
  };
}

function extractAliases(instruction, primary) {
  const aliases = [];
  const seen = new Set();
  const add = (name) => {
    const cleaned = cleanAlias(name);
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (primary && key === primary.toLowerCase()) return;
    if (seen.has(key)) return;
    seen.add(key);
    aliases.push(cleaned);
  };
  for (const match of String(instruction || "").matchAll(/\(([^)]+)\)/g)) {
    const inner = match[1];
    if (/contact local|unknown road|^\s*ramp\s*$/i.test(inner)) continue;
    for (const part of inner.split(",")) add(part);
  }
  return aliases;
}

function cleanAlias(raw) {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s || /contact local|unknown road|^ramp$/i.test(s)) return null;
  if (/^(NB|SB|EB|WB|NORTH|SOUTH|EAST|WEST)$/i.test(s)) return null;
  const us = s.match(/^US\s+Highway\s+(\d+)/i);
  if (us) return `US-${us[1]}`;
  const stateHwy = s.match(/^State\s+Highway\s+(\d+)/i);
  if (stateHwy) return `OK-${stateHwy[1]}`;
  // "S Highway 6" / "Highway 64 N" repeat the numbered route. Not a street.
  if (/^[NSEW]\s+Highway\s+\d+/i.test(s) || /^Highway\s+\d+/i.test(s)) return null;
  if (/^(I|IH|US|OK|SH)\s*-?\s*\d+/i.test(s)) return normalizeRoad(s);
  if (!/[A-Za-z]/.test(s) || s.length < 3) return null;
  return s.replace(/\s+(NB|SB|EB|WB)$/i, "").trim();
}

function normalizeRoad(raw) {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  s = s.replace(/\s*\(.*$/, "").trim();
  s = s.replace(/^(STATE HIGHWAY|HIGHWAY)\s+/i, "OK-");
  s = s.replace(/^IH\s*-?\s*/i, "I-");
  s = s.replace(/^(I|US|OK|SH)\s+(\d+)/i, (_, p, n) => `${p.toUpperCase()}-${n}`);
  s = s.replace(/^(I|US|OK|SH)-(\d+)/i, (_, p, n) => `${p.toUpperCase()}-${n}`);
  s = s.replace(/\s+(NB|SB|EB|WB|[NSEW])$/i, "").trim();
  if (/^(I|US|OK|SH)-\d+/i.test(s)) {
    const m = s.match(/^((?:I|US|OK|SH)-\d+[A-Z]?)/i);
    if (m) {
      const base = m[1].replace(/^(I|US|OK|SH)-(\d+)/i, (_, p, n) => `${p.toUpperCase()}-${n}`);
      return /\bAlt\b/i.test(s) ? `${base} Alt` : base;
    }
  }
  return s;
}

export function looksLikeOkPermit(text) {
  const t = String(text || "");
  return (
    /Oklahoma Department Of Transportation/i.test(t) ||
    (/Driving Directions:/i.test(t) && /Starting\s*From/i.test(t) && /Going\s*To/i.test(t)) ||
    (/OkiePROS/i.test(t) && /Permit Number:/i.test(t))
  );
}
