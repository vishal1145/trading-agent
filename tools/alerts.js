import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';

dotenv.config();

let anthropicInstance = null;
let aiInstance = null;
let groqInstance = null;

function getAnthropicClient() {
  if (!anthropicInstance && process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_key') {
    anthropicInstance = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicInstance;
}

function getGeminiClient() {
  if (!aiInstance && process.env.GEMINI_API_KEY) {
    aiInstance = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return aiInstance;
}

function getGroqClient() {
  if (!groqInstance && process.env.GROQ_API_KEY) {
    groqInstance = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqInstance;
}

// ─── Multi-Provider Priority LLM Completion Helper ────────
// Priority: 1) OpenRouter (OpenAI)  2) Anthropic Claude  3) Gemini  4) Groq
export async function runLLMCompletion({
  systemPrompt,
  prompt,
  maxTokens = 2500,
  temperature = 0.1,
}) {
  // Priority 1: OpenRouter — gpt-oss-120b
  if (process.env.OPENROUTER_API_KEY) {
    const openRouterModels = ['openai/gpt-oss-120b'];

    for (const model of openRouterModels) {
      try {
        console.log(`🌐 Requesting LLM: OpenRouter (${model})...`);
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://finvedas.com',
            'X-Title': 'Finvedas Trading Agent',
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
          }),
        });

        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) {
          console.log(`✅ OpenRouter (${model}) response received.`);
          return text;
        }
        if (data?.error) {
          throw new Error(JSON.stringify(data.error));
        }
      } catch (err) {
        console.warn(`⚠️ OpenRouter model '${model}' failed: ${String(err.message).substring(0, 120)}. Trying fallback...`);
      }
    }
  }

  // Priority 2: Anthropic Claude
  const anthropicClient = getAnthropicClient();
  if (anthropicClient) {
    const anthropicModels = ['claude-sonnet-4-6'];

    for (const model of anthropicModels) {
      try {
        console.log(`🧠 Fallback LLM: Anthropic (${model})...`);
        const response = await anthropicClient.messages.create({
          model,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt,
          messages: [
            { role: 'user', content: prompt },
          ],
        });

        const text = response?.content?.[0]?.text;
        if (text) {
          console.log(`✅ Anthropic (${model}) response received.`);
          return text;
        }
      } catch (err) {
        console.warn(`⚠️ Anthropic model '${model}' failed: ${err.message?.substring(0, 120) || err}. Trying fallback...`);
      }
    }
  }

  // Priority 2: Gemini (Secondary Fallback)
  const geminiClient = getGeminiClient();
  if (geminiClient) {
    const geminiModels = ['gemini-3.5-flash-lite'];

    for (const model of geminiModels) {
      try {
        console.log(`🤖 Fallback LLM: Gemini (${model})...`);
        const res = await geminiClient.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: systemPrompt,
            temperature,
            maxOutputTokens: maxTokens,
          },
        });

        if (res && res.text) {
          console.log(`✅ Gemini (${model}) response received.`);
          return res.text;
        }
      } catch (err) {
        console.warn(`⚠️ Gemini model '${model}' failed/rate limited: ${err.message.substring(0, 100)}. Trying fallback...`);
      }
    }
  }

  // Priority 3: Groq (Tertiary Fallback)
  const groqClient = getGroqClient();
  if (groqClient) {
    const groqModels = [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
    ];

    for (const model of groqModels) {
      try {
        console.log(`🔄 Fallback LLM: Groq (${model})...`);
        const response = await groqClient.chat.completions.create({
          model,
          max_tokens: maxTokens,
          temperature,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        });

        if (response?.choices?.[0]?.message?.content) {
          console.log(`✅ Groq (${model}) response received.`);
          return response.choices[0].message.content;
        }
      } catch (err) {
        console.warn(`⚠️ Groq model '${model}' failed: ${err.message.substring(0, 120)}. Trying next...`);
      }
    }
  }

  throw new Error('All LLM providers (OpenRouter, Anthropic, Gemini & Groq) failed to generate a response.');
}

export function parseLLMJson(rawText) {
  if (!rawText) throw new Error('Empty response from LLM');

  let cleanText = rawText.trim();
  cleanText = cleanText.replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (cleanText.includes('<think>')) {
    const idx = cleanText.lastIndexOf('</think>');
    if (idx !== -1) cleanText = cleanText.substring(idx + 8);
    else {
      const braceIdx = cleanText.indexOf('{');
      if (braceIdx !== -1) cleanText = cleanText.substring(braceIdx);
    }
  }

  cleanText = cleanText.replace(/```json|```/gi, '').trim();

  const firstBrace = cleanText.indexOf('{');
  const lastBrace = cleanText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleanText = cleanText.substring(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleanText);
}


// ─── Telegram Alert ──────────────────────────────────────
const sendTelegramAlert = async (message) => {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.log('⚠️ Telegram not configured — skipping alert');
      return false;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    const data = await response.json();

    if (data.ok) {
      console.log('✅ Telegram alert sent!');
      return true;
    } else {
      console.error('❌ Telegram error:', data.description);
      return false;
    }

  } catch (error) {
    console.error('❌ Telegram alert failed:', error.message);
    return false;
  }
};

// ─── Format Alert Message ────────────────────────────────
const formatAlertMessage = ({
  symbol,
  signal,
  direction,
  confidence,
  entry,
  target,
  stopLoss,
  action,
  reasoning,
}) => {
  const emoji = signal === 'BUY' ? '🟢' :
    signal === 'SELL' ? '🔴' : '🟡';

  const dirEmoji = direction === 'BULLISH' ? '📈' :
    direction === 'BEARISH' ? '📉' : '➡️';

  const confidenceBar = '█'.repeat(Math.floor(confidence / 10)) +
    '░'.repeat(10 - Math.floor(confidence / 10));

  return `
${emoji} <b>FINVEDAS AI SIGNAL</b> ${emoji}

📌 <b>Symbol:</b> ${symbol}
${dirEmoji} <b>Signal:</b> ${signal} (${direction})
🎯 <b>Confidence:</b> ${confidence}%
[${confidenceBar}]

💰 <b>Entry:</b>     ₹${entry || 'Market'}
🎯 <b>Target:</b>    ₹${target || 'N/A'}
🛑 <b>Stop Loss:</b> ₹${stopLoss || 'N/A'}

⚡ <b>Action:</b>
${action}

🧠 <b>Reasoning:</b>
${reasoning}

⏰ <b>Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST

⚠️ <i>AI analysis only. Not financial advice. Trade at your own risk.</i>

🤖 <i>Powered by Finvedas AI</i>
  `.trim();
};

// ─── Format Summary Message ──────────────────────────────
const formatSummaryMessage = (signals) => {
  const buySignals = signals.filter(s => s.final_signal === 'BUY');
  const sellSignals = signals.filter(s => s.final_signal === 'SELL');
  const holdSignals = signals.filter(s => s.final_signal === 'HOLD');

  let message = `
📊 <b>FINVEDAS AI - MARKET SUMMARY</b>

⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST

🟢 <b>BUY Signals (${buySignals.length}):</b>
${buySignals.map(s => `  • ${s.symbol} — ${s.confidence}% confidence`).join('\n') || '  None'}

🔴 <b>SELL Signals (${sellSignals.length}):</b>
${sellSignals.map(s => `  • ${s.symbol} — ${s.confidence}% confidence`).join('\n') || '  None'}

🟡 <b>HOLD (${holdSignals.length}):</b>
${holdSignals.map(s => `  • ${s.symbol}`).join('\n') || '  None'}

📈 <b>Market Bias:</b> ${buySignals.length > sellSignals.length ? '🟢 BULLISH' :
      sellSignals.length > buySignals.length ? '🔴 BEARISH' :
        '🟡 NEUTRAL'
    }

⚠️ <i>AI analysis only. Not financial advice.</i>
🤖 <i>Powered by Finvedas AI</i>
  `.trim();

  return message;
};

// ─── Main Send Alert Function ────────────────────────────
export const sendAlert = async ({
  symbol,
  signal,
  direction,
  confidence,
  entry,
  target,
  stopLoss,
  action,
  reasoning,
}) => {
  try {
    console.log(`📱 Sending alert for ${symbol} — ${signal}...`);

    const message = formatAlertMessage({
      symbol,
      signal,
      direction,
      confidence,
      entry,
      target,
      stopLoss,
      action,
      reasoning,
    });

    await sendTelegramAlert(message);

  } catch (error) {
    console.error('❌ Alert error:', error.message);
  }
};

// ─── Send Market Summary ─────────────────────────────────
export const sendMarketSummary = async (signals) => {
  try {
    console.log('📊 Sending market summary...');
    const message = formatSummaryMessage(signals);
    await sendTelegramAlert(message);
  } catch (error) {
    console.error('❌ Summary alert error:', error.message);
  }
};

// ─── Send Custom Message ─────────────────────────────────
export const sendCustomAlert = async (message) => {
  try {
    await sendTelegramAlert(message);
  } catch (error) {
    console.error('❌ Custom alert error:', error.message);
  }
};

// ─── Send Error Alert ────────────────────────────────────
export const sendErrorAlert = async (error, context = '') => {
  try {
    const message = `
⚠️ <b>FINVEDAS AI - ERROR ALERT</b>

❌ <b>Error:</b> ${error.message || error}
📍 <b>Context:</b> ${context}
⏰ <b>Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST

🔧 <i>Check server logs for details</i>
    `.trim();

    await sendTelegramAlert(message);
  } catch (err) {
    console.error('❌ Error alert failed:', err.message);
  }
};