const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT =
  "You are the official helpful customer support AI for 'Bidify', a premium live auction and bidding app in Pakistan. Answer basic questions about bidding, wallets, and account settings politely and concisely.";

function getApiKey() {
  return process.env.EXPO_PUBLIC_GEMINI_API_KEY?.trim() || '';
}

function buildContents(messages) {
  return messages.map((m) => ({
    role: m.sender === 'user' ? 'user' : 'model',
    parts: [{ text: m.text }],
  }));
}

/**
 * Sends conversation history to Gemini and returns the assistant reply text.
 * @param {Array<{ sender: 'user' | 'bot', text: string }>} messages
 */
export async function fetchGeminiReply(messages) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      'Gemini API key is not configured. Add EXPO_PUBLIC_GEMINI_API_KEY to your .env file and restart Expo with --clear.'
    );
  }

  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: buildContents(messages),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 512,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const errMsg =
      data?.error?.message ||
      `Gemini request failed (${res.status})`;
    throw new Error(errMsg);
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p?.text)
    .filter(Boolean)
    .join('')
    ?.trim();

  if (!text) {
    throw new Error('No response from Bidify AI. Please try again.');
  }

  return text;
}
