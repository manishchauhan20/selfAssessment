const test = require("node:test");
const assert = require("node:assert/strict");

const { extractTextFromPDF } = require("../utils/pdfProcessor");

function makeSimplePdf(text) {
  const safe = String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");

  const stream = `BT\n/F1 24 Tf\n72 72 Td\n(${safe}) Tj\nET\n`;
  const objects = [];

  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`;
  objects[3] =
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`;
  objects[4] =
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n` +
    `${stream}endstream\nendobj\n`;
  objects[5] =
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf, "utf8");
    pdf += objects[i];
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += "xref\n0 6\n";
  pdf += "0000000000 65535 f \n";

  for (let i = 1; i <= 5; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }

  pdf += "trailer\n<< /Size 6 /Root 1 0 R >>\n";
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

test("extractTextFromPDF extracts text from a basic PDF", async () => {
  const buffer = makeSimplePdf("Hello PDF");
  const text = await extractTextFromPDF(buffer);
  assert.match(text, /Hello PDF/);
});

test("extractTextFromPDF rejects empty buffers", async () => {
  await assert.rejects(() => extractTextFromPDF(Buffer.alloc(0)), {
    message: /Failed to read PDF file/,
  });
});

test("extractTextFromPDF keeps full extracted text for chapter filtering", async () => {
  const marker = "CHAPTER_AT_END";
  const pdfParse = require("pdf-parse");
  const originalPDFParse = pdfParse.PDFParse;

  pdfParse.PDFParse = class FakePDFParse {
    async getText() {
      return { text: `${"A".repeat(32000)}${marker}` };
    }

    async destroy() {}
  };

  delete require.cache[require.resolve("../utils/pdfProcessor")];
  const { extractTextFromPDF: extractTextFromPDFWithMock } = require("../utils/pdfProcessor");

  try {
    const extractedText = await extractTextFromPDFWithMock(Buffer.from("mock-pdf"));
    assert.equal(extractedText.endsWith(marker), true);
    assert.ok(extractedText.length > 32000);
  } finally {
    pdfParse.PDFParse = originalPDFParse;
    delete require.cache[require.resolve("../utils/pdfProcessor")];
  }
});
