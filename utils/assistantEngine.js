const { GoogleGenerativeAI } = require('@google/generative-ai');
require('../env');

const DEFAULT_MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

let cachedModel = null;
let cachedApiKey = '';
let cachedModelName = '';

function getAssistantModel() {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const modelName = String(process.env.GEMINI_MODEL || DEFAULT_MODEL_NAME).trim();
  if (!apiKey) {
    return { model: null, modelName, error: 'GEMINI_API_KEY is missing.' };
  }

  if (cachedModel && cachedApiKey === apiKey && cachedModelName === modelName) {
    return { model: cachedModel, modelName, error: null };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  cachedModel = genAI.getGenerativeModel({ model: modelName });
  cachedApiKey = apiKey;
  cachedModelName = modelName;
  return { model: cachedModel, modelName, error: null };
}

function buildFallbackAnswer(question) {
  const cleanQuestion = String(question || '').trim();
  return `I could not use AI right now, but here is a quick guidance for your doubt: "${cleanQuestion}". Please review the chapter summary, key formulas/definitions, and solve 3 similar examples step-by-step.`;
}

async function solveDoubt(question) {
  const { model, modelName, error } = getAssistantModel();
  const cleanQuestion = String(question || '').trim();

  if (!model || error) {
    return {
      answer: buildFallbackAnswer(cleanQuestion),
      status: 'fallback',
      modelUsed: 'fallback',
    };
  }

  const prompt = `
You are a concise study assistant for school assessments.
Answer the student's doubt clearly in simple language.
If relevant, provide short steps and one small example.
Keep answer under 180 words.

Student doubt: ${cleanQuestion}
`;

  try {
    const result = await model.generateContent(prompt);
    const text = String(result?.response?.text?.() || '').trim();
    if (!text) {
      return {
        answer: buildFallbackAnswer(cleanQuestion),
        status: 'fallback',
        modelUsed: modelName,
      };
    }

    return {
      answer: text,
      status: 'resolved',
      modelUsed: modelName,
    };
  } catch {
    return {
      answer: buildFallbackAnswer(cleanQuestion),
      status: 'fallback',
      modelUsed: modelName,
    };
  }
}

module.exports = { solveDoubt };
