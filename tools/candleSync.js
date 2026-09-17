import { getKiteHistoricalCandles } from './kite.js';
import { getYahooHistoricalCandles } from './yahoo.js';
import { getLatestCandles, getHistoricalCandleStats } from './snowflake.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Normalizes input timeframe to canonical format
 */
export const normalizeTimeframe = (tf) => {
  if (!tf) return '1_hour';
  const s = tf.toString().toLowerCase().trim();
  if (s.includes('15')) return '15_minute';
  if (s.includes('5_m') || s.includes('5m') || s.includes('5_min') || s.includes('5_minute')) return '5_minute';
  if (s.includes('1_m') || s.includes('1m') || s.includes('1_min') || s.includes('1_minute')) return '1_minute';
  if (s.includes('week') || s.includes('1w')) return '1_week';
  if (s.includes('day') || s.includes('1d') || s.includes('daily')) return '1_day';
  return '1_hour';
};

/**
 * Returns sensible context timeframes based on the primary timeframe selected by user.
 * - If user wants 1m (scalping): check 5m and 15m for broader trend.
 * - If user wants 5m: check 15m/1h for trend, 1m for entry timing.
 * - If user wants 15m: check 1h for trend, 5m for entry timing.
 * - If user wants 1h: check 15m and 5m for momentum, 1d for macro direction.
 * - If user wants 1d: check 1h and 15m for intraday structure.
 */
export const getContextTimeframes = (primaryTf) => {
  const norm = normalizeTimeframe(primaryTf);
  switch (norm) {
    case '1_minute':
      return ['5_minute', '15_minute'];
    case '5_minute':
      return ['15_minute', '1_minute'];
    case '15_minute':
      return ['1_hour', '5_minute'];
    case '1_hour':
      return ['15_minute', '5_minute', '1_minute'];
    case '1_day':
    case '1_week':
      return ['1_hour', '15_minute'];
    default:
      return ['15_minute', '5_minute'];
  }
};

/**
 * Lookback cap per interval so queries don't exceed provider capabilities or slow down
 * Minimum 5 days ensure weekend gaps (Sat/Sun) never return empty data.
 */
const getOptimalLookbackDays = (tf, requestedDays = 30) => {
  const norm = normalizeTimeframe(tf);
  switch (norm) {
    case '1_minute':
      return Math.max(5, Math.min(requestedDays || 5, 7)); // 5-7 days covers weekends cleanly
    case '5_minute':
      return Math.max(5, Math.min(requestedDays || 20, 30));
    case '15_minute':
      return Math.max(7, Math.min(requestedDays || 30, 45));
    case '1_hour':
      return Math.max(14, Math.min(requestedDays || 30, 90));
    case '1_day':
    case '1_week':
      return Math.max(requestedDays || 180, 180);
    default:
      return Math.min(requestedDays || 30, 30);
  }
};

/**
 * Fetch a single timeframe from a specific provider
 */
const fetchFromProvider = async (provider, symbol, tf, lookbackDays) => {
  const days = getOptimalLookbackDays(tf, lookbackDays);
  if (provider === 'kite') {
    const res = await getKiteHistoricalCandles(symbol, tf, days).catch(() => null);
    if (res && res.candles && res.candles.length >= 5) return res.candles;
  } else if (provider === 'yahoo') {
    let res = await getYahooHistoricalCandles(symbol, tf, days).catch(() => null);
    // If 1_minute has no data on Yahoo (e.g. indices like ^NSEI don't offer 1m), fallback to 5m
    if ((!res || !res.candles || res.candles.length < 5) && tf === '1_minute') {
      res = await getYahooHistoricalCandles(symbol, '5_minute', days).catch(() => null);
    }
    if (res && res.candles && res.candles.length >= 5) return res.candles;
  } else if (provider === 'snowflake') {
    const candles = await getLatestCandles(symbol, tf, 150).catch(() => []);
    if (candles && candles.length >= 5) return candles;
  }
  return [];
};

// In-flight request deduplication & short-lived cache (10 seconds)
const candleCache = new Map();

/**
 * Centralized Multi-Timeframe Synchronized Candle Fetcher
 * Guarantees that ALL timeframes come from the SAME active provider.
 */
export const getSynchronizedCandles = async (
  symbol,
  primaryTimeframe = '1_hour',
  lookbackDays = 30,
  screenLivePrice = null
) => {
  const normPrimary = normalizeTimeframe(primaryTimeframe);
  const cleanSym = symbol ? symbol.toString().trim().toUpperCase() : 'NIFTY 50';
  const cacheKey = `${cleanSym}_${normPrimary}_${lookbackDays}`;

  // Check cache (10s TTL) or in-flight promise to avoid duplicate network fetches
  const cached = candleCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.timestamp < 10000)) {
    if (cached.promise) return cached.promise;
    if (cached.data) return cached.data;
  }

  const fetchPromise = (async () => {
    const contextTfs = getContextTimeframes(normPrimary);

    console.log(`\n🔄 Synchronizing candles for ${cleanSym}: Primary=[${normPrimary}], Context=[${contextTfs.join(', ')}]...`);

    // ── Step 1: Detect best available provider for primary timeframe ──
    let activeProvider = null;
    let primaryCandles = [];

    // Try Kite Connect first
    const kitePrimary = await fetchFromProvider('kite', cleanSym, normPrimary, lookbackDays);
    if (kitePrimary.length >= 5) {
      activeProvider = 'kite';
      primaryCandles = kitePrimary;
      console.log(`✅ Using Zerodha Kite as active synchronized provider (${primaryCandles.length} ${normPrimary} candles)`);
    }

    // Fallback to Yahoo Finance
    if (!activeProvider) {
      const yahooPrimary = await fetchFromProvider('yahoo', cleanSym, normPrimary, lookbackDays);
      if (yahooPrimary.length >= 5) {
        activeProvider = 'yahoo';
        primaryCandles = yahooPrimary;
        console.log(`⭐ Using Yahoo Finance as active synchronized provider (${primaryCandles.length} ${normPrimary} candles)`);
      }
    }

    // Fallback to Snowflake DB
    if (!activeProvider) {
      const sfPrimary = await fetchFromProvider('snowflake', cleanSym, normPrimary, lookbackDays);
      if (sfPrimary.length >= 5) {
        activeProvider = 'snowflake';
        primaryCandles = sfPrimary;
        console.log(`📦 Using Snowflake DB as fallback provider (${primaryCandles.length} ${normPrimary} candles)`);
      }
    }

    if (!activeProvider || primaryCandles.length < 5) {
      return {
        error: `Could not load candles for ${cleanSym} across Kite, Yahoo, and Snowflake.`,
        symbol: cleanSym,
        primaryTimeframe: normPrimary,
      };
    }

    // ── Step 2: Fetch all context timeframes from the SAME active provider ──
    console.log(`📡 Fetching context timeframes [${contextTfs.join(', ')}] strictly from '${activeProvider}'...`);

    const contextPromises = contextTfs.map(tf =>
      fetchFromProvider(activeProvider, cleanSym, tf, lookbackDays)
        .then(candles => ({ tf, candles }))
        .catch(() => ({ tf, candles: [] }))
    );

    // Also fetch Snowflake aggregate statistics if available (for macro bounds)
    const [contextResults, historicalStats] = await Promise.all([
      Promise.all(contextPromises),
      getHistoricalCandleStats(cleanSym).catch(() => null),
    ]);

    const contextCandles = {};
    for (const { tf, candles } of contextResults) {
      contextCandles[tf] = candles;
      console.log(`   ↳ [${tf}]: ${candles.length} candles from ${activeProvider}`);
    }

    // ── Step 3: Extract live price ──
    const lastPrimaryCandle = primaryCandles[primaryCandles.length - 1];
    const primaryLivePrice = Number(lastPrimaryCandle.CLOSE);
    const currentLivePrice = screenLivePrice ? Number(screenLivePrice) : primaryLivePrice;

    // If live screen price is provided and active provider is real-time, align latest candle CLOSE
    if (screenLivePrice && activeProvider !== 'snowflake') {
      const lastIdx = primaryCandles.length - 1;
      primaryCandles[lastIdx] = {
        ...primaryCandles[lastIdx],
        CLOSE: currentLivePrice,
        HIGH: Math.max(primaryCandles[lastIdx].HIGH, currentLivePrice),
        LOW: Math.min(primaryCandles[lastIdx].LOW, currentLivePrice),
      };
    }

    return {
      symbol: cleanSym,
      provider: activeProvider,
      primaryTimeframe: normPrimary,
      primaryCandles,
      contextTimeframes: contextTfs,
      contextCandles,
      currentLivePrice,
      historicalStats,
    };
  })();

  candleCache.set(cacheKey, { timestamp: now, promise: fetchPromise });

  try {
    const result = await fetchPromise;
    candleCache.set(cacheKey, { timestamp: now, data: result });
    return result;
  } catch (err) {
    candleCache.delete(cacheKey);
    throw err;
  }
};
