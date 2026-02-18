const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateParsedPDFData,
  getValidChapters,
  getValidTopics,
  getQuestions,
  safeGenerateExam,
} = require("../utils/pdfArchitecture");

test("validateParsedPDFData removes empty chapters/topics/questions", () => {
  const raw = {
    "Chapter 1: Valid": {
      topics: {
        "Topic A": {
          content: "This topic contains valid learning material.",
          questions: ["What is the core idea of Topic A?"],
        },
        "Topic Empty": {
          content: "",
          questions: [],
        },
      },
    },
    "Chapter Empty": {
      topics: {},
    },
  };

  const validated = validateParsedPDFData(raw);
  assert.deepEqual(Object.keys(validated), ["Chapter 1: Valid"]);
  assert.deepEqual(Object.keys(validated["Chapter 1: Valid"].topics), ["Topic A"]);
});

test("getValidChapters/getValidTopics/getQuestions apply safe fallback", () => {
  const dataMap = {
    "Chapter 1": {
      topics: {
        "Topic 1": {
          content: "Topic 1 content for testing fallback behavior.",
          questions: ["What is Topic 1 about?"],
        },
      },
    },
    "Chapter 2": {
      topics: {
        "Topic 2": {
          content: "Topic 2 content with one valid question.",
          questions: ["How does Topic 2 work?"],
        },
      },
    },
  };

  assert.deepEqual(getValidChapters(dataMap), ["Chapter 1", "Chapter 2"]);
  assert.deepEqual(getValidTopics(dataMap, "Chapter 1"), ["Topic 1"]);

  const selection = getQuestions(dataMap, "Missing Chapter", "Missing Topic");
  assert.equal(selection.chapter, "Chapter 1");
  assert.equal(selection.topic, "Topic 1");
  assert.ok(selection.usedChapterFallback);
  assert.ok(selection.usedTopicFallback);
  assert.ok(selection.questions.length > 0);
});

test("safeGenerateExam always returns questions with AI failure", async () => {
  const dataMap = {
    "Chapter 1": {
      topics: {
        "Topic 1": {
          content: "This chapter and topic provide enough context for fallback questions.",
          questions: ["What is the most important idea in Topic 1?"],
        },
      },
    },
  };

  const response = await safeGenerateExam({
    source: "other",
    chapter: "Invalid Chapter",
    topic: "Invalid Topic",
    numQ: 3,
    fullPdfText: "Chapter 1 Topic 1 fallback content",
    parsedData: dataMap,
    generateQuizFn: async () => ({ quiz: [], error: "Simulated model outage" }),
  });

  assert.equal(response.chapter, "Chapter 1");
  assert.equal(response.topic, "Topic 1");
  assert.ok(response.fallbackApplied);
  assert.ok(Array.isArray(response.quiz));
  assert.equal(response.quiz.length, 3);
});
