import YahooFinance from 'yahoo-finance2';
import { resolveInstrumentToken } from './kite.js';

const yahoo = new YahooFinance();

/**
 * 100% Dynamic Symbol Normalizer for Yahoo Finance (.NS for NSE stocks, ^NSEI for Nifty)
 * Resolves company names/tickers dynamically using Zerodha's 10,000+ instrument master list.
 */
export const normalizeYahooSymbol = async (rawSymbol) => {
  if (!rawSymbol) return '^NSEI';
  let s = rawSymbol.toString().trim().toUpperCase();

  // Index mappings
  if (s === 'NIFTY 50' || s === 'NIFTY' || s === 'NIFTY50') return '^NSEI';
  if (s === 'BANKNIFTY' || s === 'BANK NIFTY' || s === 'NIFTY BANK') return '^NSEBANK';
  if (s === 'SENSEX' || s === 'BSESN') return '^BSESN';

  // 100% Dynamic Fuzzy Match against Zerodha Master Instrument List (Free)
  const resolved = await resolveInstrumentToken(s).catch(() => null);
  if (resolved && resolved.tradingsymbol) {
    const symbol = resolved.tradingsymbol;
    if (symbol.startsWith('^')) return symbol;
    return `${symbol}.NS`;
  }

  // Fallback cleanup
  const clean = s.replace(/\s+(LTD|LIMITED|CORP|CORPORATION|INC|INDUSTRIES|INDIA|INDEX)$/gi, '')
                 .replace(/[\s\-]/g, '');
  return `${clean}.NS`;
};

/**
 * Map timeframe string to Yahoo interval
 */
const mapYahooInterval = (timeframe) => {
  const tf = (timeframe || '').toLowerCase();
  if (tf.includes('15')) return '15m';
  if (tf.includes('5_m') || tf.includes('5m') || tf.includes('5_min') || tf.includes('5_minute')) return '5m';
  if (tf.includes('1_m') || tf.includes('1m') || tf.includes('1_min') || tf.includes('1_minute')) return '1m';
  if (tf.includes('week')) return '1wk';
  if (tf.includes('day')) return '1d';
  return '1h'; // default 1 hour
};

/**
 * Yahoo Finance enforces strict lookback limits per interval:
 *   1m  → max 7 days
 *   5m  → max 60 days
 *   15m → max 60 days
 *   1h+ → no practical limit
 */
const getYahooMaxLookback = (interval) => {
  if (interval === '1m') return 7;
  if (interval === '5m' || interval === '15m') return 60;
  return 365; // daily / weekly
};

/**
 * Fetch 100% Free Real-Time OHLC Candles from Yahoo Finance
 */
export const getYahooHistoricalCandles = async (rawSymbol, timeframe = '1_hour', lookbackDays = 30) => {
  try {
    const symbol = await normalizeYahooSymbol(rawSymbol);
    const interval = mapYahooInterval(timeframe);

    // Calculate Date Range — cap to Yahoo Finance per-interval limits
    const maxLookback = getYahooMaxLookback(interval);
    const effectiveLookback = Math.min(lookbackDays || 30, maxLookback);
    if (effectiveLookback < (lookbackDays || 30)) {
      console.warn(`⚠️ Yahoo Finance: capping ${rawSymbol} lookback from ${lookbackDays}d → ${effectiveLookback}d (${interval} limit is ${maxLookback}d)`);
    }

    const period2 = new Date();
    const period1 = new Date();
    period1.setDate(period2.getDate() - effectiveLookback);

    console.log(`📡 Fetching FREE Yahoo Finance live candles for ${symbol} (${effectiveLookback}d lookback, interval: ${interval})...`);

    const result = await yahoo.chart(symbol, {
      period1,
      period2,
      interval,
    });

    if (!result || !result.quotes || result.quotes.length === 0) {
      console.warn(`⚠️ Yahoo Finance returned no candles for ${symbol}`);
      return null;
    }

    // Filter out invalid null candles and format to Finvedas Trading Agent structure
    const formatted = result.quotes
      .filter(q => q.open !== null && q.close !== null && q.high !== null && q.low !== null)
      .map(q => ({
        BUCKET: new Date(q.date).toISOString(),
        INSTRUMENT_SYMBOL: rawSymbol.toUpperCase(),
        OPEN: Number(q.open),
        HIGH: Number(q.high),
        LOW: Number(q.low),
        CLOSE: Number(q.close),
        VOLUME: Number(q.volume || 0),
        OPEN_INTEREST: 0,
      }));

    if (formatted.length === 0) return null;

    const currentPrice = formatted[formatted.length - 1]?.CLOSE;
    console.log(`✅ Loaded ${formatted.length} live candles from Yahoo Finance for ${symbol} (Current Price: ₹${currentPrice})`);

    return {
      symbol,
      candles: formatted,
      currentPrice,
    };

  } catch (err) {
    console.warn(`⚠️ Yahoo Finance candles fetch failed for ${rawSymbol}:`, err.message);
    return null;
  }
};
