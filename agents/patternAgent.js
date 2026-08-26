import { runLLMCompletion, parseLLMJson } from '../tools/alerts.js';
import { getLatestCandles } from '../tools/snowflake.js';
import { getYahooHistoricalCandles } from '../tools/yahoo.js';
import dotenv from 'dotenv';

dotenv.config();

// ─── Utility Helpers ─────────────────────────────────────
const pf = (v) => parseFloat(v);
const body = (c) => Math.abs(pf(c.CLOSE) - pf(c.OPEN));
const range = (c) => pf(c.HIGH) - pf(c.LOW);
const isGreen = (c) => pf(c.CLOSE) > pf(c.OPEN);
const isRed = (c) => pf(c.CLOSE) < pf(c.OPEN);
const upperWick = (c) => pf(c.HIGH) - Math.max(pf(c.OPEN), pf(c.CLOSE));
const lowerWick = (c) => Math.min(pf(c.OPEN), pf(c.CLOSE)) - pf(c.LOW);

// ─── ATR (Average True Range) for Dynamic Thresholds ─────
const calculateATR = (candles, period = 14) => {
  if (candles.length < period + 1) return null;
  let trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const h = pf(candles[i].HIGH), l = pf(candles[i].LOW);
    const pc = pf(candles[i - 1].CLOSE);
    trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return trSum / period;
};

// ─── Average Volume over N candles ───────────────────────
const avgVolume = (candles, period = 20) => {
  const slice = candles.slice(-period);
  if (slice.length === 0) return 1;
  return slice.reduce((s, c) => s + pf(c.VOLUME), 0) / slice.length;
};

// ─── Trend Context (last N candles) ──────────────────────
const getTrendContext = (candles, idx, lookback = 10) => {
  if (idx < lookback) return 'UNKNOWN';
  const start = pf(candles[idx - lookback].CLOSE);
  const end = pf(candles[idx].CLOSE);
  const change = (end - start) / start;
  if (change > 0.01) return 'UPTREND';
  if (change < -0.01) return 'DOWNTREND';
  return 'SIDEWAYS';
};

// ─── RSI (inline, lightweight) ───────────────────────────
const quickRSI = (candles, idx, period = 14) => {
  if (idx < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = idx - period; i < idx; i++) {
    const diff = pf(candles[i + 1].CLOSE) - pf(candles[i].CLOSE);
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
};

// ─── Pattern Detection Helpers (ATR-Adjusted) ────────────

const isDoji = (c, atr) => {
  const r = range(c);
  if (r === 0) return false;
  const threshold = atr ? Math.min(0.15, atr * 0.05 / r) : 0.1;
  return body(c) / r < Math.max(threshold, 0.1);
};

const isHammer = (c, atr) => {
  const b = body(c), lw = lowerWick(c), uw = upperWick(c);
  const minWickRatio = atr ? 1.8 : 2;
  return b > 0 && lw > b * minWickRatio && uw < b * 0.5;
};

const isShootingStar = (c, atr) => {
  const b = body(c), uw = upperWick(c), lw = lowerWick(c);
  const minWickRatio = atr ? 1.8 : 2;
  return b > 0 && uw > b * minWickRatio && lw < b * 0.5;
};

const isStrongBullish = (c) => {
  const b = pf(c.CLOSE) - pf(c.OPEN), r = range(c);
  return b > 0 && r > 0 && b / r > 0.7;
};

const isStrongBearish = (c) => {
  const b = pf(c.OPEN) - pf(c.CLOSE), r = range(c);
  return b > 0 && r > 0 && b / r > 0.7;
};

const isBullishEngulfing = (prev, curr) => {
  return isRed(prev) && isGreen(curr) &&
    pf(curr.OPEN) < pf(prev.CLOSE) && pf(curr.CLOSE) > pf(prev.OPEN);
};

const isBearishEngulfing = (prev, curr) => {
  return isGreen(prev) && isRed(curr) &&
    pf(curr.OPEN) > pf(prev.CLOSE) && pf(curr.CLOSE) < pf(prev.OPEN);
};

const isInsideBar = (prev, curr) => {
  return pf(curr.HIGH) < pf(prev.HIGH) && pf(curr.LOW) > pf(prev.LOW);
};

// ─── NEW: 3-Candle Patterns ──────────────────────────────

const isMorningStar = (c1, c2, c3) => {
  // c1=big red, c2=small body (star), c3=big green closing above c1 midpoint
  const mid1 = (pf(c1.OPEN) + pf(c1.CLOSE)) / 2;
  return isRed(c1) && body(c1) / range(c1) > 0.5 &&
    body(c2) / range(c2) < 0.3 &&
    isGreen(c3) && pf(c3.CLOSE) > mid1 && body(c3) / range(c3) > 0.5;
};

const isEveningStar = (c1, c2, c3) => {
  const mid1 = (pf(c1.OPEN) + pf(c1.CLOSE)) / 2;
  return isGreen(c1) && body(c1) / range(c1) > 0.5 &&
    body(c2) / range(c2) < 0.3 &&
    isRed(c3) && pf(c3.CLOSE) < mid1 && body(c3) / range(c3) > 0.5;
};

const isThreeWhiteSoldiers = (c1, c2, c3) => {
  return isGreen(c1) && isGreen(c2) && isGreen(c3) &&
    pf(c2.CLOSE) > pf(c1.CLOSE) && pf(c3.CLOSE) > pf(c2.CLOSE) &&
    body(c1) / range(c1) > 0.5 && body(c2) / range(c2) > 0.5 && body(c3) / range(c3) > 0.5;
};

const isThreeBlackCrows = (c1, c2, c3) => {
  return isRed(c1) && isRed(c2) && isRed(c3) &&
    pf(c2.CLOSE) < pf(c1.CLOSE) && pf(c3.CLOSE) < pf(c2.CLOSE) &&
    body(c1) / range(c1) > 0.5 && body(c2) / range(c2) > 0.5 && body(c3) / range(c3) > 0.5;
};

const isTweezerTop = (prev, curr) => {
  const tolerance = range(prev) * 0.05;
  return Math.abs(pf(prev.HIGH) - pf(curr.HIGH)) < tolerance &&
    isGreen(prev) && isRed(curr);
};

const isTweezerBottom = (prev, curr) => {
  const tolerance = range(prev) * 0.05;
  return Math.abs(pf(prev.LOW) - pf(curr.LOW)) < tolerance &&
    isRed(prev) && isGreen(curr);
};

const isMarubozu = (c) => {
  const r = range(c);
  if (r === 0) return false;
  return upperWick(c) / r < 0.05 && lowerWick(c) / r < 0.05 && body(c) / r > 0.9;
};

// ─── Trend Structure ─────────────────────────────────────
const isHigherHighsHigherLows = (candles) => {
  if (candles.length < 4) return false;
  const l4 = candles.slice(-4);
  return pf(l4[2].HIGH) > pf(l4[0].HIGH) && pf(l4[3].HIGH) > pf(l4[1].HIGH) &&
    pf(l4[2].LOW) > pf(l4[0].LOW) && pf(l4[3].LOW) > pf(l4[1].LOW);
};

const isLowerHighsLowerLows = (candles) => {
  if (candles.length < 4) return false;
  const l4 = candles.slice(-4);
  return pf(l4[2].HIGH) < pf(l4[0].HIGH) && pf(l4[3].HIGH) < pf(l4[1].HIGH) &&
    pf(l4[2].LOW) < pf(l4[0].LOW) && pf(l4[3].LOW) < pf(l4[1].LOW);
};

// ─── Confidence Scoring Engine ───────────────────────────
const scorePattern = (patternType, volumeRatio, trendContext, rsi) => {
  let score = 50; // base

  // Volume confirmation (+/- 20)
  if (volumeRatio > 2.0) score += 20;
  else if (volumeRatio > 1.5) score += 15;
  else if (volumeRatio > 1.0) score += 5;
  else if (volumeRatio < 0.5) score -= 15;
  else score -= 5;

  // Context alignment (+/- 15)
  if (patternType === 'BULLISH') {
    if (trendContext === 'DOWNTREND') score += 15;  // reversal in correct context
    else if (trendContext === 'UPTREND') score += 5; // continuation
    else score += 0;
  } else if (patternType === 'BEARISH') {
    if (trendContext === 'UPTREND') score += 15;
    else if (trendContext === 'DOWNTREND') score += 5;
    else score += 0;
  }

  // RSI confirmation (+/- 10)
  if (patternType === 'BULLISH' && rsi < 40) score += 10;
  else if (patternType === 'BULLISH' && rsi > 70) score -= 10;
  else if (patternType === 'BEARISH' && rsi > 60) score += 10;
  else if (patternType === 'BEARISH' && rsi < 30) score -= 10;

  return Math.max(0, Math.min(100, score));
};

// ─── Master Pattern Scanner (All 6 Improvements) ────────
const detectPatterns = (candles) => {
  const allPatterns = [];
  const latestPatterns = [];
  const patternCounts = {
    DOJI: 0, HAMMER: 0, SHOOTING_STAR: 0,
    STRONG_BULLISH_CANDLE: 0, STRONG_BEARISH_CANDLE: 0,
    BULLISH_ENGULFING: 0, BEARISH_ENGULFING: 0,
    INSIDE_BAR: 0, MORNING_STAR: 0, EVENING_STAR: 0,
    THREE_WHITE_SOLDIERS: 0, THREE_BLACK_CROWS: 0,
    TWEEZER_TOP: 0, TWEEZER_BOTTOM: 0, MARUBOZU: 0,
  };

  const total = candles.length;
  const atr = calculateATR(candles);
  const avgVol = avgVolume(candles, 20);

  const addPattern = (name, type, i, c, desc, volRatio, trend, rsi) => {
    const confidence = scorePattern(type, volRatio, trend, rsi);
    const isLatest = (i >= total - 3);
    const p = {
      name, type, index: i, time: c.BUCKET,
      price: pf(c.CLOSE), description: desc,
      confidence, volume_ratio: +volRatio.toFixed(2),
      context: trend,
    };
    allPatterns.push(p);
    if (isLatest) latestPatterns.push(p);
    if (patternCounts[name] !== undefined) patternCounts[name]++;
  };

  for (let i = 0; i < total; i++) {
    const curr = candles[i];
    const prev = i > 0 ? candles[i - 1] : null;
    const prevPrev = i > 1 ? candles[i - 2] : null;
    const volRatio = avgVol > 0 ? pf(curr.VOLUME) / avgVol : 1;
    const trend = getTrendContext(candles, i, 10);
    const rsi = quickRSI(candles, i);

    // ── Single candle patterns ──
    if (isDoji(curr, atr))
      addPattern('DOJI', 'NEUTRAL', i, curr, 'Indecision candle — market uncertain', volRatio, trend, rsi);

    if (isHammer(curr, atr) && trend !== 'UPTREND')
      addPattern('HAMMER', 'BULLISH', i, curr, 'Bullish reversal wick — buyers fought back', volRatio, trend, rsi);

    if (isShootingStar(curr, atr) && trend !== 'DOWNTREND')
      addPattern('SHOOTING_STAR', 'BEARISH', i, curr, 'Bearish rejection wick — sellers took over', volRatio, trend, rsi);

    if (isStrongBullish(curr))
      addPattern('STRONG_BULLISH_CANDLE', 'BULLISH', i, curr, 'Pure buying momentum', volRatio, trend, rsi);

    if (isStrongBearish(curr))
      addPattern('STRONG_BEARISH_CANDLE', 'BEARISH', i, curr, 'Pure selling momentum', volRatio, trend, rsi);

    if (isMarubozu(curr))
      addPattern('MARUBOZU', isGreen(curr) ? 'BULLISH' : 'BEARISH', i, curr,
        `Full-body ${isGreen(curr) ? 'bullish' : 'bearish'} candle — zero hesitation`, volRatio, trend, rsi);

    // ── Two candle patterns ──
    if (prev) {
      if (isBullishEngulfing(prev, curr))
        addPattern('BULLISH_ENGULFING', 'BULLISH', i, curr, 'Bulls overpowered bears completely', volRatio, trend, rsi);

      if (isBearishEngulfing(prev, curr))
        addPattern('BEARISH_ENGULFING', 'BEARISH', i, curr, 'Bears overpowered bulls completely', volRatio, trend, rsi);

      if (isInsideBar(prev, curr))
        addPattern('INSIDE_BAR', 'NEUTRAL', i, curr, 'Consolidation / squeeze — breakout incoming', volRatio, trend, rsi);

      if (isTweezerTop(prev, curr) && trend === 'UPTREND')
        addPattern('TWEEZER_TOP', 'BEARISH', i, curr, 'Double top rejection at same high', volRatio, trend, rsi);

      if (isTweezerBottom(prev, curr) && trend === 'DOWNTREND')
        addPattern('TWEEZER_BOTTOM', 'BULLISH', i, curr, 'Double bottom support at same low', volRatio, trend, rsi);
    }

    // ── Three candle patterns ──
    if (prev && prevPrev) {
      if (isMorningStar(prevPrev, prev, curr) && trend !== 'UPTREND')
        addPattern('MORNING_STAR', 'BULLISH', i, curr, '3-candle reversal at bottom — strong buy', volRatio, trend, rsi);

      if (isEveningStar(prevPrev, prev, curr) && trend !== 'DOWNTREND')
        addPattern('EVENING_STAR', 'BEARISH', i, curr, '3-candle reversal at top — strong sell', volRatio, trend, rsi);

      if (isThreeWhiteSoldiers(prevPrev, prev, curr))
        addPattern('THREE_WHITE_SOLDIERS', 'BULLISH', i, curr, '3 consecutive strong green candles — sustained buying', volRatio, trend, rsi);

      if (isThreeBlackCrows(prevPrev, prev, curr))
        addPattern('THREE_BLACK_CROWS', 'BEARISH', i, curr, '3 consecutive strong red candles — sustained selling', volRatio, trend, rsi);
    }
  }

  // ── Trend structure (full dataset) ──
  if (isHigherHighsHigherLows(candles)) {
    const p = { name: 'HIGHER_HIGHS_HIGHER_LOWS', type: 'BULLISH', confidence: 70, description: 'Uptrend structure across scanned candles' };
    allPatterns.push(p); latestPatterns.push(p);
  }
  if (isLowerHighsLowerLows(candles)) {
    const p = { name: 'LOWER_HIGHS_LOWER_LOWS', type: 'BEARISH', confidence: 70, description: 'Downtrend structure across scanned candles' };
    allPatterns.push(p); latestPatterns.push(p);
  }

  const bullishCount = allPatterns.filter(p => p.type === 'BULLISH').length;
  const bearishCount = allPatterns.filter(p => p.type === 'BEARISH').length;
  const neutralCount = allPatterns.filter(p => p.type === 'NEUTRAL').length;
  const avgConfidence = allPatterns.length > 0
    ? Math.round(allPatterns.reduce((s, p) => s + (p.confidence || 50), 0) / allPatterns.length) : 0;

  // High-confidence patterns only (score >= 65)
  const highConfPatterns = allPatterns.filter(p => (p.confidence || 0) >= 65);

  return {
    allPatterns, latestPatterns, highConfPatterns, patternCounts,
    totalCandlesScanned: total, bullishCount, bearishCount, neutralCount,
    avgConfidence, atr: atr ? +atr.toFixed(2) : null,
  };
};

// ─── Pattern Agent ───────────────────────────────────────
export const patternAgent = async (symbol, timeframe = '1_hour', inputCandles = null) => {
  try {
    console.log(`🔍 Pattern Agent scanning ALL candles for ${symbol} on ${timeframe}...`);

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

    if (!candles || candles.length < 5) {
      return { error: `Not enough data for pattern analysis of ${symbol}`, symbol, timeframe };
    }

    // Step 2: Detect patterns with all 6 improvements (ATR, volume, context, scoring, new patterns)
    const scanResult = detectPatterns(candles);
    const { allPatterns, latestPatterns, highConfPatterns, patternCounts, totalCandlesScanned } = scanResult;

    // Step 3: Multi-timeframe confirmation (fetch a secondary timeframe)
    let mtfConfirmation = null;
    const secondaryTF = timeframe.includes('1_m') ? '5_minute' : timeframe.includes('5_m') ? '15_minute' : '1_hour';
    try {
      const mtfCandles = await getLatestCandles(symbol, secondaryTF, 50).catch(() => []);
      if (mtfCandles && mtfCandles.length >= 10) {
        const mtfScan = detectPatterns(mtfCandles);
        const mtfBullish = mtfScan.bullishCount;
        const mtfBearish = mtfScan.bearishCount;
        mtfConfirmation = {
          timeframe: secondaryTF,
          candles_scanned: mtfScan.totalCandlesScanned,
          bullish: mtfBullish, bearish: mtfBearish,
          bias: mtfBullish > mtfBearish ? 'BULLISH' : mtfBearish > mtfBullish ? 'BEARISH' : 'NEUTRAL',
          confirms_primary: (scanResult.bullishCount > scanResult.bearishCount && mtfBullish > mtfBearish) ||
            (scanResult.bearishCount > scanResult.bullishCount && mtfBearish > mtfBullish),
        };
      }
    } catch (_) { /* MTF is optional, continue without */ }

    // Sample candles for LLM context
    const sampleSize = Math.min(25, candles.length);
    const step = Math.max(1, Math.floor(candles.length / sampleSize));
    const sampledFullCandles = [];
    for (let i = 0; i < candles.length; i += step) {
      const c = candles[i];
      sampledFullCandles.push({
        idx: i, time: c.BUCKET, open: +c.OPEN, high: +c.HIGH,
        low: +c.LOW, close: +c.CLOSE, volume: +c.VOLUME,
      });
    }

    const last15 = candles.slice(-15).map(c => ({
      time: c.BUCKET, open: +c.OPEN, high: +c.HIGH,
      low: +c.LOW, close: +c.CLOSE, volume: +c.VOLUME,
    }));

    // Top high-confidence patterns for LLM (max 20 to save tokens)
    const topPatterns = highConfPatterns.slice(-20);

    // Step 4: LLM synthesis
    const prompt = `
You are an expert candlestick and chart pattern analyst for Indian markets.
You have scanned ALL ${totalCandlesScanned} candles in the dataset for ${symbol} (${timeframe} timeframe).

ADVANCED SCAN STATS (${totalCandlesScanned} CANDLES):
- ATR (14-period): ${scanResult.atr || 'N/A'}
- Total Patterns Found: ${allPatterns.length} (${scanResult.bullishCount} Bullish, ${scanResult.bearishCount} Bearish, ${scanResult.neutralCount} Neutral)
- High-Confidence Patterns (score≥65): ${highConfPatterns.length}
- Average Pattern Confidence Score: ${scanResult.avgConfidence}%
- Pattern Frequency: ${JSON.stringify(patternCounts)}
${mtfConfirmation ? `\nMULTI-TIMEFRAME CONFIRMATION (${mtfConfirmation.timeframe}):
- Secondary TF Bias: ${mtfConfirmation.bias} (${mtfConfirmation.bullish} bullish, ${mtfConfirmation.bearish} bearish)
- Confirms Primary: ${mtfConfirmation.confirms_primary ? 'YES ✅' : 'NO ❌'}` : ''}

SAMPLED CANDLE TIMELINE (${sampledFullCandles.length} points):
${JSON.stringify(sampledFullCandles, null, 2)}

RECENT CANDLES (LAST 15):
${JSON.stringify(last15, null, 2)}

HIGH-CONFIDENCE PATTERNS (score≥65, most recent):
${JSON.stringify(topPatterns, null, 2)}

LATEST CANDLE PATTERNS:
${JSON.stringify(latestPatterns, null, 2)}

Based on scanning ALL ${totalCandlesScanned} candles with volume-confirmed, context-aware, ATR-adjusted pattern detection:
1. Synthesize pattern trends over the ENTIRE candle history and recent setups.
2. Identify chart patterns (triangles, channels, flags, double top/bottom).
3. Determine overall pattern bias, breakout probability, and target/stop loss.
4. Factor in pattern confidence scores and multi-timeframe confirmation.

Respond in this EXACT JSON format:
{
  "total_candles_scanned": ${totalCandlesScanned},
  "detected_patterns": ${JSON.stringify(latestPatterns)},
  "full_dataset_pattern_summary": "<summary of all patterns across ${totalCandlesScanned} candles with confidence scores>",
  "additional_patterns": [
    {"name": "<pattern name>", "type": "BULLISH|BEARISH|NEUTRAL", "description": "<brief>"}
  ],
  "pattern_bias": "BULLISH|BEARISH|NEUTRAL",
  "pattern_strength": "STRONG|MODERATE|WEAK",
  "breakout_direction": "UP|DOWN|SIDEWAYS",
  "breakout_probability": <0-100>,
  "key_level_to_watch": <price number>,
  "price_target": <price number>,
  "stop_loss": <price number>,
  "pattern_summary": "<2-3 sentence summary>",
  "confidence": <0-100>
}

Respond ONLY with valid JSON. No explanation outside JSON.
    `;

    const systemPrompt = 'You are an expert candlestick and chart pattern analyst for Indian stock markets. Always respond with valid JSON only.';
    const rawText = await runLLMCompletion({ systemPrompt, prompt, maxTokens: 4000, temperature: 0.1 });
    const patternAnalysis = parseLLMJson(rawText);

    console.log(`✅ Pattern Agent done (scanned ALL ${totalCandlesScanned} candles for ${symbol}):`,
      patternAnalysis.pattern_bias, patternAnalysis.confidence + '%',
      `| High-conf patterns: ${highConfPatterns.length}`,
      mtfConfirmation ? `| MTF ${mtfConfirmation.timeframe}: ${mtfConfirmation.confirms_primary ? 'CONFIRMED ✅' : 'DIVERGENT ❌'}` : ''
    );

    return {
      symbol, timeframe,
      total_candles_scanned: totalCandlesScanned,
      patterns_found: allPatterns.length,
      high_confidence_patterns: highConfPatterns.length,
      avg_pattern_confidence: scanResult.avgConfidence,
      bullish_count: scanResult.bullishCount,
      bearish_count: scanResult.bearishCount,
      neutral_count: scanResult.neutralCount,
      atr: scanResult.atr,
      mtf_confirmation: mtfConfirmation,
      pattern_analysis: patternAnalysis,
      last_candle: last15[last15.length - 1],
    };

  } catch (error) {
    console.error('❌ Pattern Agent error:', error.message);
    return { error: error.message, symbol, timeframe };
  }
};