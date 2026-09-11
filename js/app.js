import { parsePermitText, PARSER_VERSION as TX_PARSER_VERSION } from "./tx-permit-parser.js";
import { inspectPermitFile, fileKind } from "./ocr.js";
import {
  initMap,
  hasMap,
  clearMapOverlays,
  drawPermitRoute,
  setSatellite,
  isSatellite,
  setMapState,
} from "./map.js";
import { extractPermitId, fetchTxprosPermit, dirsToText, txprosUrl } from "./txpros.js";
import { parseOkPermitText, OK_PARSER_VERSION, looksLikeOkPermit } from "./ok-permit-parser.js";
import { buildOkRoute } from "./ok-route.js";

const MAPBOX_TOKEN =
  "pk.eyJ1Ijoic2VhbmxlZTkyIiwiYSI6ImNtZTAyeG0wbzAwamgybHE2cmwzenJtM2cifQ.DE8FeoDvc3EzuyR5uPopzA";

const el = {
  stateSelect: document.getElementById("stateSelect"),
  brandTitle: document.getElementById("brandTitle"),
  uploadBtn: document.getElementById("uploadBtn"),
  fileInput: document.getElementById("fileInput"),
  fileLabel: document.getElementById("fileLabel"),
  parseBtn: document.getElementById("parseBtn"),
  preview: document.getElementById("preview"),
  previewImg: document.getElementById("previewImg"),
  permitId: document.getElementById("permitId"),
  routeBtn: document.getElementById("routeBtn"),
  satBtn: document.getElementById("satBtn"),
  permitText: document.getElementById("permitText"),
  reparseBtn: document.getElementById("reparseBtn"),
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
  steps: document.getElementById("steps"),
  resultPanel: document.getElementById("resultPanel"),
  parserVersion: document.getElementById("parserVersion"),
  txprosLink: document.getElementById("txprosLink"),
  txFallback: document.getElementById("txFallback"),
};

let selectedFile = null;
let lastParse = null; // TX turntable or OK parse
let lastTxpros = null;
let lastOkRoute = null;
let busy = false;

function currentState() {
  return el.stateSelect.value === "OK" ? "OK" : "TX";
}

function say(msg, kind = "info") {
  el.status.textContent = msg;
  el.status.dataset.kind = kind;
}

function ensureMap() {
  if (!hasMap()) initMap(MAPBOX_TOKEN, "map", { state: currentState() });
  return MAPBOX_TOKEN;
}

function setPermitId(id) {
  if (!id) return;
  el.permitId.value = id;
  el.txprosLink.href = txprosUrl(id);
  el.txprosLink.hidden = false;
}

function syncButtons() {
  const st = currentState();
  const canParse =
    !busy &&
    (selectedFile || (st === "TX" && el.permitId.value.trim()));
  el.parseBtn.disabled = !canParse;

  const hasRoute =
    st === "TX"
      ? Boolean(lastTxpros?.route?.coordinates?.length)
      : Boolean(lastOkRoute?.coordinates?.length || lastParse?.ok);
  el.routeBtn.disabled = busy || !hasRoute;
}

function clearResultState() {
  lastParse = null;
  lastTxpros = null;
  lastOkRoute = null;
  el.permitText.value = "";
  el.meta.innerHTML = "";
  el.steps.innerHTML = "";
  document.getElementById("okWarn")?.remove();
  el.resultPanel.hidden = true;
  el.txprosLink.hidden = true;
  syncButtons();
}

function clearAll() {
  selectedFile = null;
  el.fileInput.value = "";
  el.fileLabel.textContent = "No file selected";
  el.preview.hidden = true;
  el.previewImg.removeAttribute("src");
  el.permitId.value = "";
  clearResultState();
  if (hasMap()) {
    clearMapOverlays();
    setMapState(currentState());
  }
}

function applyStateUi() {
  const st = currentState();
  el.brandTitle.textContent = st === "OK" ? "Oklahoma Permit Parser" : "Texas Permit Parser";
  el.parserVersion.textContent = st === "OK" ? OK_PARSER_VERSION : TX_PARSER_VERSION;
  el.txFallback.hidden = st !== "TX";
  clearAll();
  say(
    st === "OK"
      ? "Oklahoma: 1) Upload ODOT PDF · 2) Parse · 3) Show on map"
      : "Texas: 1) Upload TxDMV PDF · 2) Parse · 3) Show on map",
  );
}

el.stateSelect.addEventListener("change", () => {
  applyStateUi();
  try {
    ensureMap();
    setMapState(currentState());
  } catch (err) {
    say(err.message, "error");
  }
});

el.uploadBtn.addEventListener("click", () => {
  el.fileInput.click();
});

el.fileInput.addEventListener("change", () => {
  const file = el.fileInput.files?.[0] || null;
  if (!file) return;
  selectFile(file);
});

function selectFile(file) {
  const kind = fileKind(file);
  if (kind === "heic") return say("Use JPEG/PNG, not HEIC.", "error");
  if (kind === "unknown") return say("Upload a JPEG/PNG or PDF.", "error");

  selectedFile = file;
  clearResultState();
  el.fileLabel.textContent = file.name;

  if (kind === "image") {
    const url = URL.createObjectURL(file);
    el.previewImg.onload = () => URL.revokeObjectURL(url);
    el.previewImg.src = url;
    el.preview.hidden = false;
  } else {
    el.preview.hidden = true;
    el.previewImg.removeAttribute("src");
  }

  syncButtons();
  say(`Ready: ${file.name}. Click Parse.`, "ok");
}

async function runParse() {
  if (busy) return;
  if (currentState() === "OK") return runParseOk();
  return runParseTx();
}

async function runParseTx() {
  const manualId = extractPermitId(el.permitId.value);
  if (!selectedFile && !manualId) {
    return say("Upload a Texas permit PDF first, or enter a Permit ID.", "warn");
  }

  busy = true;
  syncButtons();
  try {
    let permitId = manualId;

    if (selectedFile) {
      const inspected = await inspectPermitFile(selectedFile, {
        onStatus: (m) => say(m),
      });

      el.permitText.value = inspected.text || "";
      if (inspected.text) {
        lastParse = parsePermitText(inspected.text);
      }

      permitId =
        inspected.permitId ||
        extractPermitId(inspected.text || "") ||
        extractPermitId(el.permitId.value);
    }

    if (permitId) {
      await loadOfficialRoute(permitId);
      return;
    }

    if (lastParse?.segments?.length) {
      renderTx(lastParse, null);
      el.resultPanel.hidden = false;
      say(
        "Could not find TxPROS QR/Permit ID. Enter a Permit ID under Manual Permit ID, then Parse again.",
        "warn",
      );
    } else {
      say("Could not read a TxPROS ID from that upload. Try the original TxDMV PDF.", "error");
    }
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
    syncButtons();
  }
}

async function runParseOk() {
  if (!selectedFile) {
    return say("Upload an Oklahoma permit PDF first.", "warn");
  }

  busy = true;
  lastOkRoute = null;
  syncButtons();
  try {
    const inspected = await inspectPermitFile(selectedFile, {
      onStatus: (m) => say(m),
      fullText: true,
    });
    el.permitText.value = inspected.text || "";

    if (!inspected.text?.trim()) {
      say("Could not read text from that PDF. Try the original ODOT permit PDF.", "error");
      return;
    }

    if (!looksLikeOkPermit(inspected.text)) {
      say("This does not look like an Oklahoma ODOT permit. Check the State dropdown.", "warn");
    }

    lastParse = parseOkPermitText(inspected.text);
    renderOk(lastParse);

    if (!lastParse.ok) {
      say(lastParse.errors.join(" ") || "Could not parse Oklahoma permit.", "error");
      return;
    }

    const coordNote =
      lastParse.origin?.has_coords && lastParse.destination?.has_coords
        ? "PDF coords"
        : "will geocode start/end";
    say(
      `Parsed OK permit ${lastParse.permit_number || ""}. ${lastParse.steps.length} steps (${coordNote}). Click Show on map.`,
      "ok",
    );
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
    syncButtons();
  }
}

async function loadOfficialRoute(permitId) {
  setPermitId(permitId);
  say(`Loading official TxDMV route for ${permitId}…`);
  const data = await fetchTxprosPermit(permitId);
  applyTxpros(data);
  say(`Parsed. Route ready (${data.route.point_count} points). Click Show on map.`, "ok");
  return data;
}

function applyTxpros(data) {
  lastTxpros = data;
  setPermitId(String(data.permit_id));
  if (!el.permitText.value.trim() && data.driving_dirs?.length) {
    el.permitText.value = dirsToText(data.driving_dirs);
    lastParse = parsePermitText(el.permitText.value);
  } else if (el.permitText.value.trim() && !lastParse) {
    lastParse = parsePermitText(el.permitText.value);
  }
  renderTx(lastParse, data);
  el.resultPanel.hidden = false;
  syncButtons();
}

function renderTx(result, txpros) {
  el.meta.innerHTML = "";
  el.steps.innerHTML = "";
  const rows = [
    ["Permit #", txpros?.permit_no || result?.permit_number || "—"],
    ["TxPROS ID", txpros?.permit_id || "—"],
    ["Status", txpros?.status || "—"],
    ["From", result?.origin_text || txpros?.driving_dirs?.[0]?.to || "—"],
    ["To", result?.destination_text || txpros?.driving_dirs?.at?.(-1)?.to || "—"],
    ["Points", txpros?.route?.point_count != null ? String(txpros.route.point_count) : "—"],
  ];
  fillMeta(rows);

  const segs = result?.segments || [];
  if (!segs.length && txpros?.driving_dirs?.length) {
    for (const d of txpros.driving_dirs.slice(0, 12)) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="tag">Dir</span><span>${escapeHtml(d.route || "")} ${escapeHtml(d.to || "")}</span>`;
      el.steps.appendChild(li);
    }
    return;
  }
  for (const seg of segs) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="tag">${escapeHtml(seg.label)}</span><span>${escapeHtml(seg.displayText || seg.text)}</span>`;
    el.steps.appendChild(li);
  }
}

function renderOk(parsed) {
  el.meta.innerHTML = "";
  el.steps.innerHTML = "";
  el.resultPanel.hidden = false;
  const fromNote = parsed.origin?.has_coords ? " (coords)" : parsed.origin_text ? " (geocode)" : "";
  const toNote = parsed.destination?.has_coords
    ? " (coords)"
    : parsed.destination_text
      ? " (geocode)"
      : "";
  const miles =
    parsed.expected_miles != null
      ? String(parsed.expected_miles)
      : parsed.approximate_miles != null
        ? String(parsed.approximate_miles)
        : "—";
  const rows = [
    ["Permit #", parsed.permit_number || "—"],
    ["State", "Oklahoma"],
    ["From", (parsed.origin_text || "—") + fromNote],
    ["To", (parsed.destination_text || "—") + toNote],
    ["Miles", miles],
    ["Steps", String(parsed.steps?.length || 0)],
  ];
  fillMeta(rows);

  for (const step of parsed.steps || []) {
    const li = document.createElement("li");
    const tag = step.leg_miles != null ? `${step.leg_miles} mi` : step.label || "Dir";
    li.innerHTML = `<span class="tag">${escapeHtml(String(tag))}</span><span>${escapeHtml(step.instruction)}</span>`;
    el.steps.appendChild(li);
  }
}

function fillMeta(rows) {
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    el.meta.append(dt, dd);
  }
}

el.parseBtn.addEventListener("click", () => {
  runParse();
});

el.reparseBtn?.addEventListener("click", async () => {
  const text = el.permitText.value.trim();
  if (!text) return;

  if (currentState() === "OK") {
    lastParse = parseOkPermitText(text);
    lastOkRoute = null;
    renderOk(lastParse);
    say(
      lastParse.ok
        ? `Re-parsed. ${lastParse.steps.length} steps. Click Show on map.`
        : lastParse.errors.join(" "),
      lastParse.ok ? "ok" : "error",
    );
    syncButtons();
    return;
  }

  lastParse = parsePermitText(text);
  const id = extractPermitId(text) || extractPermitId(el.permitId.value);
  if (id) {
    try {
      busy = true;
      syncButtons();
      await loadOfficialRoute(id);
    } catch (err) {
      say(err.message, "error");
    } finally {
      busy = false;
      syncButtons();
    }
    return;
  }
  renderTx(lastParse, lastTxpros);
  say("Re-parsed text (no TxPROS ID found).", "warn");
});

el.routeBtn.addEventListener("click", async () => {
  if (busy) return;
  if (currentState() === "OK") return showOkMap();
  return showTxMap();
});

async function showTxMap() {
  if (!lastTxpros?.route?.coordinates?.length) {
    return say("Parse a Texas permit first.", "warn");
  }
  busy = true;
  syncButtons();
  try {
    ensureMap();
    clearMapOverlays();
    drawPermitRoute(lastTxpros.route, {
      originLabel: "TxPROS start",
      destLabel: "TxPROS end",
    });
    say(`Mapped official route · ${lastTxpros.route.point_count} points`, "ok");
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
    syncButtons();
  }
}

async function showOkMap() {
  if (!lastParse?.ok) {
    return say("Parse an Oklahoma permit first.", "warn");
  }
  busy = true;
  syncButtons();
  try {
    ensureMap();
    // Always rebuild so turn waypoints refresh with the latest router.
    lastOkRoute = await buildOkRoute(lastParse, MAPBOX_TOKEN, {
      onStatus: (m) => say(m),
    });
    clearMapOverlays();
    drawPermitRoute(lastOkRoute, {
      originLabel: lastParse.origin_text || "Origin",
      destLabel: lastParse.destination_text || "Destination",
      pins: lastOkRoute.pins,
    });
    fillMetaPoints(lastOkRoute.point_count);
    renderOkWarnings(lastOkRoute);

    const pinCount = lastOkRoute.pins?.length || 0;
    const turnCount = lastOkRoute.step_waypoints || Math.max(0, pinCount - 2);
    const conf = lastOkRoute.confidence || "medium";
    const kind = conf === "high" ? "ok" : conf === "medium" ? "warn" : "error";
    say(
      lastOkRoute.explanation ||
        `Mapped Oklahoma route · ${pinCount} pins (${turnCount} turns) · ${conf} confidence.`,
      kind,
    );
  } catch (err) {
    lastOkRoute = null;
    say(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
    syncButtons();
  }
}

function renderOkWarnings(route) {
  document.getElementById("okWarn")?.remove();
  const warnings = route?.warnings || [];
  if (!warnings.length && route?.confidence === "high") return;

  const box = document.createElement("div");
  box.id = "okWarn";
  box.className = `ok-warn ok-warn-${route?.confidence || "medium"}`;
  const conf = (route?.confidence || "medium").toUpperCase();
  const body = warnings.length
    ? warnings
    : ["Best-effort Oklahoma route — verify against the permit directions."];
  box.innerHTML = `<strong>Confidence: ${escapeHtml(conf)}</strong>${body
    .map((w) => `<div>${escapeHtml(w)}</div>`)
    .join("")}`;
  el.resultPanel.appendChild(box);
}

function fillMetaPoints(n) {
  if (!lastParse || currentState() !== "OK") return;
  const fromNote = lastParse.origin?.has_coords ? " (coords)" : lastParse.origin_text ? " (approx)" : "";
  const toNote = lastParse.destination?.has_coords
    ? " (coords)"
    : lastParse.destination_text
      ? " (approx)"
      : "";
  const miles =
    lastOkRoute?.distance_mi != null
      ? `${lastOkRoute.distance_mi.toFixed(1)} mapped / ${lastParse.expected_miles ?? lastParse.approximate_miles ?? "—"} permit`
      : lastParse.expected_miles != null
        ? String(lastParse.expected_miles)
        : lastParse.approximate_miles != null
          ? String(lastParse.approximate_miles)
          : "—";
  el.meta.innerHTML = "";
  fillMeta([
    ["Permit #", lastParse.permit_number || "—"],
    ["State", "Oklahoma"],
    [
      "Confidence",
      lastOkRoute?.confidence === "high"
        ? "HIGH (from permit instructions)"
        : (lastOkRoute?.confidence || "—").toString().toUpperCase(),
    ],
    [
      "From",
      (lastParse.origin_text || "—") +
        fromNote +
        (lastParse.origin?.lat != null
          ? ` [${lastParse.origin.lat.toFixed(5)}, ${lastParse.origin.lng.toFixed(5)}]`
          : ""),
    ],
    [
      "To",
      (lastParse.destination_text || "—") +
        toNote +
        (lastParse.destination?.lat != null
          ? ` [${lastParse.destination.lat.toFixed(5)}, ${lastParse.destination.lng.toFixed(5)}]`
          : ""),
    ],
    ["Miles", miles],
    ["Method", lastOkRoute?.source || "permit-instructions"],
    ["Steps", String(lastParse.steps?.length || 0)],
    [
      "Waypoints",
      lastOkRoute?.pins?.length != null
        ? `${lastOkRoute.pins.length} (start + ${lastOkRoute.step_waypoints ?? Math.max(0, lastOkRoute.pins.length - 2)} steps + end)`
        : "—",
    ],
    ["Points", n != null ? String(n) : "—"],
  ]);
}

el.satBtn.addEventListener("click", () => {
  try {
    ensureMap();
    setSatellite(!isSatellite());
    el.satBtn.textContent = isSatellite() ? "Streets" : "Satellite";
  } catch (err) {
    say(err.message, "error");
  }
});

el.permitId.addEventListener("input", () => {
  syncButtons();
});

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

try {
  initMap(MAPBOX_TOKEN, "map", { state: currentState() });
  applyStateUi();
} catch (err) {
  say(`Map failed: ${err.message}`, "error");
}

syncButtons();
