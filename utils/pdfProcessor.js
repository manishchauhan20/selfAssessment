const { PDFParse } = require("pdf-parse");

const extractTextFromPDF = async (fileBuffer) => {
  let parser;

  try {
    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
      throw new Error("Empty PDF file.");
    }

    parser = new PDFParse({ data: fileBuffer });
    const data = await parser.getText();
    const text = data?.text?.trim();

    if (!text) {
      throw new Error("PDF parsed but no text content found.");
    }

    // Return full extracted text so downstream chapter filtering can reliably
    // find chapters that appear later in the PDF.
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
