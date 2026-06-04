const GEMINI_MODEL = process.env.GEMINI_DISPUTE_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const DISPUTE_SYSTEM_PROMPT = `You are the Bidify Escrow Dispute Assistant for a live-auction marketplace in Pakistan.

Your job:
- Analyze the user's issue about auction delivery and escrow funds (currently frozen).
- If it sounds like a simple misunderstanding (forgot delivery OTP, app lag, buyer has not revealed OTP yet, seller waiting for code), give clear step-by-step guidance to complete delivery safely inside Bidify.
- If it sounds like a genuine scam, item not received, wrong item, or serious fraud, clearly state that funds are locked in escrow, you are escalating to a human Bidify administrator, and they should upload any proof photos in this chat.
- Be empathetic, concise (under 120 words), and never promise outcomes only an admin can guarantee.
- Do not ask for passwords or payments outside the app.`;

function getGeminiApiKey() {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.EXPO_PUBLIC_GEMINI_API_KEY?.trim() ||
    ''
  );
}

function buildGeminiContents(conversationHistory, userMessage) {
  const contents = [];
  for (const turn of conversationHistory || []) {
    const text = String(turn?.text || turn?.body || '').trim();
    if (!text) continue;
    const role = turn.role === 'user' || turn.sender === 'user' ? 'user' : 'model';
    contents.push({ role, parts: [{ text }] });
  }
  const latest = String(userMessage || '').trim();
  if (latest) {
    const last = contents[contents.length - 1];
    if (!last || last.role !== 'user' || last.parts[0].text !== latest) {
      contents.push({ role: 'user', parts: [{ text: latest }] });
    }
  }
  return contents;
}

/**
 * @param {{ orderContext: object, conversationHistory: Array, userMessage: string }} params
 */
async function generateDisputeAiReply({ orderContext, conversationHistory, userMessage }) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error(
      'Gemini API key missing. Set GEMINI_API_KEY or EXPO_PUBLIC_GEMINI_API_KEY in .env and restart npm run api.'
    );
  }

  const contextBlock = orderContext
    ? `Order context (JSON): ${JSON.stringify(orderContext)}`
    : 'Order context: unavailable';

  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    systemInstruction: {
      parts: [{ text: `${DISPUTE_SYSTEM_PROMPT}\n\n${contextBlock}` }],
    },
    contents: buildGeminiContents(conversationHistory, userMessage),
    generationConfig: {
      temperature: 0.45,
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
    const errMsg = data?.error?.message || `Gemini request failed (${res.status})`;
    throw new Error(errMsg);
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p?.text)
    .filter(Boolean)
    .join('')
    ?.trim();

  if (!text) {
    throw new Error('AI assistant returned an empty response.');
  }

  return text;
}

module.exports = {
  generateDisputeAiReply,
  getGeminiApiKey,
  DISPUTE_SYSTEM_PROMPT,
};
