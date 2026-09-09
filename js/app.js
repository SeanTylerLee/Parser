import { parsePermitText, PARSER_VERSION } from "./tx-permit-parser.js";
import { inspectPermitFile, fileKind } from "./ocr.js";
import { initMap, hasMap, clearMapOverlays, drawTxprosRoute, setSatellite, isSatellite } from "./map.js";
import { extractPermitId, fetchTxprosPermit, dirsToText, txprosUrl } from "./txpros.js";

const STORAGE_MAPBOX = "fleetbord.mapboxToken";
const STORAGE_XAI = "fleetbord.xaiKey";
const DEFAULT_MAPBOX_TOKEN =
  "pk.eyJ1Ijoic2VhbmxlZTkyIiwiYSI6ImNtZTAyeG0wbzAwamgybHE2cmwzenJtM2cifQ.DE8FeoDvc3EzuyR5uPopzA";

const el = {
  mapboxToken: document.getElementById("mapboxToken"),
  xaiKey: document.getElementById("xaiKey"),
  saveKeys: document.getElementById("saveKeys"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  fileInput: document.getElementById("fileInput"),
  dropzone: document.getElementById("dropzone"),
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
};

let lastParse = null;
let lastTxpros = null;
let busy = false;

function say(msg, kind = "info") {
  el.status.textContent = msg;
  el.status.dataset.kind = kind;
}

function getMapboxToken() {
  return (el.mapboxToken.value || localStorage.getItem(STORAGE_MAPBOX) || DEFAULT_MAPBOX_TOKEN).trim();
}

function getXaiKey() {
  return (el.xaiKey.value || localStorage.getItem(STORAGE_XAI) || "").trim();
}

function ensureMap() {
  const token = getMapboxToken();
  if (!token) throw new Error("Add Mapbox token in Settings.");
  if (!hasMap()) initMap(token);
  return token;
}

function setPermitId(id) {
  if (!id) return;
  el.permitId.value = id;
  el.txprosLink.href = txprosUrl(id);
  el.txprosLink.hidden = false;
}

el.settingsBtn.addEventListener("click", () => {
  el.settingsPanel.hidden = !el.settingsPanel.hidden;
});

el.saveKeys.addEventListener("click", () => {
  localStorage.setItem(STORAGE_MAPBOX, el.mapboxToken.value.trim());
  localStorage.setItem(STORAGE_XAI, el.xaiKey.value.trim());
  try {
    initMap(getMapboxToken());
    say("Settings saved.", "ok");
  } catch (err) {
    say(err.message, "error");
  }
});

async function loadOfficialRoute(permitId, { autoMap = true } = {}) {
  setPermitId(permitId);
  say(`Loading official TxDMV route for ${permitId}…`);
  const data = await fetchTxprosPermit(permitId);
  applyTxpros(data);
  if (autoMap) {
    ensureMap();
    clearMapOverlays();
    drawTxprosRoute(data.route);
    say(`Mapped official route · ${data.route.point_count} points`, "ok");
  }
  return data;
}

async function ingestFile(file) {
  if (!file || busy) return;
  const kind = fileKind(file);
  if (kind === "heic") return say("Use JPEG/PNG, not HEIC.", "error");
  if (kind === "unknown") return say("Upload a JPEG/PNG or PDF.", "error");

  busy = true;
  el.routeBtn.disabled = true;
  lastTxpros = null;
  try {
    if (kind === "image") {
      const url = URL.createObjectURL(file);
      el.previewImg.onload = () => URL.revokeObjectURL(url);
      el.previewImg.src = url;
      el.preview.hidden = false;
    } else {
      el.preview.hidden = true;
    }

    const inspected = await inspectPermitFile(file, {
      xaiKey: getXaiKey(),
      onStatus: (m) => say(m),
    });

    el.permitText.value = inspected.text || "";
    if (inspected.text) {
      lastParse = parsePermitText(inspected.text);
    }

    const permitId =
      inspected.permitId ||
      extractPermitId(inspected.text || "") ||
      extractPermitId(el.permitId.value);

    if (permitId) {
      await loadOfficialRoute(permitId, { autoMap: true });
      return;
    }

    // No TxPROS ID found in PDF/photo.
    if (lastParse?.segments?.length) {
      renderParse(lastParse, null);
      el.resultPanel.hidden = false;
      say(
        "Could not find TxPROS QR/Permit ID in that file. The PDF needs the QR code or TxPROS link.",
        "warn",
      );
    } else {
      say("Could not read a TxPROS ID from that upload. Try the original TxDMV PDF.", "error");
    }
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
    el.routeBtn.disabled = !lastTxpros?.route?.coordinates?.length;
  }
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
  renderParse(lastParse, data);
  el.resultPanel.hidden = false;
  el.routeBtn.disabled = !data.route?.coordinates?.length;
}

function renderParse(result, txpros) {
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
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    el.meta.append(dt, dd);
  }

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

el.fileInput.addEventListener("change", () => {
  const f = el.fileInput.files?.[0];
  if (f) ingestFile(f);
});
["dragenter", "dragover"].forEach((evt) =>
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((evt) =>
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove("drag");
  }),
);
el.dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) ingestFile(f);
});

el.reparseBtn?.addEventListener("click", async () => {
  const text = el.permitText.value.trim();
  if (!text) return;
  lastParse = parsePermitText(text);
  const id = extractPermitId(text) || extractPermitId(el.permitId.value);
  if (id) {
    try {
      busy = true;
      await loadOfficialRoute(id, { autoMap: true });
    } catch (err) {
      say(err.message, "error");
    } finally {
      busy = false;
    }
    return;
  }
  renderParse(lastParse, lastTxpros);
  say("Re-parsed text (no TxPROS ID found).", "warn");
});

el.routeBtn.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  el.routeBtn.disabled = true;
  try {
    ensureMap();
    if (!lastTxpros?.route?.coordinates?.length) {
      const id = extractPermitId(el.permitId.value) || extractPermitId(el.permitText.value);
      if (!id) throw new Error("Upload a TxDMV PDF (with QR) first.");
      await loadOfficialRoute(id, { autoMap: true });
      return;
    }
    clearMapOverlays();
    drawTxprosRoute(lastTxpros.route);
    say(`Mapped official route · ${lastTxpros.route.point_count} points`, "ok");
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
    el.routeBtn.disabled = !lastTxpros?.route?.coordinates?.length;
  }
});

el.satBtn.addEventListener("click", () => {
  try {
    ensureMap();
    setSatellite(!isSatellite());
    el.satBtn.textContent = isSatellite() ? "Streets" : "Satellite";
  } catch (err) {
    say(err.message, "error");
  }
});

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

el.parserVersion.textContent = PARSER_VERSION;
el.mapboxToken.value = localStorage.getItem(STORAGE_MAPBOX) || DEFAULT_MAPBOX_TOKEN;
el.xaiKey.value = localStorage.getItem(STORAGE_XAI) || "";
if (!localStorage.getItem(STORAGE_MAPBOX)) localStorage.setItem(STORAGE_MAPBOX, DEFAULT_MAPBOX_TOKEN);

try {
  initMap(getMapboxToken());
  say("Upload a Texas permit PDF — we’ll read the QR/ID and map the official route.");
} catch (err) {
  say(`Map failed: ${err.message}`, "error");
}
