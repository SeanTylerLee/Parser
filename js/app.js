import { inspectPermitFile, fileKind } from "./ocr.js";
import { initMap, hasMap, clearMapOverlays, drawPermitRoute, setSatellite, isSatellite } from "./map.js";
import { parseOkPermitText, OK_PARSER_VERSION, looksLikeOkPermit } from "./ok-permit-parser.js";
import { buildOkRoute } from "./ok-route.js?v=odometer";

const MAPBOX_TOKEN =
  "pk.eyJ1Ijoic2VhbmxlZTkyIiwiYSI6ImNtZTAyeG0wbzAwamgybHE2cmwzenJtM2cifQ.DE8FeoDvc3EzuyR5uPopzA";

const el = {
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("fileInput"),
  fileLabel: document.getElementById("fileLabel"),
  satBtn: document.getElementById("satBtn"),
  status: document.getElementById("status"),
  meta: document.getElementById("meta"),
  steps: document.getElementById("steps"),
  resultPanel: document.getElementById("resultPanel"),
  parserVersion: document.getElementById("parserVersion"),
};

let busy = false;

function say(msg, kind = "info") {
  el.status.textContent = msg;
  el.status.dataset.kind = kind;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDirections(parsed, checks) {
  el.resultPanel.hidden = false;
  el.meta.innerHTML = "";
  el.steps.innerHTML = "";
  const miles =
    parsed.approximate_miles != null
      ? `${parsed.approximate_miles} mi`
      : parsed.expected_miles != null
        ? `${parsed.expected_miles} mi`
        : "—";
  const rows = [
    ["Permit", parsed.permit_number || "—"],
    ["From", parsed.origin_text || "—"],
    ["To", parsed.destination_text || "—"],
    ["Permit miles", miles],
    ["Directions", String(parsed.steps?.length || 0)],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    el.meta.append(dt, dd);
  }

  const byIndex = new Map((checks || []).map((c) => [c.index, c]));
  (parsed.steps || []).forEach((step, i) => {
    const li = document.createElement("li");
    const check = byIndex.get(i);
    if (check?.both_fail) li.className = "bad";
    else if (check && !check.miles_ok) li.className = "weak";
    else if (check) li.className = "ok";
    const tag = step.leg_miles != null ? `${step.leg_miles} mi` : "Dir";
    const road = [step.road, step.compass].filter(Boolean).join(" ");
    const note = check
      ? `<span class="miles">${escapeHtml(checkText(check))}</span>`
      : road
        ? `<span class="miles">${escapeHtml(road)}</span>`
        : "";
    li.innerHTML = `<span class="tag">${escapeHtml(tag)}</span><span>${escapeHtml(step.instruction)}</span>${note}`;
    el.steps.appendChild(li);
  });
}

function checkText(check) {
  const miles = check.miles_ok
    ? "miles match"
    : `${Number(check.walked_mi).toFixed(1)} mi drawn, permit says ${check.miles}`;
  const road = check.used_road ? `on ${check.used_road}` : check.road ? "road not found" : "exit";
  return `${miles} · ${road}`;
}

async function handleFile(file) {
  if (!file || busy) return;
  if (fileKind(file) !== "pdf") {
    say("Upload the Oklahoma permit PDF.", "error");
    return;
  }

  busy = true;
  el.fileLabel.textContent = file.name;
  el.resultPanel.hidden = true;
  if (hasMap()) clearMapOverlays();

  try {
    const inspected = await inspectPermitFile(file, { onStatus: (m) => say(m) });
    if (!inspected.text?.trim()) {
      say("Could not read text from that PDF.", "error");
      return;
    }
    if (!looksLikeOkPermit(inspected.text)) {
      say("That PDF does not look like an Oklahoma permit.", "warn");
    }

    const parsed = parseOkPermitText(inspected.text);
    renderDirections(parsed);
    if (!parsed.ok) {
      say(parsed.errors.join(" ") || "Could not find driving directions in that PDF.", "error");
      return;
    }

    say(`Read ${parsed.steps.length} directions. Drawing the route from the miles and road names…`);
    const route = await buildOkRoute(parsed, MAPBOX_TOKEN, { onStatus: (m) => say(m) });
    drawPermitRoute(route, {
      originLabel: parsed.origin_text || "Start",
      destLabel: parsed.destination_text || "End",
    });
    renderDirections(parsed, route.step_checks);

    const drawn = route.distance_mi != null ? `${route.distance_mi.toFixed(1)} mi drawn` : "route drawn";
    const permitMi = parsed.approximate_miles ?? parsed.expected_miles;
    const compare = permitMi != null ? ` · permit ${permitMi} mi` : "";
    const kind = route.confidence === "high" ? "ok" : route.confidence === "low" ? "error" : "warn";
    say(`${parsed.steps.length} directions · ${drawn}${compare}.`, kind);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), "error");
  } finally {
    busy = false;
    el.fileInput.value = "";
  }
}

el.fileInput.addEventListener("change", () => {
  const file = el.fileInput.files?.[0];
  if (file) handleFile(file);
});

el.dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  el.dropzone.classList.add("drag");
});
el.dropzone.addEventListener("dragleave", () => {
  el.dropzone.classList.remove("drag");
});
el.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  el.dropzone.classList.remove("drag");
  const file = event.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

el.satBtn.addEventListener("click", () => {
  try {
    if (!hasMap()) initMap(MAPBOX_TOKEN);
    setSatellite(!isSatellite());
    el.satBtn.textContent = isSatellite() ? "Streets" : "Satellite";
  } catch (err) {
    say(err.message, "error");
  }
});

el.parserVersion.textContent = OK_PARSER_VERSION;

try {
  initMap(MAPBOX_TOKEN);
} catch (err) {
  say(`Map failed: ${err.message}`, "error");
}
