/**
 * TxDMV oversize/overweight permit turn-table parser.
 * Ported from the previous Permit Path parser (tx-turntable-v2.10.0).
 * Input is OCR / PDF / pasted permit text. Output is ordered highway
 * junctions the map layer can geocode.
 */
export const PARSER_VERSION = "tx-turntable-v2.10.0";


const ODOMETER_TOLERANCE_MI = 0.2;

/** Keep in sync with client `js/app.js` ROUTE_PATTERNS (TxDMV PDF tokens). */
const ROUTE_PATTERNS = [
  { label: "Interstate", re: /\bI\s*[-–]?\s*0*(\d{1,3})\b/gi },
  { label: "IH", re: /\bIH\s*[-–]?\s*0*(\d{1,3})(?:[A-Za-z]+)?\b/gi },
  { label: "Business IH", re: /\bBI\s*[-–]?\s*0*(\d{1,3})(?:[A-Za-z]+)?\b/gi },
  { label: "US Highway", re: /\bUS\s*[-–]?\s*0*(\d{1,3})([A-Za-z]*)\b/gi },
  { label: "State Hwy", re: /\b(?:SH|TX|State\s+Hwy\.?)\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi },
  { label: "Farm / Ranch", re: /\b(?:FM|RM)\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi },
  { label: "County Road", re: /\bCR\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi },
  { label: "Loop", re: /\bLOOP\s*[-–]?\s*(\d{1,4}[A-Za-z]?)\b/gi },
  { label: "State Loop", re: /\bSL\s*[-–]?\s*(\d{1,4})([A-Za-z]*)\b/gi },
  { label: "State Spur", re: /\bSS\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi },
  { label: "Spur", re: /\bSP\s*[-–]?\s*0*(\d{1,3})([A-Za-z]*)\b/gi },
  { label: "Business US", re: /\b(?:BU|BUS)\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi },
];

function normalizeWs(s) {
  return s
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .trim();
}

function cleanLine(s) {
  return s.replace(/\s+/g, " ").trim();
}

function normalizeCommonOcrTypos(s) {
  return cleanLine(s)
    // Preserve true "of", but recover common OCR "0f"/"0F".
    .replace(/\b0f\b/gi, "of")
    // OCR often reads US0### / USO###.
    .replace(/\bUS[O0]\s*(\d{2,4})\b/gi, "US $1")
    // SHO### should be SH ###.
    .replace(/\bSH[O0]\s*(\d{2,4})\b/gi, "SH $1")
    // 1H20 / lH20 -> IH20
    .replace(/\b[1lI]H\s*([0-9]{1,3})\b/g, "IH $1")
    // Keep service-road variants parseable.
    .replace(/\bIH\s*([0-9]{1,3})\s*SFR\b/gi, "IH $1 SFR");
}

function dedupeStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const v = cleanLine(x);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** Normalize TxDMV-style route tokens with prefixes/suffixes — parity with `js/app.js`. */
function normalizePrintedRouteToken(raw) {
  if (!raw) return raw;
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/\bBU(?:S)?\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi, (_, n, suf) => {
    const sufSp = suf ? String(suf).replace(/\s+/g, "").toUpperCase() : "";
    return `BU ${parseInt(n, 10)}${sufSp || ""}`;
  });
  s = s.replace(/\bBI\s*[-–]?\s*0*(\d{1,3})([A-Za-z]*)\b/gi, (_, n, suf) =>
    `BI ${parseInt(n, 10)}${(suf || "").replace(/\s+/g, "")}`);
  s = s.replace(/\bSS\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi, (_, n, suf) =>
    `SS ${parseInt(n, 10)}${(suf || "").replace(/\s+/g, "")}`);
  s = s.replace(/\bSP\s*[-–]?\s*0*(\d{1,3})([A-Za-z]*)\b/gi, (_, n, suf) =>
    `SP ${parseInt(n, 10)}${(suf || "").replace(/\s+/g, "")}`);
  s = s.replace(/\bCR\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi, (_, n, suf) =>
    `CR ${parseInt(n, 10)}${suf || ""}`);
  s = s.replace(/\bUS\s*[-–]?\s*0*(\d{1,3})([A-Za-z]*)\b/gi, (_, n, suf) => {
    const sufClean = (suf || "").replace(/\s+/g, "");
    return `US ${parseInt(n, 10)}${sufClean}`;
  });
  s = s.replace(/\b(?:SH|TX)\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi, (_, n, suf) => {
    const sufClean = (suf || "").replace(/\s+/g, "");
    return `SH ${parseInt(n, 10)}${sufClean}`;
  });
  s = s.replace(/\bFM\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi, (_, n, suf) =>
    `FM ${parseInt(n, 10)}${suf || ""}`);
  s = s.replace(/\bRM\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi, (_, n, suf) =>
    `RM ${parseInt(n, 10)}${suf || ""}`);
  s = s.replace(/\bSL\s*[-–]?\s*0*(\d{1,4})([A-Za-z]*)\b/gi, (_, n, suf) =>
    `SL ${parseInt(n, 10)}${(suf || "").replace(/\s+/g, "")}`);
  s = s.replace(/\bIH\s*[-–]?\s*0*(\d{1,3})([A-Za-z]*)\b/gi, (_, n) => `IH ${parseInt(n, 10)}`);
  return s;
}

function normalizeRouteToken(raw) {
  return normalizePrintedRouteToken(normalizeCommonOcrTypos(raw));
}

function normalizeHyphensForMatching(line) {
  return line
    .replace(/\b(FM|RM|SH|US|TX|BU|BI|SS|SP|CR)-(\d+)\b/gi, "$1 $2")
    .replace(/\b(fm|rm|sh|us)(\d{2,4})([a-z]*)\b/gi, (_, abbr, n, suf) =>
      `${String(abbr).toUpperCase()} ${n}${suf || ""}`);
}


function findHighwaysOnLine(line) {
  const raw = [];
  for (const p of ROUTE_PATTERNS) {
    const rx = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`);
    let m;
    while ((m = rx.exec(line)) !== null) {
      const token = normalizePrintedRouteToken(m[0].replace(/\s+/g, " ").trim());
      raw.push({ label: p.label, text: token, start: m.index, end: m.index + m[0].length });
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const nonOverlap = [];
  let lastEnd = -1;
  for (const r of raw) {
    if (r.start < lastEnd) continue;
    nonOverlap.push(r);
    lastEnd = r.end;
  }
  return nonOverlap;
}

function interstateSpoken(highwayText) {
  const ih = highwayText.match(/\b(?:IH|I)\s*[-–]?\s*(\d{1,3})(?:[A-Za-z]+)?\b/i);
  if (ih) return `Interstate ${parseInt(ih[1], 10)}`;
  const bi = highwayText.match(/\bBI\s*[-–]?\s*(\d{1,3})(?:[A-Za-z]+)?\b/i);
  if (bi) return `Business Interstate ${parseInt(bi[1], 10)}`;
  return highwayText;
}

function extractExitNumber(line) {
  const m = /\bExit\s+(\d+)\b/i.exec(line);
  return m ? m[1] : "";
}

function extractTowardCityFromLine(line) {
  const m = /\btoward\s+([^[\n]+)/i.exec(line);
  if (!m) return "";
  let chunk = m[1].trim();
  chunk = chunk.replace(/\s+\d+\.\d+\s+\d{1,2}:\d{2}\s*$/, "").trim();
  const parts = chunk
    .split("/")
    .map((p) => p.replace(/\[[^\]]*\]/g, "").trim())
    .filter(Boolean);
  if (!parts.length) return "";
  const last = parts[parts.length - 1];
  if (/^[A-Za-z]/.test(last) && last.length > 2 && !/^\d/.test(last)) {
    return last.replace(/\s+/g, " ").trim();
  }
  return "";
}

function enrichQueriesForTxRow(
  queries,
  road,
  dir,
  line,
  legMiles,
) {
  const spoken = interstateSpoken(road);
  const isIH =
    /\bIH\b/i.test(road) ||
    /\bBI\b/i.test(road) ||
    /\bI\s*[-–]?\s*\d{1,3}\b/i.test(road) ||
    spoken.startsWith("Interstate ") ||
    spoken.startsWith("Business Interstate ");
  let out = [...queries];
  const exitNum = extractExitNumber(line);
  if (isIH && exitNum) {
    out = dedupeStrings(
      [`${spoken} Exit ${exitNum} Texas`, `${spoken} Exit ${exitNum} ${dir || ""} Texas`.replace(/\s+/g, " ").trim()]
        .concat(out),
    );
  }
  const toward = extractTowardCityFromLine(line);
  if (isIH && toward) {
    out = dedupeStrings([`${spoken} near ${toward} Texas`, `${spoken} ${toward} Texas`].concat(out));
  }
  const dirWord = dir || "";
  if (dirWord && legMiles != null && legMiles > 0 && legMiles < 500) {
    out = dedupeStrings([`${road} ${dirWord} Texas highway`, `${spoken} ${dirWord} Texas`].concat(out));
  }
  return dedupeStrings(out);
}

/** Stop collecting a multi-line Origin block */
const ORIGIN_BLOCK_STOP =
  /^\s*(Destination|Final\s+Destination|Route\s+Conditions|General\s+Conditions|Miles\s*Route\s*To|Dimension|Dimensions|Vehicle|Load\s+description|Escort|Certification|Point\s+of\s+origin)\b/i;

/** Stop collecting a multi-line Destination block */
const DEST_BLOCK_STOP =
  /^\s*(Route\s+Conditions|General\s+Conditions|Miles\s*Route\s*To|Dimension|Dimensions|Vehicle|Origin\s*:|Effective\s+date|Expiration|Certification)\b/i;

/**
 * Lines that end any Origin/Destination narrative block regardless of section keyword: the turn
 * table, loaded-route bracket lines, page footers, and Route-Conditions asterisk notes. Guards
 * against `pdf-parse` runs where these arrive without surrounding blank lines.
 */
function isNarrativeBlockBoundary(line) {
  return (
    isTableHeader(line) ||
    /^\s*\[\s*Loaded\s+Route/i.test(line) ||
    /^\s*\*/.test(line) ||
    /^\s*Texas\s+Oversize/i.test(line) ||
    /^\s*PAGE\s+\d+\s+of\s+\d+/i.test(line) ||
    /^\s*--\s*\d+\s+of\s+\d+/i.test(line) ||
    /^\s*For\s+more\s+information\b/i.test(line)
  );
}

/** Strip a trailing odometer/estimated-time artifact that pdf-parse glues onto narrative lines. */
function stripTrailingPermitTime(s) {
  return cleanLine(s)
    .replace(/\s*\d+\.\d{2}\s*\d{1,2}:\d{2}\s*$/, "")
    .replace(/\s*\d{1,2}:\d{2}\s*$/, "")
    .trim();
}

function scoreAnchorText(s, kind) {
  const t = s.trim();
  if (t.length < 2) return -1;
  let sc = Math.min(t.length, 320);
  if (/\b(US|SH|FM|RM|IH|BI|BU|CR|SS|SP|SL)\s*[-–]?\s*\d/i.test(t)) sc += 120;
  if (/\d+(?:\.\d+)?\s*mi(?:le)?s?\b/i.test(t)) sc += 75;
  if (/junction|intersection|\s&\s|\s+and\s+/i.test(t)) sc += 40;
  if (/\[\s*Loaded\s+Route/i.test(t)) sc += 25;
  if (
    kind === "dest" &&
    /\b\d{2,5}\s+\w[\w\s]{2,24}\b(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln|blvd|hwy|fm)\b/i.test(
      t,
    )
  ) {
    sc += 60;
  }
  return sc;
}

function extractLoadedBracketField(text, label) {
  const out = [];
  const re =
    label === "Origin"
      ? /\[\s*Loaded\s+Route\s+Origin\s*:\s*([^\]\n]+)/gi
      : /\[\s*Loaded\s+Route\s+Destination\s*:\s*([^\]\n]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = cleanLine(m[1]);
    if (s.length > 1) out.push(s);
  }
  return out;
}

function extractPermitNumber(text) {
  const m =
    text.match(/\bPermit Number:\s*([A-Z0-9-]{6,})\b/i) ||
    text.match(/\bPermit Number\s+([A-Z0-9-]{6,})\b/i);
  return m ? m[1] : null;
}

function pickBestAnchor(candidates, kind) {
  const list = candidates.map((c) => cleanLine(c)).filter((c) => c.length > 1);
  if (!list.length) return null;
  let best = list[0];
  let bestSc = scoreAnchorText(best, kind);
  for (let k = 1; k < list.length; k++) {
    const sc = scoreAnchorText(list[k], kind);
    if (sc > bestSc) {
      bestSc = sc;
      best = list[k];
    }
  }
  return best;
}

function extractOrigin(text) {
  const norm = normalizeWs(text);
  const candidates = [];
  candidates.push(...extractLoadedBracketField(norm, "Origin"));

  const lines = norm.split("\n").map(cleanLine).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The `[Loaded Route Origin: …]` line is captured separately; skip it here so the unanchored
    // "Origin:" match doesn't latch onto the bracket and swallow the glued turn-table rows.
    if (/\[\s*Loaded\s+Route/i.test(line)) continue;
    if (!/\bOrigin\s*:/i.test(line)) continue;
    const afterColon = line.replace(/^.*?\bOrigin\s*:/i, "").trim();
    let chunk = afterColon;
    const inlineDest = /\bDestination\s*:/i.exec(chunk);
    if (inlineDest) {
      chunk = chunk.slice(0, inlineDest.index).replace(/[,;]\s*$/, "").trim();
    }
    const parts = [];
    if (chunk) parts.push(chunk);
    let j = i + 1;
    while (j < lines.length) {
      const L = lines[j];
      if (ORIGIN_BLOCK_STOP.test(L)) break;
      if (isNarrativeBlockBoundary(L)) break;
      if (/^\s*Origin\s*:/i.test(L)) break;
      parts.push(L);
      j++;
    }
    const block = stripTrailingPermitTime(cleanLine(parts.join(" ")));
    if (block.length > 1) candidates.push(block);
  }

  const best = pickBestAnchor(candidates, "origin");
  return best ? normalizeCommonOcrTypos(best) : null;
}

function extractDestination(text) {
  const norm = normalizeWs(text);
  const candidates = [];
  candidates.push(...extractLoadedBracketField(norm, "Destination"));

  const lines = norm.split("\n").map(cleanLine).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\[\s*Loaded\s+Route/i.test(line)) continue;
    if (!/^\s*(?:Final\s+)?Destination\s*:/i.test(line)) continue;
    const afterColon = line.replace(/^.*?\b(?:Final\s+)?Destination\s*:/i, "").trim();
    const parts = [];
    if (afterColon) parts.push(afterColon);
    let j = i + 1;
    while (j < lines.length) {
      const L = lines[j];
      if (DEST_BLOCK_STOP.test(L)) break;
      if (isNarrativeBlockBoundary(L)) break;
      if (/^\s*(?:Final\s+)?Destination\s*:/i.test(L)) break;
      parts.push(L);
      j++;
    }
    const block = stripTrailingPermitTime(cleanLine(parts.join(" ")));
    if (block.length > 1) candidates.push(block);
  }

  const best = pickBestAnchor(candidates, "dest");
  return best ? normalizeCommonOcrTypos(best) : null;
}

function isNoise(line) {
  if (!line) return true;
  if (/^\s*Texas\s+Oversize\/Overweight\b/i.test(line)) return true;
  if (/^\s*PAGE\s+\d+\s+of\s+\d+\b/i.test(line)) return true;
  if (/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/i.test(line)) return true;
  if (/^\s*General Conditions(?:\(Continued\))?\s*:/i.test(line)) return true;
  if (/^\s*Name:\s+.+Permit Number/i.test(line)) return true;
  return false;
}

/**
 * TxDMV turn-table header. `pdf-parse` frequently drops the inter-column spaces, so the header
 * arrives as `MilesRouteToDistanceEst. Time`; tolerate optional whitespace between the words.
 */
const TABLE_HEADER_RE = /^\s*Miles\s*Route\s*To/i;

function isTableHeader(line) {
  return TABLE_HEADER_RE.test(line);
}

function isTableRowStart(line) {
  return /^\s*(?:<\s*[\d.]+|[\d.]+)\s+\S/.test(line);
}

function isLikelyTableContinuation(line) {
  if (!line) return false;
  if (isNoise(line)) return false;
  if (isTableHeader(line)) return false;
  if (/^\s*(Origin|Destination|Final Destination)\s*:/i.test(line)) return false;
  if (/^\s*\[Loaded Route/i.test(line)) return false;
  if (/^\s*\*\*/.test(line)) return false;
  if (isTableRowStart(line)) return false;
  return true;
}

const MANEUVER_VERBS =
  "Turn left|Turn right|Continue straight|Continue|Merge|Take|Bear left|Bear right|Bear|Arrive|DETOUR";

/**
 * `pdf-parse` concatenates the turn-table cells with no spaces, e.g.
 * `<miles><route> <dir><maneuver> ... <distance><time>`. Reconstruct the canonical
 * space-separated row the rest of the parser expects. Idempotent for already-spaced text.
 */
function repairTableRowSpacing(line) {
  let s = cleanLine(line);
  // 1) Split a glued trailing "<distance><HH:MM>" (e.g. "se0.6000:00" -> "se 0.60 00:00").
  s = s.replace(/(\d+\.\d{2})(\d{1,2}:\d{2})\s*$/, " $1 $2");
  // 2) Insert a space before the maneuver verb when glued to the route/direction cell
  //    (e.g. "nTurn" -> "n Turn", "seBear" -> "se Bear", "eTake" -> "e Take").
  s = s.replace(new RegExp(`([A-Za-z0-9.\\]])(${MANEUVER_VERBS})\\b`), "$1 $2");
  // 3) Split the leading miles token from the route cell
  //    ("0.60US123" -> "0.60 US123", "< 0.1IH20SFR" -> "< 0.1 IH20SFR").
  s = s.replace(/^(<\s*)?(\d+(?:\.\d+)?)(?=[A-Za-z])/, (_m, lt, num) => `${lt ? "< " : ""}${num} `);
  return cleanLine(s);
}

function extractTurnTableBlock(text) {
  const lines = normalizeWs(text).split("\n").map(cleanLine);

  let hdrIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isTableHeader(lines[i] || "")) {
      hdrIdx = i;
      break;
    }
  }
  if (hdrIdx < 0) return [];

  let start = hdrIdx;
  if (hdrIdx > 0 && /^\s*Origin\s*:/i.test(lines[hdrIdx - 1] || "")) {
    start = hdrIdx - 1;
  }

  const out = [];
  let milesHeaderSeen = false;

  for (let j = start; j < lines.length; j++) {
    const rawLine = lines[j];
    if (!rawLine) continue;
    if (/^\s*Texas\s+Oversize\b/i.test(rawLine)) continue;
    if (/PAGE\s+\d+\s+of\s+\d+/i.test(rawLine)) continue;
    if (/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/i.test(rawLine)) continue;

    if (isTableHeader(rawLine)) {
      if (milesHeaderSeen) continue;
      milesHeaderSeen = true;
    }

    if (isNoise(rawLine)) continue;

    const line = repairTableRowSpacing(rawLine);
    out.push(line);

    if (/Arrive at destination/i.test(line)) break;
    if (/^\s*Final Destination\s*:/i.test(line)) break;
  }

  const merged = [];
  for (const line of out) {
    if (isLikelyTableContinuation(line) && merged.length) {
      merged[merged.length - 1] = cleanLine(`${merged[merged.length - 1]} ${line}`);
    } else {
      merged.push(line);
    }
  }

  return merged;
}

function parseLeadingLegMiles(line) {
  const m = /^\s*(?:<\s*([\d.]+)|([\d.]+))\s+/.exec(line);
  if (!m) return null;
  const v = parseFloat(m[1] || m[2]);
  return Number.isFinite(v) ? v : null;
}

/** Strip " … 4.60 00:05" style trailing odometer + est. time from a merged table row. */
function stripTrailingOdometerTime(s) {
  const t = cleanLine(s);
  const m = /\s+([\d.]+)\s+(\d{1,2}:\d{2})\s*$/i.exec(t);
  if (!m) {
    return { body: t, odometer: null, estTime: null };
  }
  const odom = parseFloat(m[1]);
  return {
    body: cleanLine(t.slice(0, m.index)),
    odometer: Number.isFinite(odom) ? odom : null,
    estTime: m[2],
  };
}

function stripLeadingLegPrefix(line) {
  const leg = parseLeadingLegMiles(line);
  if (leg == null) {
    return { leg: null, rest: cleanLine(line) };
  }
  const rest = cleanLine(line.replace(/^\s*(?:<\s*[\d.]+|[\d.]+)\s+/, ""));
  return { leg, rest };
}

function parseDirectionAbbrev(dir) {
  if (!dir) return null;
  const k = dir.toLowerCase();
  const map = {
    n: "north",
    s: "south",
    e: "east",
    w: "west",
    ne: "northeast",
    nw: "northwest",
    se: "southeast",
    sw: "southwest",
    nb: "north",
    sb: "south",
    eb: "east",
    wb: "west",
    north: "north",
    south: "south",
    east: "east",
    west: "west",
    northeast: "northeast",
    northwest: "northwest",
    southeast: "southeast",
    southwest: "southwest",
  };
  return map[k] || null;
}

function findRoadToken(str) {
  const hay = normalizeHyphensForMatching(normalizeCommonOcrTypos(str));
  const hws = findHighwaysOnLine(hay);
  return hws.length ? hws[0].text : null;
}

function extractRoadsFromJunctionBlob(blob) {
  const b = cleanLine(blob);
  if (!b) return [];
  let parts = b.split(/\s*&\s*/).map((p) => cleanLine(p)).filter(Boolean);
  /** OCR / typography sometimes uses "and" instead of "&" between road names */
  if (parts.length < 2 && /\band\b/i.test(b)) {
    parts = b.split(/\s+and\s+/i).map((p) => cleanLine(p)).filter(Boolean);
  }
  const roads = [];
  for (const p of parts) {
    const t = findRoadToken(p);
    if (t) roads.push(t);
    else {
      const n = normalizeRouteToken(p);
      const t2 = findRoadToken(n);
      if (t2) roads.push(t2);
    }
  }
  return dedupeStrings(roads);
}

/** Parse the route token before the offset clause in a loaded-route origin. */
function parseLoadedRouteRoadFromOriginPrefix(raw) {
  const t = cleanLine(raw);
  if (!t) return null;
  const tok = findRoadToken(t);
  if (tok) return tok;
  const n = normalizeRouteToken(t);
  const t2 = findRoadToken(n);
  return t2 || (n.length > 2 && n.length < 56 ? n : null);
}

/** County / city tokens from the origin block — narrows duplicate highway numbers at geocode time. */
function extractOriginPlaceHints(origin) {
  const o = normalizeCommonOcrTypos(origin);
  if (!o) return [];
  const hints = new Set();
  const countyRe = /\b([A-Za-z][A-Za-z\s]{1,40}?)\s+County\b/gi;
  let m;
  while ((m = countyRe.exec(o)) !== null) {
    const name = cleanLine(m[1]);
    if (name.length > 2 && name.length < 42 && !/\b(?:the|and|or)\b/i.test(name)) {
      hints.add(`${name} County`);
    }
  }
  const cityTx = /\b([A-Za-z][A-Za-z\s]{1,30}?)\s*,\s*TX\b/gi;
  while ((m = cityTx.exec(o)) !== null) {
    const name = cleanLine(m[1]);
    if (name.length > 2 && name.length < 36 && !/\bCounty\b/i.test(name)) hints.add(name);
  }
  return dedupeStrings([...hints]);
}

function expandOriginQueriesWithPlaceHints(queries, hints) {
  if (!hints.length) return dedupeStrings(queries);
  const out = [...queries];
  for (const q of queries) {
    const qt = q.trim();
    if (!qt) continue;
    for (const h of hints) {
      const hint = cleanLine(h);
      if (!hint) continue;
      if (/\bTexas\b/i.test(qt)) {
        out.push(qt.replace(/\bTexas\b/i, `${hint} Texas`));
      } else {
        out.push(`${qt} ${hint}`);
      }
    }
  }
  return dedupeStrings(out);
}

/** Generic Tx permit junction anchor: junction + mile offset, semicolon triples, or state-line phrasing. */
function parseJunctionStructured(narrative) {
  const o = normalizeCommonOcrTypos(narrative);
  const place_hints = extractOriginPlaceHints(o);
  if (!o) {
    return { mode: "unknown", offset_mi: null, bearing: null, roads: [], place_hints };
  }

  const reJunction =
    /^(?:([^,]+?)\s*,\s*)?([\d.]+)\s*mi(?:le)?s?\s+(nb|sb|eb|wb|[nsew]{1,2}|north|south|east|west|northeast|northwest|southeast|southwest)\s+of\s+(.+)$/i;
  const mj = reJunction.exec(o);
  if (mj) {
    const offset_mi = parseFloat(mj[2]);
    const bearing = parseDirectionAbbrev(mj[3]);
    const junctionBlob = cleanLine(mj[4]);
    let loaded_route_road = null;
    if (mj[1]) {
      loaded_route_road = parseLoadedRouteRoadFromOriginPrefix(mj[1]);
    }
    let roads = extractRoadsFromJunctionBlob(junctionBlob);
    /** Some business-route junctions can normalize to one token; pair with loaded route when needed. */
    if (roads.length < 2 && loaded_route_road) {
      if (roads.length === 1) {
        roads = dedupeStrings([loaded_route_road, roads[0]]);
      } else if (roads.length === 0 && /\s*&\s*/.test(junctionBlob)) {
        const parts = junctionBlob.split(/\s*&\s*/).map((p) => cleanLine(p)).filter(Boolean);
        const rhs = parts.length > 1 ? parts[parts.length - 1] : "";
        const tok =
          findRoadToken(rhs) ||
          findRoadToken(normalizeRouteToken(rhs)) ||
          (cleanLine(normalizeRouteToken(rhs)).length > 1 ? cleanLine(normalizeRouteToken(rhs)) : "");
        if (tok) roads = dedupeStrings([loaded_route_road, tok]);
      }
    }
    return {
      mode: "junction_offset",
      offset_mi: Number.isFinite(offset_mi) ? offset_mi : null,
      bearing,
      roads,
      loaded_route_road,
      place_hints,
    };
  }

  if (/;/.test(o)) {
    const segs = o.split(/;/).map((s) => cleanLine(s)).filter(Boolean);
    const roads = [];
    for (const s of segs) {
      const t = findRoadToken(s);
      roads.push(t ? t : normalizeRouteToken(s));
    }
    return {
      mode: "semicolon",
      offset_mi: null,
      bearing: null,
      roads: dedupeStrings(roads),
      place_hints,
    };
  }

  const reLine =
    /\b(?:IH|I|BI|BU|US|SH|FM)\s*[-–]?\s*0*(\d{1,4}[A-Za-z]?)\s+(OK|NM|LA|AR)\s+Line\b/i;
  if (reLine.test(o)) {
    const tok = findRoadToken(o);
    return {
      mode: "state_line",
      offset_mi: null,
      bearing: null,
      roads: tok ? [tok] : [],
      place_hints,
    };
  }

  return { mode: "unknown", offset_mi: null, bearing: null, roads: [], place_hints };
}

function structuredJunctionQueries(s) {
  const q = [];
  if (s.mode === "junction_offset" && s.roads.length >= 2) {
    const [a, b] = [s.roads[0], s.roads[1]];
    const aT = cleanLine(a);
    const bT = cleanLine(b);
    const buLeg = /^BU\s/i.test(aT) ? aT : /^BU\s/i.test(bT) ? bT : null;
    const otherLeg = buLeg === aT ? bT : aT;
    if (buLeg && /^FM\s/i.test(otherLeg)) {
      const bm = /^BU\s+(\d{1,4})/i.exec(buLeg);
      const fm = /^FM\s+(\d{1,4})/i.exec(otherLeg);
      if (bm && fm) {
        q.push(
          `Farm to Market Road ${fm[1]} and U.S. Highway ${bm[1]} Business intersection Texas`,
          `U.S. Highway ${bm[1]} Business and Farm to Market Road ${fm[1]} intersection Texas`,
        );
      }
    }
    const off = s.offset_mi != null && Number.isFinite(s.offset_mi) ? s.offset_mi : null;
    const bear = s.bearing || "";
    /**
     * Start pin is the **crossing** of the two roads after "of" (e.g. BU 287P & FM 1187). List plain
     * intersection queries first; offset-from-junction strings are secondary for tools that search verbatim.
     */
    q.push(`${a} and ${b} intersection Texas`);
    q.push(`${b} and ${a} intersection Texas`);
    q.push(`${a} ${b} junction Texas`);
    /** Permit narrative: offset along/across from that intersection in `bear`. */
    if (off != null && bear) {
      q.push(`${off} miles ${bear} of ${a} and ${b} intersection Texas`);
      q.push(`${off} miles ${bear} of ${a} and ${b} junction Texas`);
      q.push(`${a} and ${b} intersection ${off} miles ${bear} Texas`);
    }
    if (s.loaded_route_road && off != null && bear) {
      q.push(`${s.loaded_route_road} ${bear} ${off} miles from ${a} and ${b} intersection Texas`);
      q.push(`${s.loaded_route_road} ${bear} ${off} miles from ${a} and ${b} junction Texas`);
    }
    if (bear && off != null) {
      q.push(`${a} ${bear} ${off} miles from ${b} Texas`);
      q.push(`${a} from ${b} ${bear} Texas`);
    }
  }
  if (s.mode === "semicolon" && s.roads.length) {
    q.push(`${s.roads.join(" ")} Texas`);
    if (s.roads.length >= 2) {
      q.push(`${s.roads[0]} ${s.roads[s.roads.length - 1]} Texas`);
    }
  }
  if (s.mode === "state_line" && s.roads.length) {
    q.push(`${s.roads[0]} Texas state line`);
    q.push(`${s.roads[0]} Texas border`);
  }
  return expandOriginQueriesWithPlaceHints(dedupeStrings(q), s.place_hints ?? []);
}

function collectJunctionWarnings(s, kind) {
  const w = [];
  if (s.mode === "junction_offset" && s.roads.length < 2) {
    w.push(`${kind}_junction_incomplete`);
  }
  if (s.mode === "state_line" && !s.roads.length) {
    w.push(`${kind}_state_line_no_road`);
  }
  return w;
}

function parseFromRoadAndDir(body) {
  const b = normalizeCommonOcrTypos(body);
  const m =
    /^\s*([A-Za-z0-9\s\-]+?)\s+([nsew]{1,2})\s+(?:Turn|Continue|Merge|Take|Bear|Arrive|DETOUR)\b/i.exec(
      b,
    );
  if (m) {
    return { fromRoad: normalizeRouteToken(m[1].trim()), fromDir: parseDirectionAbbrev(m[2]) };
  }
  const m2 =
    /^\s*((?:[A-Za-z0-9\-]|\/)+)\s+(nb|sb|eb|wb|[nsew]{1,2})\s+(?:Turn|Continue|Merge|Take|Bear|Arrive|DETOUR)\b/i.exec(
      b,
    );
  if (m2) {
    return { fromRoad: normalizeRouteToken(m2[1].trim()), fromDir: parseDirectionAbbrev(m2[2]) };
  }
  const hay = normalizeHyphensForMatching(b);
  const hits = findHighwaysOnLine(hay);
  if (hits.length) {
    const tail = hay.slice(hits[0].end);
    const dm = /^\s*(nb|sb|eb|wb|[nsew]{1,2})\b/i.exec(tail);
    if (dm) {
      return { fromRoad: hits[0].text, fromDir: parseDirectionAbbrev(dm[1]) };
    }
    return { fromRoad: hits[0].text, fromDir: null };
  }
  return { fromRoad: findRoadToken(b), fromDir: null };
}

function parseManeuver(body) {
  const b = normalizeCommonOcrTypos(body).replace(/\bTurn\s+leit\b/gi, "Turn left");
  const m =
    /\b(Turn left|Turn right|Continue straight|Continue Straight|Merge|Take Exit|Take|Bear left|Bear right|Arrive at destination|DETOUR)\b/i.exec(
      b,
    );
  return m ? m[1] : null;
}

function parseToRoadAndDir(body) {
  const b = normalizeCommonOcrTypos(body).replace(/\b(?:toward|towards)\b/gi, "toward");
  // Prefer the explicit target after onto/on/toward; otherwise fall back to the road named directly
  // after a bare "Take"/"Merge" maneuver (e.g. "Take SH137 Ramp se", "Take IH20 Ramp e").
  const m = /\b(?:onto|on|toward)\s+(.+)$/i.exec(b) || /\b(?:Take|Merge)\s+(.+)$/i.exec(b);
  if (!m) return { toRoad: null, toDir: null };
  const tail = m[1];
  const toRoad = findRoadToken(tail);
  const d = /\b([nsew]{1,2})\b/i.exec(tail);
  return { toRoad, toDir: d ? parseDirectionAbbrev(d[1]) : null };
}

function buildStepFromRow(
  row,
  cumulativeBefore,
) {
  const rawNorm = normalizeCommonOcrTypos(row);
  const { leg, rest: afterLeg } = stripLeadingLegPrefix(rawNorm);
  const afterBracket = cleanLine(afterLeg.replace(/^\[[^\]]+\]\s*/, ""));
  const { body, odometer, estTime } = stripTrailingOdometerTime(afterBracket);
  const normBody = normalizeCommonOcrTypos(body).replace(/\bTurn\s+leit\b/gi, "Turn left");

  const { fromRoad, fromDir } = parseFromRoadAndDir(normBody);
  const maneuver = parseManeuver(normBody);
  const { toRoad, toDir } = parseToRoadAndDir(normBody);

  const computedAfter = leg != null ? cumulativeBefore + leg : cumulativeBefore;

  let odometerWarn = null;
  if (
    leg != null &&
    odometer != null &&
    Number.isFinite(cumulativeBefore + leg) &&
    Math.abs(cumulativeBefore + leg - odometer) > ODOMETER_TOLERANCE_MI
  ) {
    odometerWarn = `odometer_mismatch expected ~${(cumulativeBefore + leg).toFixed(2)} mi got ${odometer.toFixed(2)} mi`;
  }

  return {
    step: {
      leg_miles: leg,
      permit_odometer_mi: odometer,
      estimated_time: estTime,
      cumulative_mi: leg != null ? computedAfter : null,
      from_road: fromRoad,
      from_dir: fromDir,
      maneuver,
      to_road: toRoad,
      to_dir: toDir,
      raw_row: row,
    },
    cumulativeAfter: odometer != null ? odometer : computedAfter,
    odometerWarn,
  };
}

/** Collapse ramp / service-road qualifiers so "IH 20 Ramp"/"IH 20 SFR" reduce to the mainline "IH 20". */
function baseHighway(road) {
  if (!road) return null;
  const b = cleanLine(road.replace(/\s+(Ramp|SFR|Service\s+Road|Frontage)\b.*$/i, ""));
  return b || null;
}

/** Intersection-style geocode queries for the crossing of two highways `a` and `b`. */
function buildIntersectionQueries(a, b) {
  const q = [
    `${a} and ${b} intersection Texas`,
    `${b} and ${a} intersection Texas`,
    `${a} ${b} junction Texas`,
  ];
  const spoken = (road, other) => {
    const fm = /^FM\s+(\d{1,4})/i.exec(road);
    if (fm) q.push(`Farm to Market Road ${fm[1]} and ${other} Texas`);
    const rm = /^RM\s+(\d{1,4})/i.exec(road);
    if (rm) q.push(`Ranch Road ${rm[1]} and ${other} Texas`);
  };
  spoken(a, b);
  spoken(b, a);
  return dedupeStrings(q);
}

/**
 * A waypoint at the crossing of the road being left (`a`) and the road being taken (`b`). These
 * road×road intersections are precise, localizable points in route order — unlike a bare highway
 * name, which geocodes to one arbitrary point along the whole route.
 */
function makeTurnWaypoint(
  a,
  b,
  dir,
  odo,
  leg,
) {
  const odoLabel = odo != null && Number.isFinite(odo) ? ` · ~${odo.toFixed(1)} mi` : "";
  return {
    label: "Turn",
    text: `${a} & ${b}`,
    displayText: cleanLine(`${a} → ${b}${odoLabel}`),
    roads: [a, b],
    dir_hint: dir || null,
    queries: dedupeStrings([
      ...buildIntersectionQueries(a, b),
      `${b} ${dir || ""} Texas`.trim(),
      `${b} highway Texas`,
      `${b} Texas`,
    ]),
    leg_miles_to_next: leg ?? null,
    cumulative_permit_mi: odo ?? null,
  };
}

/**
 * Reduce the per-row steps to the ordered set of mainline turn points: each time the highway you
 * are travelling on changes (ignoring ramps/service roads), emit the crossing of the old and new
 * highway. The odometer carried is the running total at that transition.
 */
function buildTurnWaypoints(steps) {
  const out = [];
  let prevBase = null;
  let prevOdo = null;
  for (const st of steps) {
    const base = baseHighway(st.from_road);
    const odo = st.permit_odometer_mi ?? st.cumulative_mi;
    if (!base) {
      if (odo != null) prevOdo = odo;
      continue;
    }
    if (prevBase && base.toLowerCase() !== prevBase.toLowerCase()) {
      out.push(makeTurnWaypoint(prevBase, base, st.from_dir, prevOdo, st.leg_miles));
    }
    prevBase = base;
    if (odo != null) prevOdo = odo;
  }
  return out;
}

export function parsePermitText(rawText) {
  const fullText = normalizeWs(rawText || "");
  const permit_number = extractPermitNumber(fullText);

  const parse_text = fullText;
  let origin_text = extractOrigin(fullText);
  let destination_text = extractDestination(fullText);

  const rows = extractTurnTableBlock(fullText)
    .filter((line) => {
      if (isTableHeader(line)) return false;
      if (/^\s*Origin\s*:/i.test(line)) return false;
      const norm = normalizeHyphensForMatching(normalizeCommonOcrTypos(line)).replace(
        /\bTurn\s+leit\b/gi,
        "Turn left",
      );
      return (
        isTableRowStart(norm) &&
        /\b(Turn|Continue|Merge|Take|Bear|Arrive at destination|DETOUR)\b/i.test(norm)
      );
    });

  const steps = [];
  const segments = [];
  const warnings = [];

  let cumulative = 0;

  for (const row of rows) {
    const { step, cumulativeAfter, odometerWarn } = buildStepFromRow(row, cumulative);
    if (odometerWarn) warnings.push(odometerWarn);
    cumulative = cumulativeAfter;
    steps.push(step);
  }

  segments.push(...buildTurnWaypoints(steps));

  if (!destination_text && steps.length > 0) {
    const last = steps[steps.length - 1];
    if (last?.maneuver && /Arrive\s+at\s+destination/i.test(last.maneuver)) {
      const endR = last.to_road || last.from_road;
      if (endR) {
        destination_text = endR;
        warnings.push("destination_inferred_from_arrive_row");
      }
    }
  }

  const origin_structured = origin_text ? parseJunctionStructured(origin_text) : null;
  if (origin_structured) {
    warnings.push(...collectJunctionWarnings(origin_structured, "origin"));
  }

  const destination_structured = destination_text ? parseJunctionStructured(destination_text) : null;
  if (destination_structured) {
    warnings.push(...collectJunctionWarnings(destination_structured, "destination"));
  }

  const narrativeOrigin = origin_text;

  if (narrativeOrigin) {
    const structuredQ = origin_structured ? structuredJunctionQueries(origin_structured) : [];
    const originRoad = findRoadToken(narrativeOrigin);
    const fullO = narrativeOrigin.trim();
    const originPrimary = cleanLine(
      origin_structured?.loaded_route_road || originRoad || fullO.slice(0, 96),
    );
    const originRoads =
      origin_structured && origin_structured.roads.length >= 2
        ? [origin_structured.roads[0], origin_structured.roads[1]]
        : undefined;
    segments.unshift({
      label: "Origin",
      text: originPrimary,
      displayText: `Start · ${fullO.slice(0, 220)}`,
      dir_hint: origin_structured?.bearing || null,
      roads: originRoads,
      queries: dedupeStrings([
        ...structuredQ,
        `${fullO} Texas`,
        `${fullO} TX`,
        `${fullO} United States`,
        ...(originRoad ? [`${originRoad} Texas`, `${originRoad} highway Texas`] : []),
      ]),
    });
  } else if (steps.length > 0 && steps[0].from_road) {
    const s0 = steps[0];
    const oRoad = s0.from_road;
    origin_text = oRoad;
    warnings.push("origin_inferred_from_first_table_row");
    segments.unshift({
      label: "Origin",
      text: oRoad,
      displayText: `Start · ${s0.raw_row}`.slice(0, 240),
      dir_hint: s0.from_dir || null,
      queries: dedupeStrings([
        `${oRoad} ${s0.from_dir || ""} Texas`.trim(),
        `${oRoad} Texas`,
        `${oRoad} highway Texas`,
      ]),
    });
  }

  if (destination_text) {
    const structuredQ = destination_structured ? structuredJunctionQueries(destination_structured) : [];
    const destinationRoad = findRoadToken(destination_text);
    const fullD = destination_text.trim();
    const destPrimary = cleanLine(
      destination_structured?.loaded_route_road || destinationRoad || fullD.slice(0, 96),
    );
    const destRoads =
      destination_structured && destination_structured.roads.length >= 2
        ? [destination_structured.roads[0], destination_structured.roads[1]]
        : undefined;
    segments.push({
      label: "Destination",
      text: destPrimary,
      displayText: `End · ${fullD.slice(0, 220)}`,
      dir_hint: destination_structured?.bearing || null,
      roads: destRoads,
      queries: dedupeStrings([
        ...structuredQ,
        ...(destinationRoad ? [`${destinationRoad} Texas`, `${destinationRoad} highway Texas`] : []),
        `${fullD} Texas`,
        `${fullD} TX`,
        `${fullD} United States`,
      ]),
    });
  }

  if (segments.length && steps.length > 0) {
    const oSeg = segments[0];
    if (oSeg?.label === "Origin") {
      const st = narrativeOrigin || "";
      const weak =
        st.length > 0 &&
        (st.length < 14 ||
          (!/\d/.test(st) && !/\b(US|SH|FM|RM|IH|BI|BU|CR)\s*[-–]?\s*\d/i.test(st)));
      if (weak && steps[0]?.from_road) {
        const s0 = steps[0];
        const fr = s0.from_road;
        const q = `${fr} ${s0.from_dir || ""} Texas`.trim();
        oSeg.queries = dedupeStrings([q, `${fr} Texas`, ...(oSeg.queries || [])]);
        if (!findRoadToken(st) || st.length < 12) {
          oSeg.text = fr;
        }
        if (s0.from_dir) oSeg.dir_hint = s0.from_dir;
      }
    }
    const dSeg = segments[segments.length - 1];
    if (dSeg?.label === "Destination" && steps.length) {
      const fullD = destination_text || "";
      const weakD =
        fullD.length > 0 &&
        (fullD.length < 10 ||
          (!/\d/.test(fullD) && !/\b(US|SH|FM|RM|IH|BI|BU)\s*[-–]?\s*\d/i.test(fullD)));
      const last = steps[steps.length - 1];
      if (weakD && last) {
        const endR = last.to_road || last.from_road;
        if (endR) {
          const endD = last.to_dir || last.from_dir || "";
          const q = `${endR} ${endD} Texas`.trim();
          dSeg.queries = dedupeStrings([q, `${endR} Texas`, ...(dSeg.queries || [])]);
          if (!findRoadToken(fullD) || fullD.length < 8) {
            dSeg.text = endR;
          }
          if (endD) dSeg.dir_hint = endD;
        }
      }
    }
  }

  return {
    parse_text,
    permit_number,
    origin_text,
    destination_text,
    parser_version: PARSER_VERSION,
    steps,
    segments,
    origin_structured: origin_structured ?? null,
    destination_structured: destination_structured ?? null,
    warnings,
  };
}

