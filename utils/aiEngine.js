const { GoogleGenerativeAI } = require("@google/generative-ai");
require("../env");

const DEFAULT_MODEL_NAME = "gemini-2.5-flash";

let cachedApiKey = null;
let cachedModelName = null;
let cachedModel = null;

function getModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { error: "GEMINI_API_KEY is missing. Add it to .env or env vars." };
  }

  const modelName = process.env.GEMINI_MODEL || DEFAULT_MODEL_NAME;

  if (cachedModel && cachedApiKey === apiKey && cachedModelName === modelName) {
    return { model: cachedModel, modelName };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  cachedModel = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: "application/json" },
  });
  cachedApiKey = apiKey;
  cachedModelName = modelName;

  return { model: cachedModel, modelName };
}

function parseJsonResponse(responseText) {
  const cleanedText = String(responseText || "")
    .replace(/```json\\s*/g, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleanedText);
  } catch {
    const first = cleanedText.indexOf("{");
    const last = cleanedText.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      return JSON.parse(cleanedText.slice(first, last + 1));
    }
    throw new Error("Model returned non-JSON content.");
  }
}

const generateQuiz = async (data) => {
  const {
    source,
    difficulty,
    numQ,
    chapter,
    topic,
    pdfText,
    className,
    subject,
  } = data;

  const { model, modelName, error: modelError } = getModel();
  if (modelError) {
    return { quiz: [], error: modelError };
  }

  const questionCount = Math.min(
    50,
    Math.max(1, Number.parseInt(numQ, 10) || 10),
  );

  const baseSystemInstruction = `
        You are an expert exam setter. Create a multiple-choice quiz with ${questionCount} questions.
        Difficulty Level: ${difficulty || "medium"}.

        OUTPUT JSON ONLY. FORMAT:
        {
            "quiz": [
                {
                    "q": "Question?",
                    "options": ["A", "B", "C", "D"],
                    "ans": "Correct Option String",
                    "exp": "Explanation"
                }
            ]
        }
    `;

  let userPrompt = "";

  if (source === "ncert") {
    userPrompt = `
        ${baseSystemInstruction}
        CONTEXT: Class ${className}, Subject: ${subject}, Chapter: ${chapter}, Topic: ${topic}.
        Strictly follow NCERT syllabus.
        `;
  } else {
    userPrompt = `
        ${baseSystemInstruction}
        CONTEXT: Chapter: ${chapter}, Topic: ${topic}.
        CONTENT: ${pdfText ? pdfText.substring(0, 10000) : "No text provided, generate based on chapter name."}
        `;
  }

  try {
    const result = await model.generateContent(userPrompt);
    const responseText = result.response.text();
    return parseJsonResponse(responseText);
  } catch (error) {
    console.error("AI Engine Error:", error?.message || error);
    return {
      quiz: [],
      error: `AI Generation failed on model ${modelName}. Check terminal logs for details.`,
    };
  }
};

module.exports = { generateQuiz };
