/**
 * Turn a permit photo or PDF into plain text the TxDMV parser can read.
 * Photos: optional Grok vision (if an xAI key is saved), else Tesseract.
 * PDFs: pdf.js text extraction in the browser.
 */

const PDFJS_VERSION = "4.10.38";
const PDFJS_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

const VISION_PROMPT = `Transcribe this Texas TxDMV oversize/overweight permit exactly.

Return PLAIN TEXT only (no markdown). Include, in this order when present:
1) Permit Number
2) Origin: ...
3) Destination: ...
4) Any lines like [Loaded Route Origin: ...] and [Loaded Route Destination: ...]
5) The driving-directions table. Start with a header line: Miles Route To Distance Est. Time
   Then one row per maneuver, in order, keeping highway tokens as printed (IH, US, SH, FM, RM, SL, BU, BI, SS, SP, CR, LOOP).
   Example row: 6.20 IH10 e Turn left onto IH610 n 6.50 00:10

Keep compass letters (n s e w ne nw se sw). Do not summarize, skip, or invent rows.
If a cell is unreadable write [UNREADABLE].`;

export function fileKind(file) {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".heic") || name.endsWith(".heif") || type.includes("heic") || type.includes("heif")) {
    return "heic";
  }
  if (type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|tif{1,2})$/.test(name)) return "image";
  return "unknown";
}

export async function extractTextFromFile(file, { xaiKey, onStatus } = {}) {
  const kind = fileKind(file);
  const say = (msg) => onStatus && onStatus(msg);

  if (kind === "heic") {
    throw new Error("HEIC photos are not readable in the browser. Export as JPEG or PNG and upload that.");
  }
  if (kind === "pdf") {
    say("Reading PDF text…");
    return await extractPdfText(file, say);
  }
  if (kind !== "image") {
    throw new Error("Upload a permit photo (JPEG/PNG) or a PDF.");
  }

  if (xaiKey) {
    try {
      say("Reading permit photo with Grok vision…");
      return await extractWithGrokVision(file, xaiKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      say(`Vision read failed (${msg}). Falling back to on-device OCR…`);
    }
  }

  say("Running on-device OCR (this can take 10–30 seconds)…");
  return await extractWithTesseract(file, say);
}

async function extractPdfText(file, say) {
  const pdfjs = await import(PDFJS_SRC);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    say(`Reading PDF page ${i} of ${doc.numPages}…`);
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const lineMap = new Map();
    for (const item of content.items) {
      if (!item.str || !item.transform) continue;
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y).push({ x, str: item.str });
    }
    const ys = [...lineMap.keys()].sort((a, b) => b - a);
    const lines = ys.map((y) =>
      lineMap
        .get(y)
        .sort((a, b) => a.x - b.x)
        .map((t) => t.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    pages.push(lines.filter(Boolean).join("\n"));
  }
  return pages.join("\n\n").trim();
}

async function fileToJpegDataUrl(file, { maxEdge = 2000, quality = 0.85 } = {}) {
  const bitmap = await blobToImage(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
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
      reject(new Error("Could not read that image."));
    };
    img.src = url;
  });
}

async function extractWithGrokVision(file, apiKey) {
  const dataUrl = await fileToJpegDataUrl(file, { maxEdge: 2048, quality: 0.9 });
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-4",
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: dataUrl, detail: "high" },
            { type: "input_text", text: VISION_PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`xAI ${res.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
  }
  const json = await res.json();
  const text = pickResponseText(json);
  if (!text) throw new Error("Vision model returned no text");
  return text.trim();
}

function pickResponseText(json) {
  if (!json || typeof json !== "object") return "";
  if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text;
  const chunks = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node === "string") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === "object") {
      if ((node.type === "output_text" || node.type === "text") && typeof node.text === "string") {
        chunks.push(node.text);
      }
      if (typeof node.text === "string" && node.type === "output_text") chunks.push(node.text);
      Object.values(node).forEach(walk);
    }
  };
  walk(json.output || json);
  return chunks.join("\n").trim();
}

function preprocessForOcr(img) {
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const span = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let v = ((g - min) / span) * 255;
    v = (v - 128) * 1.35 + 128;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function extractWithTesseract(file, say) {
  if (!window.Tesseract) {
    throw new Error("OCR library failed to load. Check your connection and refresh.");
  }
  const img = await blobToImage(file);
  const canvas = preprocessForOcr(img);
  const result = await window.Tesseract.recognize(canvas, "eng", {
    logger: (m) => {
      if (m.status === "recognizing text" && typeof m.progress === "number") {
        say(`OCR ${Math.round(m.progress * 100)}%`);
      }
    },
  });
  return (result?.data?.text || "").trim();
}
