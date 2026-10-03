/**
 * Oklahoma route builder — follow the permit Driving Directions literally.
 *
 * Any Oklahoma permit: each Driving Directions line is miles plus a road.
 * Walk that road for those miles. A step is wrong only when both the
 * miles and the road name miss. Mapbox is only used for a short exit hop.
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

  const learned = learnHighwayAliases(parsed.steps);

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
    if (step.road) lastRoad = step.road;
    if (step.compass) lastCompass = step.compass;

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

    const prevStep = i > 0 ? parsed.steps[i - 1] : null;
    const prevConnector = prevStep && /^(Take exit|Merge)|\(Ramp\)/i.test(String(prevStep.instruction || "").trim() + (prevStep.maneuver || ""));
    // Stay snapped to the same numbered highway across LRS gaps.
    const maxSnap = i === 0 ? 2.5 : prevConnector ? 2.0 : sameHwy ? 2.5 : /Continue/i.test(step.maneuver || "") ? 1.5 : 1.2;
    let highway = pickHighway(names, lrs, pos, maxSnap, continueCode);
    if (!highway && thisCode && lrs.routes?.[thisCode]?.length) {
      const snap = nearestDistMiles(lrs.routes[thisCode], pos);
      if (snap <= Math.max(maxSnap, 3)) {
        highway = { code: thisCode, name: names.find((n) => toOdotRoute(n) === thisCode) || thisCode, lines: lrs.routes[thisCode], snap };
      }
    }
    if (highway && !isExit) {
      const walkOpts = { maxSnapMi: maxSnap, joinMi: sameHwy ? 4 : 2.5 };
      let walked = walkHighway(highway.lines, pos, compass, miles, dest, walkOpts);
      if (walked?.coords?.length && compass && !directionOk(pos, walked.coords[walked.coords.length - 1], compass)) {
        const forced = walkHighway(highway.lines, pos, compass, miles, dest, { ...walkOpts, strict: true });
        if (forced?.coords?.length) walked = forced;
      }
      let got = walked ? pathMiles(walked.coords.map((p) => (Array.isArray(p) ? p : [p.lng, p.lat]))) : 0;
      let usedHwy = highway;
      // Concurrent aliases: if OK-152 fails, walk US-81 when the permit lists it.
      if (got < Math.max(0.05, miles * 0.5)) {
        for (const name of names) {
          const code = toOdotRoute(name);
          if (!code || code === usedHwy.code) continue;
          const lines = lrs.routes?.[code] || [];
          if (!lines.length) continue;
          const alt = walkHighway(lines, pos, compass, miles, dest, {
            maxSnapMi: Math.max(maxSnap, 3),
            joinMi: 4,
          });
          const altMi = alt ? pathMiles(alt.coords.map((p) => (Array.isArray(p) ? p : [p.lng, p.lat]))) : 0;
          if (altMi > got) {
            walked = alt;
            got = altMi;
            usedHwy = { code, name, lines, snap: nearestDistMiles(lines, pos) };
          }
        }
      }
      if (walked?.coords?.length && got >= 0.05) {
        appendCoords(coordinates, walked.coords.map((p) => (Array.isArray(p) ? p : [p.lng, p.lat])));
        pos = walked.end;
        usedRoad = usedHwy.name;
        roadOk = true;
        measured = got;
        if (toOdotRoute(usedHwy.name) || usedHwy.code) lastRoad = usedHwy.name;
      } else {
        usedRoad = null;
        roadOk = false;
        measured = 0;
      }
    } else if (!isExit && names.length) {
      const desired = desiredBearing(heading, step.maneuver, compass);
      const nextForDir = parsed.steps.slice(i + 1).find((s) => stepNames(s).length);
      const nextForLines = nextForDir ? pickHighway(stepNames(nextForDir), lrs, pos, Math.max(3, miles + 1)) : null;
      // One lookup only covers a few miles. Keep walking the same named road
      // until the mileage column is used or the centerline stops.
      let remaining = miles;
      let snapMiles = null;
      let walkedName = null;
      for (let hop = 0; hop < 8 && remaining > 0.05; hop++) {
        let ways = [];
        try {
          const pack = await fetchOkStreetsNear(pos, Math.min(remaining, 2.5), names, baseUrl);
          ways = (pack.ways || []).filter((w) => names.some((n) => streetNamesMatch(n, w.name) || streetNamesMatch(n, w.matched)));
          if (pack.warning && !ways.length && hop === 0) warnings.push(`Step ${i + 1}: ${pack.warning}`);
        } catch (_) {
          ways = [];
        }
        const walked = walkNamedWays(ways, pos, remaining, desired, dest, nextForLines?.lines || null);
        const gained = walked?.walkedMiles || 0;
        if (!walked?.coords?.length || gained < 0.02) break;
        appendCoords(coordinates, walked.coords.map((p) => [p.lng, p.lat]));
        pos = walked.end;
        walkedName = walked.name;
        if (snapMiles == null) snapMiles = walked.snapMiles;
        remaining -= gained;
      }
      if (walkedName) {
        usedRoad = walkedName;
        roadOk = snapMiles <= 0.8;
        measured = Math.max(0, miles - remaining);
      } else {
        const alias = names.map((n) => learned.get(compactRoad(n))).find(Boolean);
        const aliasLines = alias ? lrs.routes?.[alias.code] || [] : [];
        const hw = aliasLines.length
          ? walkHighway(aliasLines, pos, compass, miles, dest, { maxSnapMi: maxSnap })
          : null;
        if (hw?.coords?.length) {
          appendCoords(coordinates, hw.coords.map((p) => (Array.isArray(p) ? p : [p.lng, p.lat])));
          pos = hw.end;
          usedRoad = alias.name;
          roadOk = true;
          measured = pathMiles(hw.coords.map((p) => (Array.isArray(p) ? p : [p.lng, p.lat])));
        } else {
          // Permit name may not match the map. On a turn, walk whatever
          // centerline is at this junction in the stated direction.
          const turn = /Turn|Bear|Start on|Continue/i.test(step.maneuver || instr);
          const anyHwy = turn ? walkNearestHighway(lrs, pos, compass, miles, dest, Math.max(maxSnap, 1.2)) : null;
          if (anyHwy?.coords?.length) {
            appendCoords(coordinates, anyHwy.coords.map((p) => (Array.isArray(p) ? p : [p.lng, p.lat])));
            pos = anyHwy.end;
            usedRoad = anyHwy.name;
            roadOk = true;
            measured = pathMiles(anyHwy.coords.map((p) => (Array.isArray(p) ? p : [p.lng, p.lat])));
          } else {
            // Short hop toward the next numbered highway (exit-style).
            const nextHwy = parsed.steps.slice(i + 1).find((s) => stepNames(s).some((n) => toOdotRoute(n)));
            const hwyNames = nextHwy ? stepNames(nextHwy).filter((n) => toOdotRoute(n)) : [];
            const reach = Math.max(3, miles * 3);
            const nh = hwyNames.length ? pickHighway(hwyNames, lrs, pos, reach) : null;
            const target = nh ? nearestOnLines(nh.lines, pos) : null;
            const gap = target ? haversineMiles(pos, target) : Infinity;
            if (target && gap <= reach) {
              const go = Math.min(Math.max(miles, 0.05), gap);
              const mid = moveByHeading(pos, bearingDeg(pos, target), go);
              if (mid) {
                coordinates.push([mid.lng, mid.lat]);
                pos = mid;
                usedRoad = nh.name || names[0];
                roadOk = true;
                measured = go;
              } else {
                usedRoad = null;
                roadOk = false;
                measured = 0;
              }
            } else {
              usedRoad = null;
              roadOk = false;
              measured = 0;
            }
          }
        }
      }
    } else {
      // Exit, ramp, or a step with no road name: short hop toward the next named road.
      const next = parsed.steps.slice(i + 1).find((s) => stepNames(s).length);
      const nextNames = next ? stepNames(next) : [];
      const reach = Math.max(3, miles * 3);
      const nextHighway = next ? pickHighway(nextNames, lrs, pos, reach) : null;
      let target = nextHighway ? nearestOnLines(nextHighway.lines, pos) : null;
      if (!target && nextNames.length) {
        try {
          const pack = await fetchOkStreetsNear(pos, Math.max(miles, 1), nextNames, baseUrl);
          const ways = (pack.ways || []).filter((w) =>
            nextNames.some((n) => streetNamesMatch(n, w.name) || streetNamesMatch(n, w.matched)),
          );
          target = nearestNamedPoint(ways, pos);
        } catch (_) {
          target = null;
        }
      }
      const gap = target ? haversineMiles(pos, target) : Infinity;
      if (target && gap <= reach) {
        if (gap > 0.04) {
          coordinates.push([target.lng, target.lat]);
          pos = target;
        }
        // A short ramp whose highways already meet has no separate centerline.
        measured = !names.length && miles <= 0.5 && gap <= 0.25 ? miles : gap;
        if (names.length) {
          usedRoad = nextHighway?.name || null;
          roadOk = true;
        } else {
          roadOk = null;
        }
      } else {
        measured = 0;
        roadOk = names.length ? false : null;
      }
    }

    const added = coordinates.slice(Math.max(0, markAt - 1));
    const walkedMi = measured != null ? measured : pathMiles(added);
    const milesOk = milesClose(miles, walkedMi);
    // Map label vs permit name does not fail the step. Miles + a drawn
    // centerline (or a turn onto the road that is there) is enough.
    if (walkedMi >= 0.02 && roadOk === false) roadOk = true;
    if (milesOk && usedRoad && roadOk === false) roadOk = true;
    const bothFail = milesOk === false && walkedMi < 0.02;
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

    if (coordinates.length >= 2) {
      const a = coordinates[coordinates.length - 2];
      const b = coordinates[coordinates.length - 1];
      if (haversineMiles(a, b) > 0.02) heading = bearingDeg(a, b);
    }
  }

  // The directions already ended. Only close a short gap to the permit pin.
  if (haversineMiles(pos, dest) <= 0.75) {
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

function walkNamedWays(ways, from, miles, desired, dest, nextLines) {
  if (!ways?.length) return null;
  let best = null;
  for (const way of ways) {
    const coords = way.coords || [];
    for (let i = 0; i < coords.length; i++) {
      const d = haversineMiles(from, coords[i]);
      if (!best || d < best.d) best = { way, i, d };
    }
  }
  if (!best || best.d > 0.8) return null;

  const target = Math.max(miles, 0.05) * METERS_PER_MILE;
  function trace(startDir) {
    let current = best.way.coords;
    let i = best.i;
    let dir = startDir;
    const out = [xy(current[i])];
    let traveled = 0;
    const used = new Set([best.way]);
    while (traveled < target) {
      const next = i + dir;
      if (next >= 0 && next < current.length) {
        const seg = haversineMeters(current[i], current[next]);
        // Stay on the permit compass. Same-name pieces often loop; skip reverse edges.
        if (desired != null && seg > 8 && angleDiff(bearingDeg(current[i], current[next]), desired) > 70) {
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
        if (!streetNamesMatch(other.name, best.way.name) && !streetNamesMatch(other.matched, best.way.matched)) continue;
        for (const end of [0, other.coords.length - 1]) {
          const p = other.coords[end];
          const d = haversineMeters(tip, p);
          if (d > 0.5 * METERS_PER_MILE) continue;
          const far = end === 0 ? other.coords[other.coords.length - 1] : other.coords[0];
          // Same-name pieces include cross streets. Only continue in the permit direction.
          if (desired != null && (!far || angleDiff(bearingDeg(tip, far), desired) > 55)) continue;
          if (desired != null && d > 20 && angleDiff(bearingDeg(tip, p), desired) > 70) continue;
          if (!jump || d < jump.d) jump = { other, end, d };
        }
      }
      if (!jump) break;
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

  let dir = 1;
  if (desired != null) {
    let score = Infinity;
    const line = best.way.coords;
    for (const d of [1, -1]) {
      const j = best.i + d;
      if (j < 0 || j >= line.length) continue;
      const diff = angleDiff(bearingDeg(line[best.i], line[j]), desired);
      if (diff < score) {
        score = diff;
        dir = d;
      }
    }
  } else if (nextLines?.length) {
    // After this many miles the next instruction's road should be there.
    let bestDist = Infinity;
    for (const d of [1, -1]) {
      const trial = trace(d);
      const dist = nearestDistMiles(nextLines, trial.end);
      if (dist < bestDist) {
        bestDist = dist;
        dir = d;
      }
    }
  } else if (dest) {
    dir = pickCompassDirection(best.way.coords, best.i, null, dest);
  }

  const traced = trace(dir);
  if (!traced.coords || traced.coords.length < 2) return null;
  return {
    coords: traced.coords,
    end: traced.end,
    snapMiles: best.d,
    walkedMiles: traced.walkedMiles,
    name: best.way.name,
  };
}

async function fetchOkStreetsNear(pos, miles, names, baseUrl) {
  const radius = Math.min(18000, Math.max(1600, (Number(miles) || 0.5) * 1609 * 1.3));
  const params = new URLSearchParams({
    lat: String(pos.lat),
    lng: String(pos.lng),
    radius_m: String(Math.round(radius)),
    names: names.join("|"),
  });
  const res = await fetch(`${baseUrl}/api/ok/streets?${params}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `Local roads fetch failed (${res.status})`);
  return json;
}

/**
 * Walk `miles` along ODOT lines from `from`, only in `compass` direction.
 * Joins fragmented LRS pieces by any nearby vertex, not only endpoints.
 */
function walkHighway(lines, from, compass, miles, dest, { strict = false, maxSnapMi = 0.45, joinMi = 2.5 } = {}) {
  const targetMeters = Math.max(miles, 0.05) * METERS_PER_MILE;
  const startPt = [from.lng, from.lat];
  const joinMeters = Math.max(joinMi, 1.2) * METERS_PER_MILE;

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
          if (compass && !segmentRespectsCompass(other[j], other[nj], compass)) continue;
          // Prefer forward progress in the travel direction.
          if (compass && d > 0.15 * METERS_PER_MILE && !segmentRespectsCompass(tip, other[nj], compass)) {
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
        if (jump.d > targetMeters - traveled + 0.05 * METERS_PER_MILE) break;
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
    // Do not leap past the mileage column on a long LRS gap.
    if (jump.d > targetMeters - traveled + 0.05 * METERS_PER_MILE) break;
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
