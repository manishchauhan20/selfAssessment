const { PDFParse } = require("pdf-parse");

function normalizePageText(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

function isContentsPage(text) {
  const normalized = normalizePageText(text);
  if (!normalized) return false;

  return /(?:^|\n)\s*(table of contents|contents)\s*(?:\n|$)/iu.test(normalized);
}

function selectContentsWindow(pages) {
  const safePages = Array.isArray(pages)
    ? pages
        .map((page) => ({
          num: Number(page?.num) || 0,
          text: normalizePageText(page?.text),
        }))
        .filter((page) => page.num > 0 && page.text)
        .sort((a, b) => a.num - b.num)
    : [];

  if (safePages.length === 0) return "";

  const contentsIndex = safePages.findIndex((page) => isContentsPage(page.text));
  if (contentsIndex < 0) return "";

  return safePages
    .slice(contentsIndex, contentsIndex + 3)
    .map((page) => page.text)
    .filter(Boolean)
    .join("\n\n");
}

const extractTextFromPDF = async (fileBuffer) => {
  let parser;

  try {
    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
      throw new Error("Empty PDF file.");
    }

    parser = new PDFParse({ data: fileBuffer });
    const data = await parser.getText();
    const contentsWindowText = selectContentsWindow(data?.pages);
    const text = normalizePageText(contentsWindowText || data?.text);

    if (!text) {
      throw new Error("PDF parsed but no text content found.");
    }

    return text;
  } catch (error) {
    console.error("PDF Processor Error:", error.message);
    throw new Error(
      "Failed to read PDF file. Ensure it is a valid text-based PDF (not scanned images).",
    );
  } finally {
    if (parser && typeof parser.destroy === "function") {
      try {
        await parser.destroy();
      } catch {
        // Ignore parser cleanup errors.
      }
    }
  }
};

module.exports = { extractTextFromPDF };
