import { parsePermitText, PARSER_VERSION } from "./tx-permit-parser.js";
import { extractTextFromFile, fileKind } from "./ocr.js";
import { geocodeSegments, fetchPermitRoute } from "./geocode.js";
import { initMap, hasMap, clearMapOverlays, drawPins, drawRouteGeoJSON, setSatellite, isSatellite } from "./map.js";

const STORAGE_MAPBOX = "fleetbord.mapboxToken";
const STORAGE_XAI = "fleetbord.xaiKey";

/** Public Mapbox token (pk.*) — safe for client use; restrict by URL in the Mapbox dashboard. */
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
  fileInput: document.getElementById("fileInput"),
  dropzone: document.getElementById("dropzone"),
  preview: document.getElementById("preview"),
  previewImg: document.getElementById("previewImg"),
  clearFile: document.getElementById("clearFile"),
  loadSample: document.getElementById("loadSample"),
  extractBtn: document.getElementById("extractBtn"),
  parseBtn: document.getElementById("parseBtn"),
  routeBtn: document.getElementById("routeBtn"),
  satBtn: document.getElementById("satBtn"),
  permitText: document.getElementById("permitText"),
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
  steps: document.getElementById("steps"),
  pins: document.getElementById("pins"),
  parserVersion: document.getElementById("parserVersion"),
};

let currentFile = null;
let lastParse = null;
let lastPins = null;

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
  if (!token) throw new Error("Add your Mapbox token in Settings first.");
  if (!hasMap()) initMap(token);
  return token;
}

function loadKeysIntoForm() {
  el.mapboxToken.value = localStorage.getItem(STORAGE_MAPBOX) || DEFAULT_MAPBOX_TOKEN;
  el.xaiKey.value = localStorage.getItem(STORAGE_XAI) || "";
}

el.saveKeys.addEventListener("click", () => {
  localStorage.setItem(STORAGE_MAPBOX, el.mapboxToken.value.trim());
  localStorage.setItem(STORAGE_XAI, el.xaiKey.value.trim());
  say("Keys saved in this browser.");
  try {
    initMap(getMapboxToken());
    say("Map reloaded with saved token.", "ok");
  } catch (err) {
    say(err.message, "error");
  }
});

el.loadSample.addEventListener("click", () => {
  el.permitText.value = SAMPLE_PERMIT;
  currentFile = null;
  el.preview.hidden = true;
  el.fileInput.value = "";
  say("Sample Houston → Dallas permit loaded. Click Parse, then Route on map.");
});

el.clearFile.addEventListener("click", () => {
  currentFile = null;
  el.fileInput.value = "";
  el.preview.hidden = true;
  el.previewImg.removeAttribute("src");
});

function setFile(file) {
  if (!file) return;
  const kind = fileKind(file);
  if (kind === "heic") {
    say("HEIC is not supported here — export as JPEG/PNG first.", "error");
    return;
  }
  if (kind === "unknown") {
    say("Upload a JPEG/PNG photo or a PDF of the Texas permit.", "error");
    return;
  }
  currentFile = file;
  if (kind === "image") {
    const url = URL.createObjectURL(file);
    el.previewImg.onload = () => URL.revokeObjectURL(url);
    el.previewImg.src = url;
    el.preview.hidden = false;
  } else {
    el.preview.hidden = true;
  }
  say(`Ready: ${file.name}. Click “Extract text”, review it, then Parse.`);
}

el.fileInput.addEventListener("change", () => {
  const file = el.fileInput.files && el.fileInput.files[0];
  if (file) setFile(file);
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
  if (file) setFile(file);
});

el.extractBtn.addEventListener("click", async () => {
  if (!currentFile) {
    say("Choose a permit photo or PDF first (or Load sample).", "error");
    return;
  }
  el.extractBtn.disabled = true;
  try {
    const text = await extractTextFromFile(currentFile, {
      xaiKey: getXaiKey(),
      onStatus: (m) => say(m),
    });
    el.permitText.value = text;
    say(
      text
        ? "Text extracted. Fix any OCR mistakes in the box, then click Parse."
        : "No text came out of that file. Try a clearer photo, a PDF, or paste the directions.",
      text ? "ok" : "error",
    );
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), "error");
  } finally {
    el.extractBtn.disabled = false;
  }
});

el.parseBtn.addEventListener("click", () => {
  const text = el.permitText.value.trim();
  if (!text) {
    say("Paste or extract permit text first.", "error");
    return;
  }
  lastParse = parsePermitText(text);
  lastPins = null;
  renderParse(lastParse);
  clearMapOverlays();
  const nSteps = lastParse.steps.length;
  const nSeg = lastParse.segments.length;
  say(
    nSeg
      ? `Parsed ${nSteps} table row(s) → ${nSeg} map pin(s). Click “Route on map”.`
      : "Parser found no route pins. Check the turn table text (Miles / Route / To).",
    nSeg ? "ok" : "error",
  );
});

el.routeBtn.addEventListener("click", async () => {
  if (!lastParse || !lastParse.segments.length) {
    say("Parse a permit first so we have origin / turns / destination.", "error");
    return;
  }
  el.routeBtn.disabled = true;
  try {
    const token = ensureMap();
    say("Geocoding highway junctions…");
    lastPins = await geocodeSegments(lastParse.segments, token, {
      originText: lastParse.origin_text,
      destinationText: lastParse.destination_text,
      onPin: (pin, i, total) => say(`Geocoded ${i + 1}/${total}: ${pin.displayText}`),
    });
    renderPins(lastPins);
    drawPins(lastPins);

    const missing = lastPins.filter((p) => p.lng == null);
    if (missing.length) {
      say(`${missing.length} pin(s) failed geocoding. Fix text or try again.`, "error");
      return;
    }

    say("Building Mapbox driving path through the pins…");
    const route = await fetchPermitRoute(lastPins, token);
    drawRouteGeoJSON(route);
    const permitMi = lastParse.steps
      .map((s) => s.permit_odometer_mi)
      .filter((n) => n != null)
      .pop();
    const mapMi = route.properties.distance_mi;
    const note =
      permitMi != null
        ? ` Map ~${mapMi.toFixed(1)} mi vs permit odometer ~${permitMi.toFixed(1)} mi.`
        : ` Map distance ~${mapMi.toFixed(1)} mi.`;
    const weak = lastPins.filter((p) => p.weak).length;
    say(
      `Route drawn.${note}${weak ? ` ${weak} pin(s) look weak — click them and check.` : ""}`,
      weak ? "warn" : "ok",
    );
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), "error");
  } finally {
    el.routeBtn.disabled = false;
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
  el.pins.innerHTML = "";

  const rows = [
    ["Permit #", result.permit_number || "—"],
    ["Origin", result.origin_text || "—"],
    ["Destination", result.destination_text || "—"],
    ["Parser", result.parser_version],
    ["Warnings", result.warnings.length ? result.warnings.join(", ") : "none"],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    el.meta.append(dt, dd);
  }

  if (!result.steps.length) {
    el.steps.innerHTML = `<li class="empty">No turn-table rows found. The text needs a Miles / Route / To table.</li>`;
  } else {
    for (const step of result.steps) {
      const li = document.createElement("li");
      const miles = step.leg_miles != null ? `${step.leg_miles.toFixed(2)} mi` : "—";
      const odo = step.permit_odometer_mi != null ? ` · odo ${step.permit_odometer_mi.toFixed(2)}` : "";
      li.innerHTML = `<span class="miles">${miles}${odo}</span>
        <span class="body"><strong>${escapeHtml(step.from_road || "?")}</strong>
        ${escapeHtml(step.from_dir || "")}
        ${escapeHtml(step.maneuver || "")}
        ${step.to_road ? `→ <strong>${escapeHtml(step.to_road)}</strong> ${escapeHtml(step.to_dir || "")}` : ""}</span>
        <code>${escapeHtml(step.raw_row)}</code>`;
      el.steps.appendChild(li);
    }
  }

  for (const seg of result.segments) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="tag">${escapeHtml(seg.label)}</span>
      <span>${escapeHtml(seg.displayText || seg.text)}</span>`;
    el.pins.appendChild(li);
  }
}

function renderPins(pins) {
  el.pins.innerHTML = "";
  pins.forEach((pin, i) => {
    const li = document.createElement("li");
    li.className = pin.ok ? (pin.weak ? "weak" : "ok") : "bad";
    const coords =
      pin.lng != null ? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}` : "not found";
    li.innerHTML = `<span class="tag">${i + 1}. ${escapeHtml(pin.label)}</span>
      <span>${escapeHtml(pin.displayText)}</span>
      <span class="muted">${escapeHtml(pin.place || coords)} · score ${Math.round(pin.score)}</span>`;
    el.pins.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Boot
el.parserVersion.textContent = PARSER_VERSION;
loadKeysIntoForm();
if (!localStorage.getItem(STORAGE_MAPBOX)) {
  localStorage.setItem(STORAGE_MAPBOX, DEFAULT_MAPBOX_TOKEN);
}
try {
  initMap(getMapboxToken());
  say("Map ready. Load the sample permit or upload a Texas OS/OW photo.");
} catch (err) {
  say(`Map failed to start: ${err.message}`, "error");
}
