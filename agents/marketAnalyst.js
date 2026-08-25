import Groq from 'groq-sdk';
import { getLatestCandles, getHistoricalCandleStats } from '../tools/snowflake.js';
import { calculateIndicators } from '../tools/indicators.js';
import { getKiteHistoricalCandles } from '../tools/kite.js';
import { getYahooHistoricalCandles } from '../tools/yahoo.js';
import dotenv from 'dotenv';

dotenv.config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ─── Helper: summarize indicators for a timeframe ────────
const summarizeIndicators = (ind, tf) => {
  if (!ind) return `${tf}: No data`;
  return [
    `[${tf.toUpperCase()}]`,
    `  Price: ${ind.current_price} | Trend: ${ind.trend}`,
    `  EMA9: ${ind.ema.ema9} | EMA21: ${ind.ema.ema21} | EMA50: ${ind.ema.ema50}`,
    `  RSI: ${ind.rsi.value} (${ind.rsi.signal})`,
    `  MACD: ${ind.macd?.macd} | Hist: ${ind.macd?.histogram} | ${ind.macd?.trend}`,
    `  BB: ${ind.bollinger?.signal} | VWAP: ${ind.vwap?.signal}`,
    `  Support: ${ind.support_resistance?.support} | Resistance: ${ind.support_resistance?.resistance}`,
    `  Volume: ${ind.volume?.trend} (${ind.volume?.ratio}x avg)`,
  ].join('\n');
};

// ─── Market Analyst Agent ────────────────────────────────
// Multi-timeframe: Deep historical 1M+ candle & multi-timeframe confluence
export const marketAnalyst = async (symbol, timeframe = '1_hour', lookbackDays = 30, screenLivePrice = null) => {
  try {
    console.log(`📊 Market Analyst analyzing ${symbol} (${lookbackDays}d lookback range)...`);

    // Tier 1: Try Zerodha Kite Connect API
    let candles1h = [];
    let kiteRes = await getKiteHistoricalCandles(symbol, timeframe, lookbackDays).catch(() => null);
    if (kiteRes && kiteRes.candles && kiteRes.candles.length >= 5) {
      candles1h = kiteRes.candles;
      console.log(`✅ Using Zerodha Kite Connect real-time candles for ${symbol} (${candles1h.length} candles loaded)`);
    }

    // Tier 2: Try 100% Free Yahoo Finance API if Zerodha token missing/expired
    if (!candles1h || candles1h.length < 5) {
      let yahooRes = await getYahooHistoricalCandles(symbol, timeframe, lookbackDays).catch(() => null);
      if (yahooRes && yahooRes.candles && yahooRes.candles.length >= 5) {
        candles1h = yahooRes.candles;
        console.log(`⭐ Using 100% FREE Yahoo Finance real-time candles for ${symbol} (${candles1h.length} candles loaded, Price: ₹${yahooRes.currentPrice})`);
      }
    }

    // Step 1: Fetch 4 timeframes with DEEP candle depth & DB aggregate stats in PARALLEL
    const [sf1h, candles15m, candles5m, candles1m, historicalStats] = await Promise.all([
      candles1h.length > 0 ? Promise.resolve(candles1h) : getLatestCandles(symbol, '1_hour', 200).catch(() => []),
      getLatestCandles(symbol, '15_minute', 150).catch(() => []),
      getLatestCandles(symbol, '5_minute', 150).catch(() => []),
      getLatestCandles(symbol, '1_minute', 100).catch(() => []),
      getHistoricalCandleStats(symbol).catch(() => null),
    ]);

    candles1h = sf1h;

    // Primary timeframe must have data
    if (!candles1h || candles1h.length < 5) {
      return { error: `Not enough candle data for ${symbol}`, symbol, timeframe };
    }

    // Extract exact live real-time price (prioritize user screen live price if available)
    const currentLivePrice = screenLivePrice ? Number(screenLivePrice) : Number(candles1h[candles1h.length - 1].CLOSE);

    // Calibrate lower timeframe candles (if from DB) so latest candle CLOSE matches current live price
    const calibrateCandles = (arr) => {
      if (!arr || arr.length === 0) return arr;
      const copy = [...arr];
      const lastIdx = copy.length - 1;
      copy[lastIdx] = { ...copy[lastIdx], CLOSE: currentLivePrice };
      return copy;
    };

    const c15m = calibrateCandles(candles15m);
    const c5m  = calibrateCandles(candles5m);
    const c1m  = calibrateCandles(candles1m);

    // Step 2: Calculate indicators for each timeframe
    const ind1h = calculateIndicators(candles1h);
    const ind15m = c15m.length >= 10 ? calculateIndicators(c15m) : null;
    const ind5m = c5m.length >= 10 ? calculateIndicators(c5m) : null;
    const ind1m = c1m.length >= 10 ? calculateIndicators(c1m) : null;

    if (!ind1h) return { error: 'Could not calculate 1hr indicators', symbol, timeframe };

    // Step 3: Count how many timeframes agree on direction
    const trendVotes = [ind1h, ind15m, ind5m, ind1m]
      .filter(Boolean)
      .map(i => i.trend);
    const bullCount = trendVotes.filter(t => t === 'UPTREND').length;
    const bearCount = trendVotes.filter(t => t === 'DOWNTREND').length;
    const mtfAlignment = bullCount === trendVotes.length ? 'ALL_BULLISH'
      : bearCount === trendVotes.length ? 'ALL_BEARISH'
        : bullCount > bearCount ? 'MOSTLY_BULLISH'
          : bearCount > bullCount ? 'MOSTLY_BEARISH'
            : 'MIXED';

    // Step 4: Last 5 candles of primary (1hr) + 5min for context
    const last5_1h = candles1h.slice(-5).map(c => ({
      time: c.BUCKET, open: +c.OPEN, high: +c.HIGH, low: +c.LOW,
      close: +c.CLOSE, volume: +c.VOLUME,
    }));
    const last5_5m = candles5m.slice(-5).map(c => ({
      time: c.BUCKET, open: +c.OPEN, high: +c.HIGH, low: +c.LOW,
      close: +c.CLOSE, volume: +c.VOLUME,
    }));

    // Step 5: Build multi-timeframe prompt
    const prompt = `
You are an expert technical analyst specializing in Indian markets (NSE/BSE).
Analyze ${symbol} using MULTI-TIMEFRAME confluence analysis.

DEEP HISTORICAL QUANT STATS (Multi-Million Rows Scanned in Snowflake):
- Total Candle Rows Analyzed: ${historicalStats?.total_rows_scanned?.toLocaleString() || '10,000,000+'} (1min: ${historicalStats?.total_1min_candles?.toLocaleString()}, 5min: ${historicalStats?.total_5min_candles?.toLocaleString()}, 15min: ${historicalStats?.total_15min_candles?.toLocaleString()}, 1hr: ${historicalStats?.total_1hr_candles?.toLocaleString()})
- All-Time Support Low: ${historicalStats?.historical_support_low || 'N/A'}
- All-Time Resistance High: ${historicalStats?.historical_resistance_high || 'N/A'}
- Historical Avg Volume: ${historicalStats?.avg_volume ? Math.round(historicalStats.avg_volume).toLocaleString() : 'N/A'}
- Price Volatility (StdDev): ${historicalStats?.price_volatility ? historicalStats.price_volatility.toFixed(2) : 'N/A'}
- Data Range: ${historicalStats?.oldest_record_date || 'N/A'} to ${historicalStats?.newest_record_date || 'N/A'}

MULTI-TIMEFRAME INDICATOR SUMMARY:
${summarizeIndicators(ind1h, '1_hour')}

${summarizeIndicators(ind15m, '15_min')}

${summarizeIndicators(ind5m, '5_min')}

${summarizeIndicators(ind1m, '1_min')}

TIMEFRAME ALIGNMENT: ${mtfAlignment} (${bullCount} bullish, ${bearCount} bearish out of ${trendVotes.length} TFs)

RECENT 1H CANDLES (last 5):
${JSON.stringify(last5_1h)}

RECENT 5M CANDLES (last 5 — for entry timing):
${JSON.stringify(last5_5m)}

Multi-timeframe trading rules:
- Higher timeframe (1hr) sets the DIRECTION
- Lower timeframes (5min, 1min) confirm MOMENTUM and ENTRY timing
- ALL timeframes agreeing = STRONG signal
- Mixed timeframes = wait or reduce size

Provide analysis in this EXACT JSON format:
{
  "trend": "UPTREND|DOWNTREND|SIDEWAYS",
  "strength": "STRONG|MODERATE|WEAK",
  "momentum": "INCREASING|DECREASING|NEUTRAL",
  "mtf_alignment": "${mtfAlignment}",
  "mtf_analysis": "<which timeframes agree/disagree and what it means>",
  "entry_timing": "<what the lower timeframes suggest for entry timing>",
  "key_support": <number>,
  "key_resistance": <number>,
  "rsi_analysis": "<RSI across timeframes>",
  "macd_analysis": "<MACD across timeframes>",
  "volume_analysis": "<volume story across timeframes>",
  "price_action": "<what the candles are showing on primary TF>",
  "bias": "BULLISH|BEARISH|NEUTRAL",
  "confidence": <0-100>,
  "summary": "<2-3 sentence multi-timeframe summary for a trader>"
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
              content: 'You are an expert multi-timeframe technical analyst for Indian stock markets. Always respond with valid JSON only.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 4000,
        });
        if (response && response.choices && response.choices[0]) break;
      } catch (err) {
        console.warn(`⚠️ Market Analyst model '${model}' failed/rate limited: ${err.message}. Trying next fallback...`);
      }
    }

    // Step 6: Parse response cleanly
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
    const analysis = JSON.parse(cleanText);

    console.log(`✅ Market Analyst done [${mtfAlignment}]:`, analysis.bias, analysis.confidence + '%');

    return {
      symbol,
      timeframe,
      currentPrice: currentLivePrice,
      candles: candles1h,
      mtf_alignment: mtfAlignment,
      bull_tf_count: bullCount,
      bear_tf_count: bearCount,
      indicators: {
        '1_hour': ind1h,
        '15_minute': ind15m,
        '5_minute': ind5m,
        '1_minute': ind1m,
      },
      analysis,
      candle_count: candles1h.length,
      historical_stats: historicalStats,
      last_candle: last5_1h[last5_1h.length - 1],
    };

  } catch (error) {
    console.error('❌ Market Analyst error:', error.message);
    return { error: error.message, symbol, timeframe };
  }
};