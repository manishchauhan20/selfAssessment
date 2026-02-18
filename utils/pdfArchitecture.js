// @ts-check

const DEFAULT_CHAPTER_TITLE = "Uploaded PDF";
const DEFAULT_TOPIC_TITLE = "General Topic";
const MAX_QUESTION_SEEDS = 24;
const MAX_EXPLANATION_LENGTH = 260;

/**
 * @typedef {{ content: string, questions: string[] }} TopicNode
 * @typedef {{ topics: Record<string, TopicNode> }} ChapterNode
 * @typedef {Record<string, ChapterNode>} ParsedPdfData
 * @typedef {{ chapter: string, topic: string, questions: string[], content: string, usedChapterFallback: boolean, usedTopicFallback: boolean }} TopicSelection
 * @typedef {{ q: string, options: string[], ans: string, exp: string }} QuizItem
 * @typedef {{ quiz?: unknown, error?: string }} QuizResponse
 * @typedef {{
 *   source: string,
 *   difficulty?: string,
 *   numQ?: string | number,
 *   chapter?: string,
 *   topic?: string,
 *   pdfText?: string,
 *   className?: string,
 *   subject?: string
 * }} GenerateQuizInput
 * @typedef {(input: GenerateQuizInput) => Promise<QuizResponse>} GenerateQuizFn
 * @typedef {{
 *   parsedData?: ParsedPdfData | Record<string, unknown> | null,
 *   chapter?: string,
 *   topic?: string,
 *   numQ?: string | number,
 *   difficulty?: string,
 *   source: string,
 *   className?: string,
 *   subject?: string,
 *   fullPdfText?: string,
 *   generateQuizFn: GenerateQuizFn
 * }} SafeGenerateExamArgs
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeMultiline(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeKey(value) {
  return normalizeLabel(value).toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeQuestionText(value) {
  return normalizeLabel(String(value || "").replace(/^[Qq](?:uestion)?\s*\d+[\)\].:\-]?\s*/u, ""));
}

/**
 * @param {unknown} question
 * @returns {string}
 */
function ensureQuestionMark(question) {
  const clean = normalizeQuestionText(question);
  if (!clean) return "";
  return /[?]$/.test(clean) ? clean : `${clean}?`;
}

/**
 * @param {unknown} question
 * @returns {boolean}
 */
function isValidQuestion(question) {
  const clean = normalizeQuestionText(question);
  return clean.length >= 10 && /[A-Za-z]/.test(clean);
}

/**
 * @param {unknown} line
 * @returns {boolean}
 */
function isChapterHeading(line) {
  return /^(chapter|unit)\s+([0-9]+|[ivxlcdm]+)\b/i.test(normalizeLabel(line));
}

/**
 * @param {unknown} line
 * @returns {boolean}
 */
function isTopicHeading(line) {
  const text = normalizeLabel(line);
  if (!text || isChapterHeading(text)) return false;

  if (/^\d+(\.\d+)+\s+\S+/u.test(text)) return true;
  if (/^(topic|section|lesson)\s+\d*\s*[:\-]?\s*\S+/iu.test(text)) return true;

  const tokenCount = text.split(" ").length;
  const isMostlyTitleCase = /^[A-Z0-9][A-Za-z0-9(),\-: ]+$/u.test(text);
  return isMostlyTitleCase && tokenCount >= 2 && tokenCount <= 10 && text.length <= 90;
}

/**
 * @param {unknown} line
 * @returns {boolean}
 */
function isPageMarker(line) {
  return /^--\s*\d+\s+of\s+\d+\s*--$/i.test(normalizeLabel(line));
}

/**
 * @param {unknown} fullText
 * @returns {string[]}
 */
function splitIntoNormalizedLines(fullText) {
  return String(fullText || "")
    .replace(/\f/g, "\n")
    .split(/\r?\n/)
    .map((line) => normalizeLabel(line))
    .filter((line) => line && !isPageMarker(line));
}

/**
 * @param {ParsedPdfData} map
 * @param {string} chapterName
 * @param {string} topicName
 * @returns {TopicNode}
 */
function ensureTopicNode(map, chapterName, topicName) {
  if (!map[chapterName]) {
    map[chapterName] = { topics: {} };
  }

  if (!map[chapterName].topics[topicName]) {
    map[chapterName].topics[topicName] = { content: "", questions: [] };
  }

  return map[chapterName].topics[topicName];
}

/**
 * @param {unknown[]} values
 * @returns {string[]}
 */
function uniqueStrings(values) {
  const seen = new Set();
  const out = [];

  for (const value of values) {
    const clean = normalizeLabel(value);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }

  return out;
}

/**
 * @param {unknown} content
 * @param {unknown} topicName
 * @param {unknown} chapterName
 * @returns {string[]}
 */
function extractQuestionCandidates(content, topicName, chapterName) {
  const cleanContent = normalizeMultiline(content);
  const lines = cleanContent
    .split("\n")
    .map((line) => normalizeLabel(line))
    .filter(Boolean);

  const directQuestions = lines
    .filter((line) => /[?]$/.test(line) || /^[Qq](?:uestion)?\s*\d+/u.test(line))
    .map((line) => ensureQuestionMark(line))
    .filter(isValidQuestion);

  if (directQuestions.length > 0) {
    return uniqueStrings(directQuestions).slice(0, MAX_QUESTION_SEEDS);
  }

  const sentenceCandidates = cleanContent
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((sentence) => normalizeLabel(sentence.replace(/[.!]+$/u, "")))
    .filter((sentence) => sentence.length >= 24);

  const generatedQuestions = sentenceCandidates.map((sentence) => {
    const shortened = sentence.length > 120 ? `${sentence.slice(0, 117).trim()}...` : sentence;
    return ensureQuestionMark(`What is the key concept in: ${shortened}`);
  });

  const merged = uniqueStrings([...directQuestions, ...generatedQuestions]).filter(isValidQuestion);
  if (merged.length > 0) {
    return merged.slice(0, MAX_QUESTION_SEEDS);
  }

  const fallbackTopic = normalizeLabel(topicName) || DEFAULT_TOPIC_TITLE;
  const fallbackChapter = normalizeLabel(chapterName) || DEFAULT_CHAPTER_TITLE;
  return [
    ensureQuestionMark(`What is an important idea in ${fallbackTopic} from ${fallbackChapter}`),
  ];
}

/**
 * Converts PDF text into chapter/topic/content/question structure.
 * @param {string} fullText
 * @returns {ParsedPdfData}
 */
function parsePdfTextToStructuredData(fullText) {
  const lines = splitIntoNormalizedLines(fullText);
  /** @type {ParsedPdfData} */
  const dataMap = {};

  let currentChapter = DEFAULT_CHAPTER_TITLE;
  let currentTopic = DEFAULT_TOPIC_TITLE;
  let hasAnyChapterHeading = false;

  ensureTopicNode(dataMap, currentChapter, currentTopic);

  for (const line of lines) {
    if (isChapterHeading(line)) {
      currentChapter = normalizeLabel(line);
      currentTopic = DEFAULT_TOPIC_TITLE;
      hasAnyChapterHeading = true;
      ensureTopicNode(dataMap, currentChapter, currentTopic);
      continue;
    }

    if (isTopicHeading(line)) {
      currentTopic = normalizeLabel(line);
      ensureTopicNode(dataMap, currentChapter, currentTopic);
      continue;
    }

    const topic = ensureTopicNode(dataMap, currentChapter, currentTopic);
    topic.content = topic.content ? `${topic.content}\n${line}` : line;
  }

  if (hasAnyChapterHeading && dataMap[DEFAULT_CHAPTER_TITLE]) {
    const defaultTopics = Object.values(dataMap[DEFAULT_CHAPTER_TITLE].topics || {});
    const hasDefaultContent = defaultTopics.some((topic) => normalizeMultiline(topic.content));
    if (!hasDefaultContent) {
      delete dataMap[DEFAULT_CHAPTER_TITLE];
    }
  }

  for (const [chapterName, chapterNode] of Object.entries(dataMap)) {
    for (const [topicName, topicNode] of Object.entries(chapterNode.topics || {})) {
      const cleanContent = normalizeMultiline(topicNode.content);
      const seededQuestions = extractQuestionCandidates(cleanContent, topicName, chapterName);
      topicNode.content = cleanContent;
      topicNode.questions = uniqueStrings([
        ...(Array.isArray(topicNode.questions) ? topicNode.questions : []),
        ...seededQuestions,
      ]).filter(isValidQuestion);
    }
  }

  return validateParsedPDFData(dataMap);
}

/**
 * Removes invalid chapters/topics/questions and guarantees safe structure.
 * @param {ParsedPdfData | Record<string, unknown> | null | undefined} rawData
 * @returns {ParsedPdfData}
 */
function validateParsedPDFData(rawData) {
  /** @type {ParsedPdfData} */
  const validated = {};
  if (!rawData || typeof rawData !== "object") {
    return validated;
  }

  for (const [rawChapterName, rawChapterValue] of Object.entries(rawData)) {
    const chapterName = normalizeLabel(rawChapterName);
    const chapterValue = rawChapterValue && typeof rawChapterValue === "object" ? rawChapterValue : {};
    const topicsSource =
      chapterValue && typeof chapterValue === "object" && "topics" in chapterValue
        ? chapterValue.topics
        : {};

    if (!chapterName || !topicsSource || typeof topicsSource !== "object") {
      continue;
    }

    /** @type {Record<string, TopicNode>} */
    const validatedTopics = {};

    for (const [rawTopicName, rawTopicValue] of Object.entries(topicsSource)) {
      const topicName = normalizeLabel(rawTopicName);
      const topicValue = rawTopicValue && typeof rawTopicValue === "object" ? rawTopicValue : {};
      const content = normalizeMultiline(
        topicValue && typeof topicValue === "object" && "content" in topicValue
          ? topicValue.content
          : "",
      );

      let questions = uniqueStrings(
        Array.isArray(topicValue.questions)
          ? topicValue.questions.map((/** @type {unknown} */ q) => ensureQuestionMark(q))
          : [],
      ).filter(isValidQuestion);

      if (questions.length === 0 && content) {
        questions = extractQuestionCandidates(content, topicName, chapterName);
      }

      if (!topicName || questions.length === 0) {
        continue;
      }

      validatedTopics[topicName] = { content, questions };
    }

    const totalQuestions = Object.values(validatedTopics).reduce(
      (count, topicNode) => count + topicNode.questions.length,
      0,
    );

    if (Object.keys(validatedTopics).length === 0 || totalQuestions === 0) {
      continue;
    }

    validated[chapterName] = { topics: validatedTopics };
  }

  return validated;
}

/**
 * @param {Record<string, unknown> | null | undefined} objectMap
 * @param {unknown} wantedKey
 * @returns {string}
 */
function findCaseInsensitiveKey(objectMap, wantedKey) {
  if (!objectMap || typeof objectMap !== "object") return "";
  const normalizedWanted = normalizeKey(wantedKey);
  if (!normalizedWanted) return "";

  for (const key of Object.keys(objectMap)) {
    if (normalizeKey(key) === normalizedWanted) {
      return key;
    }
  }

  return "";
}

/**
 * @param {ParsedPdfData | Record<string, unknown> | null | undefined} parsedData
 * @returns {string[]}
 */
function getValidChapters(parsedData) {
  const validated = validateParsedPDFData(parsedData);
  return Object.keys(validated).filter((chapterName) => {
    const chapter = validated[chapterName];
    if (!chapter || !chapter.topics) return false;
    return Object.values(chapter.topics).some(
      (topicNode) => Array.isArray(topicNode.questions) && topicNode.questions.length > 0,
    );
  });
}

/**
 * @param {ParsedPdfData | Record<string, unknown> | null | undefined} parsedData
 * @param {string} chapterName
 * @returns {string[]}
 */
function getValidTopics(parsedData, chapterName) {
  const validated = validateParsedPDFData(parsedData);
  const chapterKey = findCaseInsensitiveKey(validated, chapterName);
  if (!chapterKey) return [];

  const chapter = validated[chapterKey];
  if (!chapter || !chapter.topics) return [];

  return Object.entries(chapter.topics)
    .filter(([, topicNode]) => Array.isArray(topicNode.questions) && topicNode.questions.length > 0)
    .map(([topicName]) => topicName);
}

/**
 * Returns safe chapter/topic/question selection with silent fallback.
 * @param {ParsedPdfData | Record<string, unknown> | null | undefined} parsedData
 * @param {string} chapterName
 * @param {string} topicName
 * @returns {TopicSelection}
 */
function getQuestions(parsedData, chapterName, topicName) {
  const validated = validateParsedPDFData(parsedData);
  const validChapters = getValidChapters(validated);

  if (validChapters.length === 0) {
    return {
      chapter: "",
      topic: "",
      questions: [],
      content: "",
      usedChapterFallback: true,
      usedTopicFallback: true,
    };
  }

  const matchedChapter = findCaseInsensitiveKey(validated, chapterName);
  const resolvedChapter = matchedChapter || validChapters[0];
  const usedChapterFallback = normalizeKey(resolvedChapter) !== normalizeKey(chapterName);

  const validTopics = getValidTopics(validated, resolvedChapter);
  const chapterTopics = validated[resolvedChapter]?.topics || {};

  const matchedTopic = findCaseInsensitiveKey(chapterTopics, topicName);
  const resolvedTopic = matchedTopic || validTopics[0] || "";
  const usedTopicFallback = normalizeKey(resolvedTopic) !== normalizeKey(topicName);

  const topicNode = chapterTopics[resolvedTopic] || { content: "", questions: [] };

  return {
    chapter: resolvedChapter,
    topic: resolvedTopic,
    questions: Array.isArray(topicNode.questions) ? topicNode.questions : [],
    content: normalizeMultiline(topicNode.content),
    usedChapterFallback,
    usedTopicFallback,
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeQuestionCount(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return 10;
  return Math.max(1, Math.min(50, parsed));
}

/**
 * @param {unknown} chapterName
 * @param {unknown} topicName
 * @param {string} answer
 * @returns {string[]}
 */
function createDistractors(chapterName, topicName, answer) {
  const chapter = normalizeLabel(chapterName) || DEFAULT_CHAPTER_TITLE;
  const topic = normalizeLabel(topicName) || DEFAULT_TOPIC_TITLE;
  return [
    answer,
    `A detail unrelated to ${topic}`,
    `An incorrect statement about ${chapter}`,
    `Cannot be inferred from ${topic}`,
  ];
}

/**
 * Builds local quiz items when AI output is unavailable/invalid.
 * @param {string[]} questionSeeds
 * @param {number} questionCount
 * @param {string} chapterName
 * @param {string} topicName
 * @param {string} content
 * @returns {QuizItem[]}
 */
function buildLocalQuiz(questionSeeds, questionCount, chapterName, topicName, content) {
  const safeSeeds = uniqueStrings(Array.isArray(questionSeeds) ? questionSeeds : []).filter(
    isValidQuestion,
  );
  const requested = normalizeQuestionCount(questionCount);
  const fallbackSeed = ensureQuestionMark(
    `What is a key concept in ${normalizeLabel(topicName) || DEFAULT_TOPIC_TITLE}`,
  );
  const seeds = safeSeeds.length > 0 ? safeSeeds : [fallbackSeed];
  const explanationBase = normalizeLabel(content).slice(0, MAX_EXPLANATION_LENGTH);
  const explanation = explanationBase
    ? `${explanationBase}${explanationBase.endsWith(".") ? "" : "."}`
    : `Generated from uploaded PDF context for ${normalizeLabel(chapterName) || DEFAULT_CHAPTER_TITLE}.`;

  /** @type {QuizItem[]} */
  const quiz = [];

  for (let index = 0; index < requested; index += 1) {
    const rawQuestion = ensureQuestionMark(seeds[index % seeds.length]);
    const answer = `Key point from ${normalizeLabel(topicName) || DEFAULT_TOPIC_TITLE}`;
    const options = createDistractors(chapterName, topicName, answer);
    quiz.push({
      q: rawQuestion,
      options,
      ans: answer,
      exp: explanation,
    });
  }

  return quiz;
}

/**
 * @param {unknown} rawItem
 * @returns {QuizItem | null}
 */
function sanitizeQuizItem(rawItem) {
  if (!rawItem || typeof rawItem !== "object") return null;

  const item = /** @type {Record<string, unknown>} */ (rawItem);
  const questionText = ensureQuestionMark(
    item.q || item.question || item.title || item.prompt || "",
  );
  const options = uniqueStrings(Array.isArray(item.options) ? item.options : []);
  const answerCandidate = normalizeLabel(item.ans || item.answer || options[0] || "");

  if (!questionText || options.length < 2) {
    return null;
  }

  const resolvedAnswer = options.find((option) => normalizeKey(option) === normalizeKey(answerCandidate))
    || options[0];
  const explanation = normalizeLabel(item.exp || item.explanation || "");

  return {
    q: questionText,
    options,
    ans: resolvedAnswer,
    exp: explanation || "Answer derived from selected chapter/topic context.",
  };
}

/**
 * @param {unknown} quizPayload
 * @param {string[]} questionSeeds
 * @param {number} questionCount
 * @param {string} chapterName
 * @param {string} topicName
 * @param {string} content
 * @returns {{ quiz: QuizItem[], usedLocalFallback: boolean }}
 */
function sanitizeQuizOutput(
  quizPayload,
  questionSeeds,
  questionCount,
  chapterName,
  topicName,
  content,
) {
  const requested = normalizeQuestionCount(questionCount);
  const payloadObject =
    quizPayload && typeof quizPayload === "object"
      ? /** @type {Record<string, unknown>} */ (quizPayload)
      : null;
  /** @type {unknown[]} */
  const rawQuizArray = Array.isArray(quizPayload)
    ? quizPayload
    : (payloadObject && Array.isArray(payloadObject.quiz)
      ? /** @type {unknown[]} */ (payloadObject.quiz)
      : []);

  const sanitizedFromAI = /** @type {QuizItem[]} */ (
    rawQuizArray
      .map((item) => sanitizeQuizItem(item))
      .filter((item) => item !== null)
      .slice(0, requested)
  );

  if (sanitizedFromAI.length >= requested) {
    return { quiz: sanitizedFromAI, usedLocalFallback: false };
  }

  const missing = requested - sanitizedFromAI.length;
  const localFill = buildLocalQuiz(questionSeeds, missing, chapterName, topicName, content);
  return {
    quiz: [...sanitizedFromAI, ...localFill],
    usedLocalFallback: localFill.length > 0,
  };
}

/**
 * Generates quiz with strict validation and guaranteed fallback questions.
 * @param {SafeGenerateExamArgs} args
 * @returns {Promise<{ quiz: QuizItem[], chapter: string, topic: string, fallbackApplied: boolean, validation: { usedChapterFallback: boolean, usedTopicFallback: boolean } }>}
 */
async function safeGenerateExam(args) {
  const source = normalizeLabel(args.source).toLowerCase();
  const questionCount = normalizeQuestionCount(args.numQ);

  let resolvedChapter = normalizeLabel(args.chapter);
  let resolvedTopic = normalizeLabel(args.topic);
  /** @type {string[]} */
  let questionSeeds = [];
  let contextText = normalizeMultiline(args.fullPdfText).slice(0, 12000);
  let usedChapterFallback = false;
  let usedTopicFallback = false;

  if (source === "other") {
    let structured = validateParsedPDFData(args.parsedData);
    if (Object.keys(structured).length === 0) {
      structured = parsePdfTextToStructuredData(args.fullPdfText || "");
    }
    const selection = getQuestions(structured, args.chapter || "", args.topic || "");

    if (selection.questions.length > 0) {
      resolvedChapter = selection.chapter;
      resolvedTopic = selection.topic;
      questionSeeds = selection.questions;
      contextText = normalizeMultiline(selection.content || args.fullPdfText).slice(0, 12000);
      usedChapterFallback = selection.usedChapterFallback;
      usedTopicFallback = selection.usedTopicFallback;
    } else {
      usedChapterFallback = true;
      usedTopicFallback = true;
      resolvedChapter = resolvedChapter || DEFAULT_CHAPTER_TITLE;
      resolvedTopic = resolvedTopic || DEFAULT_TOPIC_TITLE;
      questionSeeds = extractQuestionCandidates(args.fullPdfText || "", resolvedTopic, resolvedChapter);
      contextText = normalizeMultiline(args.fullPdfText).slice(0, 12000);
      console.warn(
        "[safeGenerateExam] No valid chapter/topic found. Falling back to PDF-wide context.",
      );
    }
  }

  const aiPayload = {
    source,
    difficulty: args.difficulty,
    numQ: questionCount,
    chapter: resolvedChapter || DEFAULT_CHAPTER_TITLE,
    topic: resolvedTopic || DEFAULT_TOPIC_TITLE,
    className: args.className,
    subject: args.subject,
    pdfText: source === "other" ? contextText : args.fullPdfText || "",
  };

  /** @type {QuizResponse | null} */
  let aiResult = null;

  try {
    aiResult = await args.generateQuizFn(aiPayload);
  } catch (error) {
    console.error(
      "[safeGenerateExam] AI generation call failed:",
      error && typeof error === "object" && "message" in error ? error.message : error,
    );
  }

  const { quiz, usedLocalFallback } = sanitizeQuizOutput(
    aiResult?.quiz,
    questionSeeds,
    questionCount,
    aiPayload.chapter,
    aiPayload.topic,
    contextText,
  );

  if (aiResult?.error) {
    console.warn("[safeGenerateExam] AI returned error. Served local fallback quiz.");
  }

  return {
    quiz,
    chapter: aiPayload.chapter,
    topic: aiPayload.topic,
    fallbackApplied: usedChapterFallback || usedTopicFallback || usedLocalFallback || !!aiResult?.error,
    validation: {
      usedChapterFallback,
      usedTopicFallback,
    },
  };
}

module.exports = {
  parsePdfTextToStructuredData,
  validateParsedPDFData,
  getValidChapters,
  getValidTopics,
  getQuestions,
  safeGenerateExam,
};
