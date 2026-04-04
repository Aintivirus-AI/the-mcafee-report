/**
 * Lightweight English translation for non-English content.
 * Uses OpenAI gpt-4o-mini to detect language and translate in a single call.
 */

import OpenAI from "openai";

let _openaiInstance: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openaiInstance) {
    _openaiInstance = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openaiInstance;
}

interface TranslationResult {
  title: string;
  description: string;
  translated: boolean;
  detectedLanguage: string;
}

/**
 * Detect if the title + description are in English. If not, translate both
 * to English in a single API call. Returns the original text unchanged if
 * already in English.
 */
export async function ensureEnglish(
  title: string,
  description: string
): Promise<TranslationResult> {
  if (!title && !description) {
    return { title, description, translated: false, detectedLanguage: "en" };
  }

  // Quick heuristic: if the text is mostly ASCII letters, likely English
  const sample = (title + " " + description).slice(0, 300);
  const asciiLetters = sample.replace(/[^a-zA-Z]/g, "").length;
  const totalChars = sample.replace(/\s/g, "").length;

  if (totalChars > 0 && asciiLetters / totalChars > 0.85) {
    // Very likely English — skip the API call
    return { title, description, translated: false, detectedLanguage: "en" };
  }

  try {
    const completion = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      max_tokens: 600,
      messages: [
        {
          role: "system",
          content: `You are a translation assistant. You will receive a title and description that may be in any language.

1. Detect the language.
2. If it is already English, return the original text unchanged.
3. If it is NOT English, translate both the title and description into natural, fluent English.

Respond in EXACTLY this JSON format (no markdown, no code fences):
{"language":"<detected language code>","title":"<english title>","description":"<english description>"}`,
        },
        {
          role: "user",
          content: `Title: ${title.slice(0, 300)}\nDescription: ${description.slice(0, 500)}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) {
      console.warn("[Translator] Empty response from OpenAI");
      return { title, description, translated: false, detectedLanguage: "unknown" };
    }

    const parsed = JSON.parse(raw);
    const lang = parsed.language || "unknown";
    const isEnglish = lang.toLowerCase().startsWith("en");

    return {
      title: parsed.title || title,
      description: parsed.description || description,
      translated: !isEnglish,
      detectedLanguage: lang,
    };
  } catch (error) {
    console.warn("[Translator] Translation failed, using original text:", error);
    return { title, description, translated: false, detectedLanguage: "unknown" };
  }
}
