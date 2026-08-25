import Groq from 'groq-sdk';
import { getLatestCandles } from '../tools/snowflake.js';
import { getYahooHistoricalCandles } from '../tools/yahoo.js';
import dotenv from 'dotenv';

dotenv.config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ─── Pattern Detection Helpers ───────────────────────────

// Doji candle (open ≈ close)
const isDoji = (candle) => {
  const body = Math.abs(parseFloat(candle.CLOSE) - parseFloat(candle.OPEN));
  const range = parseFloat(candle.HIGH) - parseFloat(candle.LOW);
  return range > 0 && body / range < 0.1;
};

// Bullish engulfing
const isBullishEngulfing = (prev, curr) => {
  return (
    parseFloat(prev.CLOSE) < parseFloat(prev.OPEN) &&
    parseFloat(curr.CLOSE) > parseFloat(curr.OPEN) &&
    parseFloat(curr.OPEN) < parseFloat(prev.CLOSE) &&
    parseFloat(curr.CLOSE) > parseFloat(prev.OPEN)
  );
};

// Bearish engulfing
const isBearishEngulfing = (prev, curr) => {
  return (
    parseFloat(prev.CLOSE) > parseFloat(prev.OPEN) &&
    parseFloat(curr.CLOSE) < parseFloat(curr.OPEN) &&
    parseFloat(curr.OPEN) > parseFloat(prev.CLOSE) &&
    parseFloat(curr.CLOSE) < parseFloat(prev.OPEN)
  );
};

// Hammer (bullish reversal)
const isHammer = (candle) => {
  const body = Math.abs(parseFloat(candle.CLOSE) - parseFloat(candle.OPEN));
  const lowerWick = Math.min(parseFloat(candle.OPEN), parseFloat(candle.CLOSE)) - parseFloat(candle.LOW);
  const upperWick = parseFloat(candle.HIGH) - Math.max(parseFloat(candle.OPEN), parseFloat(candle.CLOSE));
  return lowerWick > body * 2 && upperWick < body * 0.5;
};

// Shooting star (bearish reversal)
const isShootingStar = (candle) => {
  const body = Math.abs(parseFloat(candle.CLOSE) - parseFloat(candle.OPEN));
  const upperWick = parseFloat(candle.HIGH) - Math.max(parseFloat(candle.OPEN), parseFloat(candle.CLOSE));
  const lowerWick = Math.min(parseFloat(candle.OPEN), parseFloat(candle.CLOSE)) - parseFloat(candle.LOW);
  return upperWick > body * 2 && lowerWick < body * 0.5;
};

// Higher highs and higher lows (uptrend)
const isHigherHighsHigherLows = (candles) => {
  if (candles.length < 4) return false;
  const last4 = candles.slice(-4);
  return (
    parseFloat(last4[2].HIGH) > parseFloat(last4[0].HIGH) &&
    parseFloat(last4[3].HIGH) > parseFloat(last4[1].HIGH) &&
    parseFloat(last4[2].LOW)  > parseFloat(last4[0].LOW)  &&
    parseFloat(last4[3].LOW)  > parseFloat(last4[1].LOW)
  );
};

// Lower highs and lower lows (downtrend)
const isLowerHighsLowerLows = (candles) => {
  if (candles.length < 4) return false;
  const last4 = candles.slice(-4);
  return (
    parseFloat(last4[2].HIGH) < parseFloat(last4[0].HIGH) &&
    parseFloat(last4[3].HIGH) < parseFloat(last4[1].HIGH) &&
    parseFloat(last4[2].LOW)  < parseFloat(last4[0].LOW)  &&
    parseFloat(last4[3].LOW)  < parseFloat(last4[1].LOW)
  );
};

// Inside bar (consolidation)
const isInsideBar = (prev, curr) => {
  return (
    parseFloat(curr.HIGH) < parseFloat(prev.HIGH) &&
    parseFloat(curr.LOW)  > parseFloat(prev.LOW)
  );
};

// Strong bullish candle
const isStrongBullish = (candle) => {
  const body = parseFloat(candle.CLOSE) - parseFloat(candle.OPEN);
  const range = parseFloat(candle.HIGH) - parseFloat(candle.LOW);
  return body > 0 && range > 0 && body / range > 0.7;
};

// Strong bearish candle
const isStrongBearish = (candle) => {
  const body = parseFloat(candle.OPEN) - parseFloat(candle.CLOSE);
  const range = parseFloat(candle.HIGH) - parseFloat(candle.LOW);
  return body > 0 && range > 0 && body / range > 0.7;
};

// ─── Detect All Patterns ─────────────────────────────────
const detectPatterns = (candles) => {
  const patterns = [];
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  // Single candle patterns
  if (isDoji(last)) {
    patterns.push({ name: 'DOJI', type: 'NEUTRAL', candle: 'current', description: 'Indecision in market' });
  }
  if (isHammer(last)) {
    patterns.push({ name: 'HAMMER', type: 'BULLISH', candle: 'current', description: 'Potential bullish reversal' });
  }
  if (isShootingStar(last)) {
    patterns.push({ name: 'SHOOTING_STAR', type: 'BEARISH', candle: 'current', description: 'Potential bearish reversal' });
  }
  if (isStrongBullish(last)) {
    patterns.push({ name: 'STRONG_BULLISH_CANDLE', type: 'BULLISH', candle: 'current', description: 'Strong buying pressure' });
  }
  if (isStrongBearish(last)) {
    patterns.push({ name: 'STRONG_BEARISH_CANDLE', type: 'BEARISH', candle: 'current', description: 'Strong selling pressure' });
  }

  // Two candle patterns
  if (prev && isBullishEngulfing(prev, last)) {
    patterns.push({ name: 'BULLISH_ENGULFING', type: 'BULLISH', candle: 'last_2', description: 'Bulls overpowered bears' });
  }
  if (prev && isBearishEngulfing(prev, last)) {
    patterns.push({ name: 'BEARISH_ENGULFING', type: 'BEARISH', candle: 'last_2', description: 'Bears overpowered bulls' });
  }
  if (prev && isInsideBar(prev, last)) {
    patterns.push({ name: 'INSIDE_BAR', type: 'NEUTRAL', candle: 'last_2', description: 'Consolidation / breakout pending' });
  }

  // Multi candle patterns
  if (isHigherHighsHigherLows(candles)) {
    patterns.push({ name: 'HIGHER_HIGHS_HIGHER_LOWS', type: 'BULLISH', candle: 'last_4', description: 'Classic uptrend structure' });
  }
  if (isLowerHighsLowerLows(candles)) {
    patterns.push({ name: 'LOWER_HIGHS_LOWER_LOWS', type: 'BEARISH', candle: 'last_4', description: 'Classic downtrend structure' });
  }

  return patterns;
};

// ─── Pattern Agent ───────────────────────────────────────
export const patternAgent = async (symbol, timeframe = '1_hour', inputCandles = null) => {
  try {
    console.log(`🔍 Pattern Agent scanning ${symbol} on ${timeframe}...`);

    // Step 1: Use provided live candles or fetch from Yahoo / Snowflake
    let candles = inputCandles;
    if (!candles || candles.length < 5) {
      const yahooRes = await getYahooHistoricalCandles(symbol, timeframe, 30).catch(() => null);
      if (yahooRes && yahooRes.candles && yahooRes.candles.length >= 5) {
        candles = yahooRes.candles;
      } else {
        candles = await getLatestCandles(symbol, timeframe, 50).catch(() => []);
      }
    }

    if (!candles || candles.length < 10) {
      return {
        error: `Not enough data for pattern analysis of ${symbol}`,
        symbol,
        timeframe,
      };
    }

    // Step 2: Detect patterns
    const patterns = detectPatterns(candles);

    // Step 3: Prepare data for Groq
    const last15 = candles.slice(-15).map(c => ({
      time:  c.BUCKET,
      open:  parseFloat(c.OPEN),
      high:  parseFloat(c.HIGH),
      low:   parseFloat(c.LOW),
      close: parseFloat(c.CLOSE),
      volume: parseFloat(c.VOLUME),
    }));

    const bullishPatterns = patterns.filter(p => p.type === 'BULLISH');
    const bearishPatterns = patterns.filter(p => p.type === 'BEARISH');
    const neutralPatterns = patterns.filter(p => p.type === 'NEUTRAL');

    // Step 4: Ask Groq for deeper pattern analysis
    const prompt = `
You are an expert candlestick pattern analyst for Indian markets.
Analyze the following price action for ${symbol} on ${timeframe} timeframe.

LAST 15 CANDLES:
${JSON.stringify(last15, null, 2)}

DETECTED PATTERNS:
Bullish: ${JSON.stringify(bullishPatterns)}
Bearish: ${JSON.stringify(bearishPatterns)}
Neutral: ${JSON.stringify(neutralPatterns)}

Based on this price action:
1. Identify any additional chart patterns (triangle, flag, wedge, double top/bottom etc)
2. Assess the overall pattern bias
3. Identify potential breakout direction
4. Suggest key levels to watch

Respond in this EXACT JSON format:
{
  "detected_patterns": ${JSON.stringify(patterns)},
  "additional_patterns": [
    {"name": "<pattern name>", "type": "BULLISH|BEARISH|NEUTRAL", "description": "<brief description>"}
  ],
  "pattern_bias": "BULLISH|BEARISH|NEUTRAL",
  "pattern_strength": "STRONG|MODERATE|WEAK",
  "breakout_direction": "UP|DOWN|SIDEWAYS",
  "breakout_probability": <0-100>,
  "key_level_to_watch": <price number>,
  "price_target": <price number>,
  "stop_loss": <price number>,
  "pattern_summary": "<2-3 sentence summary of what patterns are showing>",
  "confidence": <0-100>
}

Respond ONLY with valid JSON. No explanation outside JSON.
    `;

    let response;
    const modelsToTry = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'groq/compound', 'groq/compound-mini'];
    for (const model of modelsToTry) {
      try {
        response = await groq.chat.completions.create({
          model,
          messages: [
            {
              role: 'system',
              content: 'You are an expert candlestick and chart pattern analyst for Indian stock markets. Always respond with valid JSON only.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 4000,
        });
        if (response && response.choices && response.choices[0]) break;
      } catch (err) {
        console.warn(`⚠️ Pattern Agent model '${model}' failed/rate limited: ${err.message}. Trying next fallback...`);
      }
    }

    // Step 5: Parse response cleanly
    const rawText = response.choices[0].message.content.trim();
    let cleanText = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '');
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
    const patternAnalysis = JSON.parse(cleanText);

    console.log(`✅ Pattern Agent done for ${symbol}:`,
      patternAnalysis.pattern_bias,
      patternAnalysis.confidence + '%'
    );

    return {
      symbol,
      timeframe,
      patterns_found:   patterns.length,
      bullish_count:    bullishPatterns.length,
      bearish_count:    bearishPatterns.length,
      neutral_count:    neutralPatterns.length,
      pattern_analysis: patternAnalysis,
      last_candle:      last15[last15.length - 1],
    };

  } catch (error) {
    console.error('❌ Pattern Agent error:', error.message);
    return {
      error: error.message,
      symbol,
      timeframe,
    };
  }
};