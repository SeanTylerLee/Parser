/**
 * Oklahoma route builder — follow the permit Driving Directions literally.
 *
 * Any Oklahoma permit: each Driving Directions line is miles plus a road.
 * Walk that road for those miles. A step is wrong only when both the
 * miles and the road name miss. Mapbox is only used for a short exit hop.
 */

const OKLAHOMA_BBOX = [-103.002455, 33.615833, -94.430662, 37.002312];
const OKLAHOMA_CENTER = [-97.5, 35.5];

const OK_LRS_QUERY =
  "https://services6.arcgis.com/RBtoEUQ2lmN0K3GY/arcgis/rest/services/OKRoads_LRS/FeatureServer/0/query";
const OK_LOCAL_QUERY =
  "https://services6.arcgis.com/RBtoEUQ2lmN0K3GY/arcgis/rest/services/Local_Roadways/FeatureServer/0/query";

const METERS_PER_MILE = 1609.344;
const THIN_MILES = 0.02;

const BORDER_HINTS = [
  { re: /\bI-?40\b.*\b(TX|TEXAS)\b/i, lng: -100.0003, lat: 35.2271, label: "I-40 @ TX line" },
  { re: /\bUS-?183\b.*\b(TX|TEXAS)\b/i, lng: -99.081751, lat: 34.211226, label: "US-183 @ TX line" },
  { re: /\bUS-?81\b.*\b(TX|TEXAS)\b/i, lng: -97.93377, lat: 33.879015, label: "US-81 @ TX / Terral" },
  { re: /\bUS-?83\b.*\b(TX|TEXAS)\b/i, lng: -100.806, lat: 36.5, label: "US-83 @ TX panhandle" },
  { re: /\bUS-?60\b.*\b(TX|TEXAS)\b/i, lng: -100.001, lat: 36.131, label: "US-60 @ TX (Higgins)" },
  { re: /\bOK-?34\b.*\b(KS|KANSAS)\b/i, lng: -99.313, lat: 37.0, label: "OK-34 @ KS line" },
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

  // Highways from the step name and parenthetical aliases (US-270 (US-83)).
  const codes = [];
  const localNames = [];
  const addLocal = (name) => {
    if (!name || toOdotRoute(name)) return;
    if (!localNames.some((n) => n.toLowerCase() === name.toLowerCase())) localNames.push(name);
  };
  for (const step of parsed.steps) {
    const names = stepNames(step);
    for (const name of names) {
      const code = toOdotRoute(name);
      if (code && !codes.includes(code)) codes.push(code);
    }
    // Street geometry is only needed when the step's own road is not a highway.
    if (names[0] && !toOdotRoute(names[0])) {
      for (const name of names) addLocal(name);
    }
  }
  if (!codes.length && !localNames.length) {
    throw new Error("No road names found in Driving Directions.");
  }

  const origin = { lng: start.lng, lat: start.lat };
  const dest = { lng: end.lng, lat: end.lat };
  // Long OK routes jog outside the start/end box — keep enough LRS pad.
  const pad = Math.max(0.8, (expectedMi || 40) * 0.02);
  const bbox = [
    Math.min(origin.lng, dest.lng) - pad,
    Math.min(origin.lat, dest.lat) - pad,
    Math.max(origin.lng, dest.lng) + pad,
    Math.max(origin.lat, dest.lat) + pad,
  ];

  let lrs = { routes: {} };
  if (codes.length) {
    say(`Loading ODOT highways for steps (${codes.join(", ")})…`);
    lrs = await fetchOkLrs(codes, bbox, baseUrl);
  }

  say("Following permit directions step by step…");
  let pos = origin;
  const coordinates = [[pos.lng, pos.lat]];
  let lastRoad = null;
  let lastCompass = null;
  let heading = null;
  const stepChecks = [];

  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    const miles = Number(step.leg_miles) || 0;
    const instr = String(step.instruction || "");
    const names = stepNames(step);
    const isExit = /^Take exit/i.test(instr) || /^Merge/i.test(instr) || /^\(Ramp\)$/i.test(instr);
    const markAt = coordinates.length;

    const prevRoadCode = lastRoad ? toOdotRoute(lastRoad) : null;
    const road = step.road || (isExit ? null : lastRoad);
    const compass = step.compass || lastCompass;
    const label = names[0] || road || "exit";
    const stepCodes = names.map((n) => toOdotRoute(n)).filter(Boolean);
    // Concurrent routes: "OK-152 (US-81)" — keep walking the highway we are already on.
    const continueCode = prevRoadCode && stepCodes.includes(prevRoadCode) ? prevRoadCode : null;
    const thisCode = continueCode || stepCodes[0] || (road ? toOdotRoute(road) : null);
    const sameHwy = Boolean(continueCode || (prevRoadCode && thisCode && prevRoadCode === thisCode));

    say(`Step ${i + 1}/${parsed.steps.length}: ${miles} mi ${label} ${compass || ""}`.trim());

    let usedRoad = null;
    let roadOk = names.length ? false : null;
    let measured = null;

    const leg = legCourse(step, heading, parsed.steps[i + 1]);
    const travel = leg.compass;
    // An exit has no road name. It runs toward the direction of the next line.
    const nextLeg = isExit ? legCourse(parsed.steps[i + 1] || {}, leg.bearing, null) : null;
    const legHeading = isExit && nextLeg?.bearing != null ? nextLeg.bearing : leg.bearing;

    const driven = await driveLeg({
      pos,
      miles,
      heading: legHeading,
      names: isExit ? [] : names,
      lrs,
      preferNamed: !isExit && names.length > 0,
    });
    if (driven.coords.length) {
      appendCoords(coordinates, driven.coords);
      pos = driven.end;
      usedRoad = driven.roadName || names[0] || null;
      roadOk = names.length ? Boolean(driven.roadName) : null;
      measured = driven.walkedMiles;
      if (driven.roadName) lastRoad = names[0] || driven.roadName;
      if (travel) lastCompass = travel;
    } else {
      measured = 0;
      roadOk = names.length ? false : null;
    }

    const added = coordinates.slice(Math.max(0, markAt - 1));
    const walkedMi = measured != null ? measured : pathMiles(added);
    const milesOk = milesClose(miles, walkedMi);
    const bothFail = Boolean(names.length) && milesOk === false && walkedMi < 0.02;
    if (bothFail) roadOk = false;
    stepChecks.push({
      index: i,
      miles,
      walked_mi: walkedMi,
      road: names[0] || "",
      used_road: usedRoad,
      miles_ok: milesOk,
      road_ok: roadOk,
      both_fail: bothFail,
      lat: pos.lat,
      lng: pos.lng,
    });
    if (bothFail) {
      warnings.push(
        `Step ${i + 1} is not drawn: ${miles} mi${names[0] ? ` ${names[0]}` : ""} drew ${walkedMi.toFixed(1)} mi.`,
      );
    } else if (!milesOk && walkedMi >= 0.02) {
      warnings.push(
        `Step ${i + 1} drew ${walkedMi.toFixed(1)} mi instead of ${miles}${usedRoad ? ` on ${usedRoad}` : ""}.`,
      );
    }

    if (leg.bearing != null) heading = ((leg.bearing % 360) + 360) % 360;
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

  const bothFails = stepChecks.filter((c) => c.both_fail);
  const mileFails = stepChecks.filter((c) => !c.both_fail && c.miles_ok === false);
  let pctOff = 0;
  if (expectedMi > 0) {
    pctOff = Math.abs(1 - distance_mi / expectedMi) * 100;
    if (pctOff > 15) {
      warnings.push(
        `Permit ~${expectedMi.toFixed(1)} mi, drawn ~${distance_mi.toFixed(1)} mi (${pctOff.toFixed(0)}% off).`,
      );
    }
  }

  let confidence = "high";
  if (bothFails.length) confidence = "low";
  else if (mileFails.length || pctOff > 15) confidence = "medium";

  const badCount = bothFails.length;
  const explanation = badCount
    ? `${badCount} step${badCount === 1 ? "" : "s"} did not draw the stated miles`
    : `Checked ${stepChecks.length} direction steps · ${distance_mi.toFixed(1)} mi`;

  return {
    coordinates: thin,
    point_count: thin.length,
    pins,
    step_waypoints: 0,
    distance_mi,
    expected_miles: expectedMi,
    source: "permit-directions",
    confidence,
    warnings,
    step_checks: stepChecks,
    explanation,
    start: thin[0],
    end: thin[thin.length - 1],
  };
}

function stepNames(step) {
  const out = [];
  const add = (name) => {
    const s = String(name || "").trim();
    if (!s || /unknown road/i.test(s)) return;
    if (out.some((n) => n.toLowerCase() === s.toLowerCase())) return;
    out.push(s);
  };
  add(step?.road);
  for (const alias of step?.aliases || []) add(alias);
  return out;
}

function milesClose(stated, walked) {
  const s = Number(stated) || 0;
  const w = Number(walked) || 0;
  if (s <= 0) return w <= 0.2;
  // A leg that was not drawn is not a mileage match, even when the leg is short.
  if (s >= 0.1 && w < 0.02) return false;
  const tol = Math.max(0.2, s * 0.12);
  return Math.abs(w - s) <= tol;
}

const STREET_TYPES = new Set(["rd", "st", "ave", "blvd", "dr", "ln", "hwy", "byp", "cir", "pkwy", "trl", "pl", "ct", "road", "street"]);
const STREET_DIRS = {
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  northeast: "ne",
  northwest: "nw",
  southeast: "se",
  southwest: "sw",
};
const STREET_TYPE_NORM = {
  road: "rd",
  street: "st",
  avenue: "ave",
  boulevard: "blvd",
  drive: "dr",
  lane: "ln",
  highway: "hwy",
  bypass: "byp",
  circle: "cir",
  parkway: "pkwy",
  trail: "trl",
  place: "pl",
  court: "ct",
};
const STREET_ORDS = {
  first: "1st",
  second: "2nd",
  third: "3rd",
  fourth: "4th",
  fifth: "5th",
  sixth: "6th",
  seventh: "7th",
  eighth: "8th",
  ninth: "9th",
  tenth: "10th",
};

function streetTokens(name) {
  const raw = String(name || "")
    .toLowerCase()
    .replace(/\./g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!raw) return [];
  return raw.split(/\s+/).map((w) => STREET_ORDS[w] || STREET_DIRS[w] || STREET_TYPE_NORM[w] || w);
}

function compactRoad(name) {
  let s = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(ROAD|STREET|AVENUE|DRIVE|LANE|BOULEVARD|HIGHWAY|HWY|RD|ST|AVE|DR|LN|BLVD)\b/g, " ")
    .replace(/\bBYPASS\b/g, "BYP")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/\b(NORTHWEST|NORTHEAST|SOUTHWEST|SOUTHEAST|NORTH|SOUTH|EAST|WEST)\b/g, (w) => {
    return { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", NORTHWEST: "NW", NORTHEAST: "NE", SOUTHWEST: "SW", SOUTHEAST: "SE" }[w];
  });
  s = s.replace(/\b([NSEW])\s+(\d+)\b/g, "$1$2");
  return s.replace(/\s+/g, " ").trim();
}

function directionToken(name) {
  const s = ` ${String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()} `;
  const m = s.match(/ (NORTHWEST|NORTHEAST|SOUTHWEST|SOUTHEAST|NORTH|SOUTH|EAST|WEST|NW|NE|SW|SE|N|S|E|W) /);
  if (!m) return "";
  return (
    {
      NORTH: "N",
      SOUTH: "S",
      EAST: "E",
      WEST: "W",
      NORTHWEST: "NW",
      NORTHEAST: "NE",
      SOUTHWEST: "SW",
      SOUTHEAST: "SE",
    }[m[1]] || m[1]
  );
}

/** "S Red Rock" is not "North Red Rock". A direction word in the permit name has to agree. */
function nameDirectionConflicts(permitNames, street) {
  // Only the road named after "onto", not a grid alias like "N 2730 Rd".
  const want = directionToken(permitNames?.[0]);
  const got = directionToken(street);
  if (!want || !got) return false;
  return want !== got;
}

function streetNamesMatch(a, b) {
  const ca = compactRoad(a).replace(/\s+/g, "");
  const cb = compactRoad(b).replace(/\s+/g, "");
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const core = (s) => s.replace(/^(NW|NE|SW|SE|N|S|E|W)/, "").replace(/(NW|NE|SW|SE|N|S|E|W)$/, "");
  const ka = core(ca);
  const kb = core(cb);
  if (!ka || ka !== kb) return false;
  if (/\d/.test(ka)) return ca === cb;
  return true;
}

function learnHighwayAliases(steps) {
  const map = new Map();
  for (const step of steps || []) {
    const names = stepNames(step);
    const codeName = names.find((n) => toOdotRoute(n));
    const code = codeName ? toOdotRoute(codeName) : null;
    if (!code) continue;
    for (const name of names) {
      if (toOdotRoute(name)) continue;
      const key = compactRoad(name);
      if (key && !map.has(key)) map.set(key, { code, name: codeName });
    }
  }
  return map;
}

function bearingDeg(a, b) {
  const aa = Array.isArray(a) ? { lng: a[0], lat: a[1] } : a;
  const bb = Array.isArray(b) ? { lng: b[0], lat: b[1] } : b;
  const lat1 = (aa.lat * Math.PI) / 180;
  const lat2 = (bb.lat * Math.PI) / 180;
  const dLng = ((bb.lng - aa.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Miles and the turn in this direction decide the way to drive. */
function legCourse(step, incoming, nextStep) {
  if (step?.compass) {
    return { compass: step.compass, bearing: desiredBearing(null, null, step.compass) };
  }
  const man = `${step?.maneuver || ""} ${step?.instruction || ""}`;
  if (incoming != null) {
    let bearing = incoming;
    if (/Turn LEFT/i.test(man)) bearing = incoming - 90;
    else if (/Turn RIGHT/i.test(man)) bearing = incoming + 90;
    else if (/Bear LEFT/i.test(man)) bearing = incoming - 40;
    else if (/Bear RIGHT/i.test(man)) bearing = incoming + 40;
    return { compass: compassFromBearing(bearing), bearing };
  }
  const inferred = compassFromNextTurn(nextStep);
  if (inferred) return { compass: inferred, bearing: desiredBearing(null, null, inferred) };
  return { compass: null, bearing: null };
}

function compassFromBearing(bearing) {
  if (bearing == null || Number.isNaN(bearing)) return null;
  const n = ((bearing % 360) + 360) % 360;
  if (n >= 315 || n < 45) return "NB";
  if (n < 135) return "EB";
  if (n < 225) return "SB";
  return "WB";
}

/** The road we are on now, read from the next turn. Right onto SB means we are heading east. */
function compassFromNextTurn(nextStep) {
  if (!nextStep?.compass) return null;
  const after = { NB: 0, EB: 90, SB: 180, WB: 270 }[nextStep.compass];
  if (after == null) return null;
  const man = String(nextStep.maneuver || "");
  if (/Turn LEFT|Bear LEFT/i.test(man)) return compassFromBearing(after + 90);
  if (/Turn RIGHT|Bear RIGHT/i.test(man)) return compassFromBearing(after - 90);
  if (/Continue/i.test(man)) return nextStep.compass;
  return null;
}

function desiredBearing(incoming, maneuver, compass) {
  if (compass === "NB") return 0;
  if (compass === "EB") return 90;
  if (compass === "SB") return 180;
  if (compass === "WB") return 270;
  if (incoming == null || Number.isNaN(incoming)) return null;
  const man = String(maneuver || "");
  if (/Turn LEFT/i.test(man)) return incoming - 90;
  if (/Turn RIGHT/i.test(man)) return incoming + 90;
  if (/Bear LEFT/i.test(man)) return incoming - 40;
  if (/Bear RIGHT/i.test(man)) return incoming + 40;
  return incoming;
}

function moveByHeading(from, bearing, miles) {
  if (bearing == null || Number.isNaN(bearing) || !(miles > 0)) return null;
  const rad = (bearing * Math.PI) / 180;
  const lat = from.lat + (miles / 69) * Math.cos(rad);
  const lng = from.lng + (miles / (Math.cos((from.lat * Math.PI) / 180) * 69)) * Math.sin(rad);
  return { lng, lat };
}

function nearestDistMiles(lines, from) {
  const hit = nearestOnLines(lines, from);
  return hit ? haversineMiles(from, hit) : Infinity;
}

function pickHighway(names, lrs, pos, maxSnapMi, preferCode = null) {
  let best = null;
  const primary = names[0] ? toOdotRoute(names[0]) : null;
  // Prefer the highway we are already on when the permit lists it as concurrent.
  if (preferCode) {
    for (const name of names) {
      if (toOdotRoute(name) !== preferCode) continue;
      const lines = lrs.routes?.[preferCode] || [];
      if (!lines.length) break;
      const snap = nearestDistMiles(lines, pos);
      if (snap <= Math.max(maxSnapMi, 3)) return { code: preferCode, name, lines, snap };
      break;
    }
  }
  for (const name of names) {
    const code = toOdotRoute(name);
    if (!code) continue;
    const lines = lrs.routes?.[code] || [];
    if (!lines.length) continue;
    const snap = nearestDistMiles(lines, pos);
    const candidate = { code, name, lines, snap };
    if (primary && code === primary && snap <= maxSnapMi && !preferCode) return candidate;
    if (!best || snap < best.snap) best = candidate;
  }
  return best && best.snap <= maxSnapMi ? best : null;
}

/** Walk the nearest state centerline at this junction. Permit name may differ. */
function walkNearestHighway(lrs, pos, compass, miles, dest, maxSnapMi) {
  let best = null;
  for (const [code, lines] of Object.entries(lrs.routes || {})) {
    if (!lines?.length) continue;
    const snap = nearestDistMiles(lines, pos);
    if (snap > maxSnapMi) continue;
    if (!best || snap < best.snap) best = { code, name: code, lines, snap };
  }
  if (!best) return null;
  const walked = walkHighway(best.lines, pos, compass, miles, dest, { maxSnapMi });
  if (!walked?.coords?.length) return null;
  return { ...walked, name: best.name, code: best.code };
}

function nearestNamedPoint(ways, from) {
  let best = null;
  for (const way of ways) {
    for (const p of way.coords || []) {
      const d = haversineMiles(from, p);
      if (!best || d < best.d) best = { d, p };
    }
  }
  return best ? xy(best.p) : null;
}

function walkNamedWays(ways, from, miles, desired, dest, nextLines, maxSnapMi = 2.2) {
  if (!ways?.length) return null;
  const starts = [];
  for (const way of ways) {
    let nearest = null;
    for (let i = 0; i < (way.coords || []).length; i++) {
      const d = haversineMiles(from, way.coords[i]);
      if (!nearest || d < nearest.d) nearest = { way, i, d };
    }
    if (nearest && nearest.d <= maxSnapMi) starts.push(nearest);
  }
  starts.sort((a, b) => a.d - b.d);
  if (!starts.length) return null;

  const target = Math.max(miles, 0.05) * METERS_PER_MILE;
  let start = starts[0];
  function trace(startDir) {
    let current = start.way.coords;
    let i = start.i;
    let dir = startDir;
    const out = [xy(current[i])];
    let traveled = 0;
    const used = new Set([start.way]);
    while (traveled < target) {
      const next = i + dir;
      if (next >= 0 && next < current.length) {
        const seg = haversineMeters(current[i], current[next]);
        // Stay on the permit compass. Same-name pieces often loop; skip reverse edges.
        if (desired != null && seg > 8 && angleDiff(bearingDeg(current[i], current[next]), desired) > 120) {
          // Fall through to a forward join instead of walking backward.
        } else {
          if (traveled + seg >= target && seg > 0) {
            const t = (target - traveled) / seg;
            const a = current[i];
            const b = current[next];
            out.push({ lng: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t });
            traveled = target;
            break;
          }
          traveled += seg;
          out.push(xy(current[next]));
          i = next;
          continue;
        }
      }
      const tip = current[i];
      let jump = null;
      for (const other of ways) {
        if (used.has(other)) continue;
        if (!streetNamesMatch(other.name, start.way.name) && !streetNamesMatch(other.matched, start.way.matched)) continue;
        for (const end of [0, other.coords.length - 1]) {
          const p = other.coords[end];
          const d = haversineMeters(tip, p);
          if (d > 1.5 * METERS_PER_MILE) continue;
          const far = end === 0 ? other.coords[other.coords.length - 1] : other.coords[0];
          // Same-name pieces include cross streets. Only continue in the permit direction.
          if (desired != null && (!far || angleDiff(bearingDeg(tip, far), desired) > 110)) continue;
          if (desired != null && d > 20 && angleDiff(bearingDeg(tip, p), desired) > 110) continue;
          if (!jump || d < jump.d) jump = { other, end, d };
        }
      }
      if (!jump) break;
      const remain = target - traveled;
      if (jump.d >= remain) {
        const t = remain / jump.d;
        const tipPt = xy(tip);
        const destPt = xy(jump.other.coords[jump.end]);
        out.push({
          lng: tipPt.lng + (destPt.lng - tipPt.lng) * t,
          lat: tipPt.lat + (destPt.lat - tipPt.lat) * t,
        });
        traveled = target;
        break;
      }
      used.add(jump.other);
      current = jump.end === 0 ? jump.other.coords : jump.other.coords.slice().reverse();
      traveled += jump.d;
      out.push(xy(current[0]));
      i = 0;
      dir = 1;
    }
    return {
      coords: out,
      end: out[out.length - 1],
      walkedMiles: traveled / METERS_PER_MILE,
    };
  }

  let winner = null;
  for (const candidate of starts.slice(0, 24)) {
    start = candidate;
    let dir = 1;
    if (desired != null) {
      let score = Infinity;
      const line = start.way.coords;
      for (const d of [1, -1]) {
        const j = start.i + d;
        if (j < 0 || j >= line.length) continue;
        const diff = angleDiff(bearingDeg(line[start.i], line[j]), desired);
        if (diff < score) {
          score = diff;
          dir = d;
        }
      }
    } else if (dest) {
      dir = pickCompassDirection(start.way.coords, start.i, null, dest);
    }
    const traced = trace(dir);
    if (!traced.coords || traced.coords.length < 2 || traced.walkedMiles < 0.02) continue;
    if (!winner || traced.walkedMiles > winner.walkedMiles) {
      winner = {
        coords: traced.coords,
        end: traced.end,
        snapMiles: candidate.d,
        walkedMiles: traced.walkedMiles,
        name: candidate.way.name,
      };
    }
    if (winner.walkedMiles >= Math.max(miles, 0.05) * 0.85) break;
  }
  return winner;
}

function localNeedles(names) {
  const skip = new Set([
    "NORTH", "SOUTH", "EAST", "WEST", "NORTHWEST", "NORTHEAST", "SOUTHWEST", "SOUTHEAST",
    "ROAD", "STREET", "AVENUE", "DRIVE", "LANE", "BOULEVARD", "HIGHWAY", "HWY",
    "RD", "ST", "AVE", "DR", "LN", "BLVD",
  ]);
  const needles = [];
  const add = (token) => {
    const t = String(token || "").toUpperCase();
    if (t && !needles.includes(t)) needles.push(t);
  };
  for (const name of names) {
    let raw = String(name || "")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .toUpperCase()
      .trim();
    raw = raw.replace(/\b(ROAD|STREET|AVENUE|DRIVE|LANE|BOULEVARD|HIGHWAY|HWY|RD|ST|AVE|DR|LN|BLVD)\b/g, " ");
    raw = raw.replace(/\s+/g, " ").trim();
    const spaced = raw.replace(/([A-Z])(\d)/g, "$1 $2");
    const grid = spaced.match(/\b([NSEW])\s+0*(\d+)\b/);
    if (grid) add(grid[1] + grid[2]);
    const words = spaced.split(" ").filter((w) => w.length >= 4 && !skip.has(w));
    const short = spaced.split(" ").filter((w) => w.length === 3 && !skip.has(w));
    for (const word of words.length ? words : short) add(word);
  }
  return needles.slice(0, 8);
}

async function fetchOkStreetsNear(pos, miles, names) {
  const needles = localNeedles(names);
  if (!needles.length) return { ok: true, ways: [] };
  const radius = Math.min(20000, Math.max(6000, (Number(miles) || 1) * 1609 * 2));
  const dlat = radius / 111320;
  const dlng = radius / (111320 * Math.max(0.2, Math.cos((pos.lat * Math.PI) / 180)));
  const west = pos.lng - dlng;
  const south = pos.lat - dlat;
  const east = pos.lng + dlng;
  const north = pos.lat + dlat;
  const likes = needles.map((n) => `UPPER(STREETNAME) LIKE '%${n.replace(/'/g, "")}%'`).join(" OR ");
  const params = new URLSearchParams({
    where: likes,
    geometry: `${west},${south},${east},${north}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "STREETNAME,MLENGTH",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
    resultRecordCount: "2000",
  });
  try {
    const res = await fetch(`${OK_LOCAL_QUERY}?${params}`);
    const gj = await res.json().catch(() => ({}));
    if (!res.ok || gj.error) return { ok: true, ways: [], warning: "Local roads unavailable" };
    const ways = [];
    for (const feat of gj.features || []) {
      const street = feat.properties?.STREETNAME || "";
      const matched = names.find((n) => streetNamesMatch(n, street));
      if (!matched) continue;
      const geom = feat.geometry || {};
      const parts =
        geom.type === "LineString" ? [geom.coordinates] : geom.type === "MultiLineString" ? geom.coordinates : [];
      for (const part of parts) {
        const cleaned = (part || [])
          .filter((p) => p && p.length >= 2)
          .map((p) => [Number(p[0]), Number(p[1])]);
        if (cleaned.length >= 2) ways.push({ name: street, matched, coords: cleaned });
      }
    }
    if (!ways.length) {
      const osm = await fetchOsmNamedWays(pos, names);
      if (osm.length) return { ok: true, ways: osm };
    }
    return { ok: true, ways };
  } catch (_) {
    return { ok: true, ways: [], warning: "Local roads unavailable" };
  }
}

const nearbyRoadCache = new Map();

/**
 * Drive one permit leg the way a driver does.
 * The miles say how far this leg is. The heading is the turn (or the compass
 * printed on the line). The road name is preferred when it is there, and when
 * the sign does not match, the road that leaves in that direction is the one
 * the mileage calls for.
 */
async function driveLeg({ pos, miles, heading, names, lrs, preferNamed }) {
  let cursor = { ...pos };
  let remaining = Math.max(0, Number(miles) || 0);
  const coords = [];
  let roadName = null;
  const used = new Set();
  if (heading == null) heading = 0;

  for (let hop = 0; hop < 80 && remaining > 0.04; hop++) {
    const official = lrsWaysNear(lrs, cursor, 8);
    const namedOfficial = preferNamed ? official.filter((w) => wayMatchesPermit(names, w)) : [];
    let pick = pickWayByHeading(namedOfficial, cursor, heading, names, {
      preferNamed: true,
      used,
      wide: hop === 0,
      stay: hop > 0,
    });
    // The miles are not done and the named line stopped. Take the pavement
    // that continues in the direction this leg is traveling.
    if (!pick) {
      const local = await fetchLocalAround(cursor, 2.5);
      const around = await fetchRoadsAround(cursor, Math.max(2.5, Math.min(6, remaining + 1)));
      pick = pickWayByHeading(local.concat(around, official), cursor, heading, names, {
        preferNamed,
        used,
        wide: hop === 0,
        stay: hop > 0,
      });
    }
    if (!pick) break;
    const traced = traceWayMiles(pick.way, pick.snap, pick.dir, remaining);
    if (!traced || traced.miles < 0.03) {
      used.add(pick.way);
      continue;
    }
    for (const p of traced.coords) coords.push([p.lng, p.lat]);
    cursor = traced.end;
    remaining -= traced.miles;
    roadName = pick.way.name || roadName;
    used.add(pick.way);
  }

  return {
    coords,
    end: cursor,
    walkedMiles: Math.max(0, (Number(miles) || 0) - remaining),
    roadName,
  };
}

function lrsWaysNear(lrs, pos, radiusMi) {
  const out = [];
  for (const [code, lines] of Object.entries(lrs?.routes || {})) {
    for (const coords of lines) {
      if (!coords?.length) continue;
      let near = false;
      const step = Math.max(1, Math.floor(coords.length / 12));
      for (let i = 0; i < coords.length; i += step) {
        if (haversineMiles(pos, coords[i]) <= radiusMi) {
          near = true;
          break;
        }
      }
      if (near) out.push({ name: code, ref: code, coords });
    }
  }
  return out;
}

function wayMatchesPermit(names, way) {
  if (!names?.length || !way) return false;
  if (names.some((n) => streetNamesMatch(n, way.name) || (way.ref && streetNamesMatch(n, way.ref)))) return true;
  const codes = names.map((n) => toOdotRoute(n)).filter(Boolean);
  if (way.ref && codes.includes(way.ref)) return true;
  const ref = String(way.ref || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const label = String(way.name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return names.some((n) => {
    const plain = String(n)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    return plain.length >= 4 && (plain === ref || plain === label);
  });
}

function projectSegment(pos, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-12;
  let t = ((pos.lng - a[0]) * dx + (pos.lat - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { t, point: [a[0] + dx * t, a[1] + dy * t] };
}

function projectWay(way, pos) {
  const coords = way.coords || [];
  let best = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const proj = projectSegment(pos, coords[i], coords[i + 1]);
    const d = haversineMiles(pos, proj.point);
    if (!best || d < best.d) best = { i, t: proj.t, point: proj.point, d };
  }
  return best;
}

/** Bearing a short distance along the way from a projection. */
function bearingAlong(way, snap, dir) {
  const coords = way.coords;
  const next = dir === 1 ? snap.i + 1 : snap.i;
  if (next < 0 || next >= coords.length) return null;
  const further = next + dir;
  const target =
    haversineMeters(snap.point, coords[next]) < 12 && further >= 0 && further < coords.length
      ? coords[further]
      : coords[next];
  return bearingDeg(snap.point, target);
}

function pickWayByHeading(ways, pos, heading, names, { preferNamed, used, wide, stay }) {
  let best = null;
  for (const way of ways) {
    if (!way?.coords || way.coords.length < 2 || used.has(way)) continue;
    const snap = projectWay(way, pos);
    if (!snap) continue;
    const named = preferNamed && wayMatchesPermit(names, way);
    const onPavement = stay && snap.d < 0.12;
    const limit = named ? (wide ? 2.2 : 0.8) : onPavement ? 0.12 : wide ? 0.45 : 0.25;
    if (snap.d > limit) continue;
    for (const dir of [1, -1]) {
      const bearing = bearingAlong(way, snap, dir);
      if (bearing == null || heading == null) continue;
      const diff = angleDiff(bearing, heading);
      // At the turn, the heading picks the road. Once the truck is on it,
      // a bend is still this leg until the miles are done.
      if (diff > (onPavement ? 150 : named ? 75 : 55)) continue;
      const score = diff + snap.d * 25 - (named ? 28 : 0) - (onPavement ? 40 : 0);
      if (!best || score < best.score) best = { way, snap, dir, score, named };
    }
  }
  return best;
}

function traceWayMiles(way, snap, dir, miles) {
  const coords = way.coords;
  const target = Math.max(miles, 0.02) * METERS_PER_MILE;
  const out = [xy(snap.point)];
  let traveled = 0;
  let next = dir === 1 ? snap.i + 1 : snap.i;
  let from = snap.point;
  while (next >= 0 && next < coords.length && traveled < target) {
    const b = coords[next];
    const seg = haversineMeters(from, b);
    if (seg > 0.4 && traveled + seg >= target) {
      const t = (target - traveled) / seg;
      out.push({
        lng: from[0] + (b[0] - from[0]) * t,
        lat: from[1] + (b[1] - from[1]) * t,
      });
      traveled = target;
      break;
    }
    if (seg > 0.4) {
      traveled += seg;
      out.push(xy(b));
    }
    from = b;
    next += dir;
  }
  if (out.length < 2 || traveled < 20) return null;
  return { coords: out, end: out[out.length - 1], miles: traveled / METERS_PER_MILE };
}

const localRoadCache = new Map();

async function fetchLocalAround(pos, radiusMi) {
  const key = `${pos.lat.toFixed(2)},${pos.lng.toFixed(2)}`;
  if (localRoadCache.has(key)) return localRoadCache.get(key);
  const radius = Math.min(7000, Math.max(2500, radiusMi * 1609));
  const dlat = radius / 111320;
  const dlng = radius / (111320 * Math.max(0.2, Math.cos((pos.lat * Math.PI) / 180)));
  const params = new URLSearchParams({
    where: "1=1",
    geometry: `${pos.lng - dlng},${pos.lat - dlat},${pos.lng + dlng},${pos.lat + dlat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "STREETNAME",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
    resultRecordCount: "2000",
  });
  try {
    const res = await fetch(`${OK_LOCAL_QUERY}?${params}`);
    const gj = await res.json().catch(() => ({}));
    const ways = [];
    for (const feat of gj.features || []) {
      const geom = feat.geometry || {};
      const parts =
        geom.type === "LineString" ? [geom.coordinates] : geom.type === "MultiLineString" ? geom.coordinates : [];
      for (const part of parts) {
        const coords = (part || []).filter((p) => p && p.length >= 2).map((p) => [Number(p[0]), Number(p[1])]);
        if (coords.length >= 2) ways.push({ name: feat.properties?.STREETNAME || "", ref: "", coords });
      }
    }
    localRoadCache.set(key, ways);
    return ways;
  } catch (_) {
    localRoadCache.set(key, []);
    return [];
  }
}

async function fetchRoadsAround(pos, radiusMi) {
  const key = `${pos.lat.toFixed(2)},${pos.lng.toFixed(2)}`;
  if (nearbyRoadCache.has(key)) return nearbyRoadCache.get(key);
  const meters = Math.round(Math.min(9000, Math.max(2500, radiusMi * 1609)));
  const query =
    `[out:json][timeout:20];way["highway"~"motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link"](around:${meters},${pos.lat},${pos.lng});out geom;`;
  const body = new URLSearchParams({ data: query });
  const endpoints = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const ways = [];
      for (const el of json.elements || []) {
        const tags = el.tags || {};
        const coords = (el.geometry || [])
          .filter((g) => g.lon != null && g.lat != null)
          .map((g) => [Number(g.lon), Number(g.lat)]);
        if (coords.length < 2) continue;
        ways.push({ name: tags.name || tags.ref || "", ref: tags.ref || "", coords });
      }
      nearbyRoadCache.set(key, ways);
      return ways;
    } catch (_) {
      /* next server */
    }
  }
  nearbyRoadCache.set(key, []);
  return [];
}

/** Roads the state layer does not label, looked up by the permit's own name. */
async function fetchOsmNamedWays(pos, names) {
  const needles = localNeedles(names);
  if (!needles.length) return [];
  const token = needles.slice().sort((a, b) => b.length - a.length)[0].replace(/[^A-Za-z0-9]/g, "");
  if (token.length < 3) return [];
  const query =
    `[out:json][timeout:18];way["highway"]["name"~"${token}",i](around:12000,${pos.lat},${pos.lng});out geom;`;
  const body = new URLSearchParams({ data: query });
  const endpoints = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const ways = [];
      for (const el of json.elements || []) {
        const street = el.tags?.name || "";
        const matched = names.find((n) => streetNamesMatch(n, street));
        if (!matched) continue;
        const coords = (el.geometry || [])
          .filter((g) => g.lon != null && g.lat != null)
          .map((g) => [Number(g.lon), Number(g.lat)]);
        if (coords.length >= 2) ways.push({ name: street, matched, coords });
      }
      if (ways.length) return ways;
    } catch (_) {
      /* try the next map server */
    }
  }
  return [];
}

/**
 * Walk `miles` along ODOT lines from `from`, only in `compass` direction.
 * Joins fragmented LRS pieces by any nearby vertex, not only endpoints.
 */
function walkHighway(lines, from, compass, miles, dest, { strict = false, maxSnapMi = 0.45, joinMi = 2.5 } = {}) {
  const targetMeters = Math.max(miles, 0.05) * METERS_PER_MILE;
  const startPt = [from.lng, from.lat];
  const joinMeters = Math.max(joinMi, 0.4) * METERS_PER_MILE;

  let best = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (let i = 0; i < line.length; i++) {
      const d = haversineMeters(startPt, line[i]);
      if (!best || d < best.d) best = { li, i, d, line };
    }
  }
  if (!best || best.d > maxSnapMi * METERS_PER_MILE) return null;

  let line = best.line;
  let liCur = best.li;
  let i = best.i;
  let dir = pickCompassDirection(line, i, compass, dest);

  const out = [xy(line[i])];
  let traveled = 0;
  const usedPieces = new Set([liCur]);

  const tryJoin = (tip) => {
    let jump = null;
    for (let li = 0; li < lines.length; li++) {
      if (usedPieces.has(li)) continue;
      const other = lines[li];
      for (let j = 0; j < other.length; j++) {
        const p = other[j];
        const d = haversineMeters(tip, p);
        if (d > joinMeters) continue;
        for (const tryDir of [1, -1]) {
          const nj = j + tryDir;
          if (nj < 0 || nj >= other.length) continue;
          if (compass && !segmentRespectsCompass(other[j], other[nj], compass, 45)) continue;
          // Prefer forward progress in the travel direction.
          if (compass && d > 0.15 * METERS_PER_MILE && !segmentRespectsCompass(tip, other[nj], compass, 45)) {
            continue;
          }
          if (!jump || d < jump.d) {
            jump = { li, j, dir: tryDir, d, score: d, tipNext: other[nj] };
          }
        }
      }
    }
    return jump;
  };

  let guard = 0;
  while (traveled < targetMeters && guard++ < 20000) {
    const nextIdx = i + dir;
    if (nextIdx >= 0 && nextIdx < line.length) {
      const a = line[i];
      const b = line[nextIdx];
      if (compass && !segmentRespectsCompass(a, b, compass)) {
        if (strict) break;
        const flipped = -dir;
        const alt = i + flipped;
        if (alt >= 0 && alt < line.length && segmentRespectsCompass(line[i], line[alt], compass)) {
          dir = flipped;
          continue;
        }
        // Dead end on this piece — join another piece ahead.
        const jump = tryJoin(a);
        if (!jump) break;
        if (jump.d > targetMeters - traveled + 0.15 * METERS_PER_MILE) {
          const remain = targetMeters - traveled;
          if (remain > 1 && jump.d <= 5 * METERS_PER_MILE) {
            const tipPt = xy(a);
            const destPt = xy(lines[jump.li][jump.j]);
            const t = remain / jump.d;
            out.push({
              lng: tipPt.lng + (destPt.lng - tipPt.lng) * t,
              lat: tipPt.lat + (destPt.lat - tipPt.lat) * t,
            });
            traveled = targetMeters;
          }
          break;
        }
        traveled += jump.d;
        out.push(xy(lines[jump.li][jump.j]));
        line = lines[jump.li];
        liCur = jump.li;
        i = jump.j;
        dir = jump.dir;
        usedPieces.add(liCur);
        continue;
      }
      const seg = haversineMeters(a, b);
      if (traveled + seg >= targetMeters && seg > 0) {
        const t = Math.max(0, Math.min(1, (targetMeters - traveled) / seg));
        out.push({
          lng: a[0] + (b[0] - a[0]) * t,
          lat: a[1] + (b[1] - a[1]) * t,
        });
        traveled = targetMeters;
        break;
      }
      traveled += seg;
      out.push(xy(b));
      i = nextIdx;
      continue;
    }

    const tip = line[i];
    const jump = tryJoin(tip);
    if (!jump) break;
    // Same road continues past a gap in the centerline. Do not walk farther than this step's miles.
    if (jump.d > targetMeters - traveled + 0.15 * METERS_PER_MILE) {
      const remain = targetMeters - traveled;
      if (remain > 1 && jump.d <= 5 * METERS_PER_MILE) {
        const tipPt = xy(tip);
        const destPt = xy(lines[jump.li][jump.j]);
        const t = remain / jump.d;
        out.push({
          lng: tipPt.lng + (destPt.lng - tipPt.lng) * t,
          lat: tipPt.lat + (destPt.lat - tipPt.lat) * t,
        });
        traveled = targetMeters;
      }
      break;
    }
    traveled += jump.d;
    out.push(xy(lines[jump.li][jump.j]));
    line = lines[jump.li];
    liCur = jump.li;
    i = jump.j;
    dir = jump.dir;
    usedPieces.add(liCur);
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

function segmentRespectsCompass(a, b, compass, limitDeg = 100) {
  if (!compass) return true;
  const aa = Array.isArray(a) ? a : [a.lng, a.lat];
  const bb = Array.isArray(b) ? b : [b.lng, b.lat];
  // A curve on the same highway wiggles. Only reject a real turnaround.
  if (haversineMeters(aa, bb) < 12) return true;
  const desired = { NB: 0, EB: 90, SB: 180, WB: 270 }[compass];
  if (desired == null) return true;
  return angleDiff(bearingDeg(aa, bb), desired) <= limitDeg;
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

async function fetchOkLrs(routes) {
  const codes = [...new Set(routes.map((r) => String(r).replace(/[^A-Za-z0-9]/g, "")).filter(Boolean))];
  if (!codes.length) return { ok: true, routes: {} };
  const where = `ODOTROUTE IN (${codes.map((c) => `'${c}'`).join(",")})`;
  const features = [];
  let offset = 0;
  for (let page = 0; page < 8; page++) {
    const params = new URLSearchParams({
      where,
      outFields: "ODOTROUTE,MLENGTH",
      returnGeometry: "true",
      outSR: "4326",
      f: "geojson",
      resultOffset: String(offset),
      resultRecordCount: "2000",
    });
    const res = await fetch(`${OK_LRS_QUERY}?${params}`);
    const gj = await res.json().catch(() => ({}));
    if (!res.ok || gj.error) {
      const msg = gj.error?.message || gj.error || `ODOT highways failed (${res.status})`;
      throw new Error(typeof msg === "string" ? msg : "ODOT highways failed");
    }
    const batch = gj.features || [];
    features.push(...batch);
    if (!gj.exceededTransferLimit || !batch.length) break;
    offset += batch.length;
  }

  const byRoute = {};
  for (const feat of features) {
    const code = feat.properties?.ODOTROUTE;
    if (!code) continue;
    const geom = feat.geometry || {};
    const parts =
      geom.type === "LineString" ? [geom.coordinates] : geom.type === "MultiLineString" ? geom.coordinates : [];
    for (const line of parts) {
      const cleaned = (line || [])
        .filter((p) => p && p.length >= 2)
        .map((p) => [Number(p[0]), Number(p[1])]);
      if (cleaned.length < 2) continue;
      if (!byRoute[code]) byRoute[code] = [];
      byRoute[code].push(cleaned);
    }
  }
  return { ok: true, routes: byRoute };
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
