/**
 * Read an Oklahoma permit PDF into plain text, one visual line per row.
 * Driving directions are taken from that text. The route map image in the PDF is ignored.
 */

const PDFJS_VERSION = "4.10.38";
const PDFJS_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`;

export function fileKind(file) {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  return "unknown";
}

export async function inspectPermitFile(file, { onStatus } = {}) {
  const kind = fileKind(file);
  const say = (msg) => onStatus && onStatus(msg);
  if (kind !== "pdf") {
    throw new Error("Upload the Oklahoma permit PDF.");
  }
  say("Reading permit PDF…");
  const text = await readPdfText(file, say);
  return { kind, text };
}

async function readPdfText(file, say) {
  const pdfjs = await import(PDFJS_SRC);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    say(`Reading page ${i} of ${doc.numPages}…`);
    const page = await doc.getPage(i);
    pages.push(await pageTextLineAware(page));
  }
  return pages.filter(Boolean).join("\n\n").trim();
}

async function pageTextLineAware(page) {
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
  return lines.filter(Boolean).join("\n");
}
