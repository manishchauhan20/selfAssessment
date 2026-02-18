const test = require("node:test");
const assert = require("node:assert/strict");

const { app } = require("../index");

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

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("GET /health returns ok", async () => {
  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { status: "ok" });
  } finally {
    server.close();
  }
});

test("POST /api/generate-questions with source=other requires a pdf", async () => {
  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const fd = new FormData();
    fd.append("source", "other");
    fd.append("chapter", "Test Chapter");
    fd.append("topic", "Test Topic");
    fd.append("difficulty", "easy");
    fd.append("numQ", "5");

    const res = await fetch(`${baseUrl}/api/generate-questions`, {
      method: "POST",
      body: fd,
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, "No PDF file uploaded");
  } finally {
    server.close();
  }
});

test("POST /api/pdf-structure returns validated chapter/topic map", async () => {
  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const fd = new FormData();
    fd.append("source", "other");
    const pdfBuffer = makeSimplePdf(
      "Chapter 1: Demo\nTopic 1: Basics\nThis topic explains core fundamentals.\nWhat is a core fundamental?",
    );
    const pdfBlob = new Blob([pdfBuffer], { type: "application/pdf" });
    fd.append("pdf", pdfBlob, "sample.pdf");

    const res = await fetch(`${baseUrl}/api/pdf-structure`, {
      method: "POST",
      body: fd,
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.chapters));
    assert.ok(json.chapters.length >= 1);
    assert.equal(typeof json.dataMap, "object");
    assert.ok(Object.keys(json.dataMap).length >= 1);
  } finally {
    server.close();
  }
});

test("POST /api/generate-questions with source=other falls back when chapter/topic missing", async () => {
  const server = await startServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const fd = new FormData();
    fd.append("source", "other");
    fd.append("difficulty", "easy");
    fd.append("numQ", "3");

    const pdfBuffer = makeSimplePdf(
      "Chapter 1: Demo\nTopic 1: Basics\nThis chapter explains fundamentals and principles.",
    );
    const pdfBlob = new Blob([pdfBuffer], { type: "application/pdf" });
    fd.append("pdf", pdfBlob, "sample.pdf");

    const res = await fetch(`${baseUrl}/api/generate-questions`, {
      method: "POST",
      body: fd,
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.quiz));
    assert.ok(json.quiz.length > 0);
    assert.equal(typeof json.chapter, "string");
    assert.equal(typeof json.topic, "string");
  } finally {
    server.close();
  }
});
