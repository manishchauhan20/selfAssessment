const test = require("node:test");
const assert = require("node:assert/strict");

const { filterPdfTextByChapter } = require("../utils/chapterFilter");

test("filterPdfTextByChapter keeps only selected chapter section", () => {
  const text = `
    Chapter 1: Real Numbers
    Euclid Division Lemma
    HCF and LCM
    Chapter 2: Polynomials
    Polynomial identities
    Zeroes of polynomial
    Chapter 3: Pair of Linear Equations
    Graphical method
    Substitution method
  `;

  const result = filterPdfTextByChapter(text, "Chapter 2: Polynomials");
  assert.match(result, /Chapter 2: Polynomials/i);
  assert.match(result, /Polynomial identities/i);
  assert.doesNotMatch(result, /Chapter 1: Real Numbers/i);
  assert.doesNotMatch(result, /Chapter 3: Pair of Linear Equations/i);
});

test("filterPdfTextByChapter returns empty when selected chapter missing", () => {
  const text = `
    Chapter 1: Real Numbers
    Euclid Division Lemma
    Chapter 2: Polynomials
    Polynomial identities
  `;

  const result = filterPdfTextByChapter(text, "Chapter 9: Circles");
  assert.equal(result, "");
});

test("filterPdfTextByChapter returns empty when chapter is blank", () => {
  const text = "Chapter 1: Real Numbers\nEuclid Division Lemma";
  assert.equal(filterPdfTextByChapter(text, ""), "");
  assert.equal(filterPdfTextByChapter(text, "   "), "");
});

