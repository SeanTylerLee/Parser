import { parsePermitText, PARSER_VERSION } from "./tx-permit-parser.js";
import { extractTextFromFile, fileKind } from "./ocr.js";
import { geocodeSegments, fetchPermitRoute } from "./geocode.js";
import { initMap, hasMap, clearMapOverlays, drawPins, drawRouteGeoJSON, setSatellite, isSatellite } from "./map.js";

const STORAGE_MAPBOX = "fleetbord.mapboxToken";
const STORAGE_XAI = "fleetbord.xaiKey";

const DEFAULT_MAPBOX_TOKEN =
  "pk.eyJ1Ijoic2VhbmxlZTkyIiwiYSI6ImNtZTAyeG0wbzAwamgybHE2cmwzenJtM2cifQ.DE8FeoDvc3EzuyR5uPopzA";

const SAMPLE_PERMIT = `Texas Oversize/Overweight Permit
Permit Number: TEST-260909-01

Origin: Harris County, Houston, TX
[Loaded Route Origin: IH 10, 0.30 miles west of IH 10 & IH 610]
Destination: Dallas County, Dallas, TX
[Loaded Route Destination: US 75, 0.20 miles north of US 75 & IH 635]

Miles Route To Distance Est. Time
0.30 IH10 e Continue straight 0.30 00:01
6.20 IH10 e Turn left onto IH610 n 6.50 00:10
8.40 IH610 n Turn right onto IH45 n 14.90 00:22
220.10 IH45 n Turn right onto US75 n 235.00 03:35
15.20 US75 n Arrive at destination 250.20 03:52

Route Conditions:
* Follow the route listed on this permit.`;

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
  loadSample: document.getElementById("loadSample"),
  routeBtn: document.getElementById("routeBtn"),
  reparseBtn: document.getElementById("reparseBtn"),
  satBtn: document.getElementById("satBtn"),
  permitText: document.getElementById("permitText"),
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
  steps: document.getElementById("steps"),
  resultPanel: document.getElementById("resultPanel"),
  parserVersion: document.getElementById("parserVersion"),
};

let lastParse = null;
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
  if (!token) throw new Error("Add your Mapbox token in Settings.");
  if (!hasMap()) initMap(token);
  return token;
}

function loadKeysIntoForm() {
  el.mapboxToken.value = localStorage.getItem(STORAGE_MAPBOX) || DEFAULT_MAPBOX_TOKEN;
  el.xaiKey.value = localStorage.getItem(STORAGE_XAI) || "";
}

el.settingsBtn.addEventListener("click", () => {
  const open = el.settingsPanel.hidden;
  el.settingsPanel.hidden = !open;
  el.settingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
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

function applyParse(text) {
  lastParse = parsePermitText(text);
  clearMapOverlays();
  renderParse(lastParse);
  el.resultPanel.hidden = false;
  const nSeg = lastParse.segments.length;
  el.routeBtn.disabled = !nSeg;
  return nSeg;
}

async function ingestFile(file) {
  if (!file || busy) return;
  const kind = fileKind(file);
  if (kind === "heic") {
    say("HEIC not supported — use JPEG or PNG.", "error");
    return;
  }
  if (kind === "unknown") {
    say("Upload a JPEG/PNG photo or PDF.", "error");
    return;
  }

  busy = true;
  el.routeBtn.disabled = true;
  try {
    if (kind === "image") {
      const url = URL.createObjectURL(file);
      el.previewImg.onload = () => URL.revokeObjectURL(url);
      el.previewImg.src = url;
      el.preview.hidden = false;
    } else {
      el.preview.hidden = true;
    }

    say(`Reading ${file.name}…`);
    const text = await extractTextFromFile(file, {
      xaiKey: getXaiKey(),
      onStatus: (m) => say(m),
    });
    el.permitText.value = text || "";
    if (!text) {
      say("Could not read text. Try a clearer photo or PDF.", "error");
      return;
    }

    say("Parsing route…");
    const nSeg = applyParse(text);
    say(
      nSeg
        ? `Parsed ${nSeg} pin(s). Click Show on map.`
        : "No route found in that permit. Check Edit extracted text.",
      nSeg ? "ok" : "error",
    );
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
  }
}

el.loadSample.addEventListener("click", () => {
  if (busy) return;
  el.preview.hidden = true;
  el.fileInput.value = "";
  el.permitText.value = SAMPLE_PERMIT;
  const nSeg = applyParse(SAMPLE_PERMIT);
  say(nSeg ? `Sample parsed (${nSeg} pins). Click Show on map.` : "Sample failed to parse.", nSeg ? "ok" : "error");
});

el.fileInput.addEventListener("change", () => {
  const file = el.fileInput.files && el.fileInput.files[0];
  if (file) ingestFile(file);
});

["dragenter", "dragover"].forEach((evt) => {
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.add("drag");
  });
});
["dragleave", "drop"].forEach((evt) => {
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove("drag");
  });
});
el.dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) ingestFile(file);
});

el.reparseBtn.addEventListener("click", () => {
  const text = el.permitText.value.trim();
  if (!text) {
    say("No text to parse.", "error");
    return;
  }
  const nSeg = applyParse(text);
  say(nSeg ? `Re-parsed ${nSeg} pin(s).` : "Still no route pins in that text.", nSeg ? "ok" : "error");
});

el.routeBtn.addEventListener("click", async () => {
  if (!lastParse?.segments?.length || busy) return;
  busy = true;
  el.routeBtn.disabled = true;
  try {
    const token = ensureMap();
    say("Geocoding junctions…");
    const pins = await geocodeSegments(lastParse.segments, token, {
      originText: lastParse.origin_text,
      destinationText: lastParse.destination_text,
      onPin: (pin, i, total) => say(`Pin ${i + 1}/${total}…`),
    });
    drawPins(pins);

    const missing = pins.filter((p) => p.lng == null);
    if (missing.length) {
      say(`${missing.length} pin(s) failed. Edit text and re-parse.`, "error");
      return;
    }

    say("Drawing route…");
    const route = await fetchPermitRoute(pins, token);
    drawRouteGeoJSON(route);
    const permitMi = lastParse.steps.map((s) => s.permit_odometer_mi).filter((n) => n != null).pop();
    const mapMi = route.properties.distance_mi;
    const note =
      permitMi != null
        ? `Map ${mapMi.toFixed(0)} mi · permit ${permitMi.toFixed(0)} mi`
        : `Map ${mapMi.toFixed(0)} mi`;
    const weak = pins.filter((p) => p.weak).length;
    say(weak ? `${note} · ${weak} weak pin(s)` : note, weak ? "warn" : "ok");
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
    el.routeBtn.disabled = !lastParse?.segments?.length;
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

function renderParse(result) {
  el.meta.innerHTML = "";
  el.steps.innerHTML = "";

  const rows = [
    ["Permit", result.permit_number || "—"],
    ["From", result.origin_text || "—"],
    ["To", result.destination_text || "—"],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    el.meta.append(dt, dd);
  }

  if (!result.segments.length) {
    el.steps.innerHTML = `<li class="empty">No route pins found.</li>`;
    return;
  }

  for (const seg of result.segments) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="tag">${escapeHtml(seg.label)}</span>
      <span>${escapeHtml(seg.displayText || seg.text)}</span>`;
    el.steps.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

el.parserVersion.textContent = PARSER_VERSION;
loadKeysIntoForm();
if (!localStorage.getItem(STORAGE_MAPBOX)) {
  localStorage.setItem(STORAGE_MAPBOX, DEFAULT_MAPBOX_TOKEN);
}
try {
  initMap(getMapboxToken());
  say("Drop a permit or click Sample.");
} catch (err) {
  say(`Map failed: ${err.message}`, "error");
}
