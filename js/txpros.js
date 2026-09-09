/**
 * TxDMV TxPROS helpers.
 * Official route geometry comes from RouteService.GetLatLonForPermit via our local proxy
 * (browser CORS blocks direct calls to txpros.txdmv.gov).
 */

const TXPROS_URL_RE =
  /https?:\/\/txpros\.txdmv\.gov\/PermitDetails02\.aspx\?[^\s"'<>]*PermitID=(\d+)/i;
const PERMIT_ID_RE = /\bPermitID[=:\s]+(\d{6,})\b/i;

export function extractPermitId(text) {
  if (!text) return null;
  const s = String(text);
  let m = TXPROS_URL_RE.exec(s);
  if (m) return m[1];
  m = PERMIT_ID_RE.exec(s);
  if (m) return m[1];
  // Bare numeric id pasted alone
  m = /^\s*(\d{7,10})\s*$/.exec(s);
  if (m) return m[1];
  return null;
}

export function txprosUrl(permitId) {
  return `https://txpros.txdmv.gov/PermitDetails02.aspx?PermitID=${permitId}&QRUSER=1`;
}

export async function fetchTxprosPermit(permitId, { baseUrl = "" } = {}) {
  const id = extractPermitId(String(permitId)) || String(permitId).replace(/\D/g, "");
  if (!id) throw new Error("Need a TxPROS Permit ID (from the QR link).");
  const url = `${baseUrl}/api/txpros/permit?id=${encodeURIComponent(id)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new Error(json.error || `TxPROS fetch failed (${res.status})`);
  }
  return json;
}

/** Scan an image File/Blob for a TxPROS QR URL using jsQR (global). */
export async function scanPermitQr(file) {
  if (!window.jsQR) return null;
  const img = await blobToImage(file);
  const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const code = window.jsQR(imageData.data, w, h, { inversionAttempts: "attemptBoth" });
  if (!code?.data) return null;
  return extractPermitId(code.data) || extractPermitId(String(code.data));
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image for QR scan"));
    };
    img.src = url;
  });
}

/** Build a short text summary from TxPROS driving dirs for the sidebar. */
export function dirsToText(drivingDirs) {
  if (!drivingDirs?.length) return "";
  const lines = ["Miles Route To Distance Est. Time"];
  for (const d of drivingDirs) {
    const to = d.to || "";
    if (/^\[Loaded Route/i.test(to) || !d.route) {
      lines.push(to);
      continue;
    }
    const miles = Number(d.miles) || 0;
    const dist = Number(d.distance) || miles;
    const sec = Number(d.time_sec) || 0;
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    lines.push(`${miles.toFixed(2)} ${d.route} ${to} ${dist.toFixed(2)} ${mm}:${ss}`);
  }
  return lines.join("\n");
}
