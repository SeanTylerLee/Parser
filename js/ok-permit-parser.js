/**
 * Parse Oklahoma ODOT / OkiePROS OS/OW permit PDF text.
 *
 * Handles real PDF quirks learned from Desktop/Permits samples:
 * - Wrapped "Starting From:" / split "Starting\\nFrom:"
 * - Optional [lat,lng] (some permits only have highway @ state line)
 * - "(Outbound)" suffixes, multi-page direction tables
 */

export const OK_PARSER_VERSION = "ok-directions-v3";

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

  // Look ahead far enough that [lat,lng] still counts even if "Starting State:"
  // sits between the label and the coordinates (common pdf.js line wrap).
  const window = flat.slice(m.index, m.index + m[0].length + 450);
  const coords = COORDS_RE.exec(window.slice(m[0].length));

  let rest = flat.slice(m.index + m[0].length).trim();
  const cut2 = rest.match(NEXT_FIELD_RE);
  let placeSource = cut2 ? rest.slice(0, cut2.index) : rest;
  if (coords) {
    // Prefer text before the bracket pair in the window
    const before = window.slice(m[0].length, m[0].length + coords.index);
    const cutInBefore = before.match(NEXT_FIELD_RE);
    placeSource = (cutInBefore ? before.slice(0, cutInBefore.index) : before) || placeSource;
  }

  let lat = null;
  let lng = null;
  if (coords) {
    const parsed = parseLatLng(coords[1], coords[2]);
    lat = parsed.lat;
    lng = parsed.lng;
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
    /\b(?:onto|on)\s+((?:I|IH|US|OK|SH)\s*-?\s*\d+[A-Z]?(?:\s*Alt(?:\s*[NS])?)?|[A-Za-z][A-Za-z0-9 .'-]{2,40}?)(?:\s*\(|\s+(?:NB|SB|EB|WB)\b|$)/i,
  );
  let road = null;
  if (roadMatch) road = normalizeRoad(roadMatch[1]);
  else {
    const fallback = ROAD_RE.exec(instruction);
    if (fallback) road = normalizeRoad(fallback[1]);
  }

  const compassMatch = COMPASS_RE.exec(instruction);
  let compass = compassMatch ? compassMatch[1].toUpperCase() : null;
  if (compass === "NORTH") compass = "NB";
  if (compass === "SOUTH") compass = "SB";
  if (compass === "EAST") compass = "EB";
  if (compass === "WEST") compass = "WB";

  return {
    leg_miles,
    instruction,
    maneuver,
    road,
    compass,
    label: maneuver || "Dir",
    displayText: instruction,
  };
}

function normalizeRoad(raw) {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  s = s.replace(/\s*\(.*$/, "").trim();
  s = s.replace(/^(STATE HIGHWAY|HIGHWAY)\s+/i, "OK-");
  s = s.replace(/^IH\s*-?\s*/i, "I-");
  s = s.replace(/^(I|US|OK|SH)\s+(\d+)/i, (_, p, n) => `${p.toUpperCase()}-${n}`);
  s = s.replace(/^(I|US|OK|SH)-(\d+)/i, (_, p, n) => `${p.toUpperCase()}-${n}`);
  if (/^(I|US|OK|SH)-\d+/i.test(s)) {
    const m = s.match(/^((?:I|US|OK|SH)-\d+[A-Z]?(?:\s*Alt(?:\s*[NS])?)?)/i);
    if (m) return m[1].replace(/\s+/g, " ").replace(/\s*Alt.*/i, "");
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
