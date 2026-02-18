function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPageMarker(line) {
  return /^--\s*\d+\s+of\s+\d+\s*--$/i.test(String(line || "").trim());
}

function looksLikeChapterHeading(line) {
  const text = String(line || "").trim();
  if (!text) return false;

  return /^(chapter|unit)\s+([0-9]+|[ivxlcdm]+)\b/i.test(text);
}

function tokenOverlapScore(a, b) {
  const aTokens = normalize(a).split(" ").filter(Boolean);
  const bTokens = normalize(b).split(" ").filter(Boolean);

  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);

  let overlap = 0;
  for (const token of aSet) {
    if (bSet.has(token)) overlap += 1;
  }

  return overlap / Math.max(aSet.size, bSet.size);
}

function getHeadingMatchScore(heading, selectedChapter) {
  const headingNorm = normalize(heading);
  const selectedNorm = normalize(selectedChapter);
  if (!headingNorm || !selectedNorm) return 0;

  if (headingNorm === selectedNorm) return 100;
  if (headingNorm.includes(selectedNorm)) return 90;
  if (selectedNorm.includes(headingNorm)) return 80;

  const overlap = tokenOverlapScore(headingNorm, selectedNorm);
  if (overlap >= 0.75) return Math.round(overlap * 70);
  return 0;
}

function sanitizeLines(fullText) {
  return String(fullText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isPageMarker(line));
}

function sliceByChapterHeading(lines, selectedChapter) {
  const headingIndices = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (looksLikeChapterHeading(lines[i])) {
      headingIndices.push(i);
    }
  }

  if (headingIndices.length === 0) return "";

  let best = null;

  for (let i = 0; i < headingIndices.length; i += 1) {
    const start = headingIndices[i];
    const end = i + 1 < headingIndices.length ? headingIndices[i + 1] : lines.length;
    const heading = lines[start];
    const sectionText = lines.slice(start, end).join("\n").trim();
    const score = getHeadingMatchScore(heading, selectedChapter);

    if (score <= 0 || !sectionText) continue;

    if (
      !best ||
      score > best.score ||
      (score === best.score && sectionText.length > best.sectionText.length)
    ) {
      best = { score, sectionText };
    }
  }

  return best ? best.sectionText : "";
}

function sliceBySelectedTitle(fullText, selectedChapter) {
  const source = String(fullText || "");
  const selected = String(selectedChapter || "").trim();
  if (!source || !selected) return "";

  const lowerSource = source.toLowerCase();
  const lowerSelected = selected.toLowerCase();
  const start = lowerSource.indexOf(lowerSelected);
  if (start === -1) return "";

  const tail = source.slice(start);
  const tailLines = tail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isPageMarker(line));

  if (tailLines.length === 0) return "";

  const out = [tailLines[0]];
  for (let i = 1; i < tailLines.length; i += 1) {
    const line = tailLines[i];
    if (looksLikeChapterHeading(line)) break;
    out.push(line);
  }

  return out.join("\n").trim();
}

function filterPdfTextByChapter(fullText, selectedChapter) {
  const chapter = String(selectedChapter || "").trim();
  if (!chapter) return "";

  const lines = sanitizeLines(fullText);
  if (lines.length === 0) return "";

  const byHeading = sliceByChapterHeading(lines, chapter);
  if (byHeading) return byHeading;

  const byTitle = sliceBySelectedTitle(lines.join("\n"), chapter);
  return byTitle || "";
}

module.exports = { filterPdfTextByChapter };

