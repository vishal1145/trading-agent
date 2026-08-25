import { KiteConnect } from 'kiteconnect';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.KITE_API_KEY;
const accessToken = process.env.KITE_ACCESS_TOKEN;

let kc = null;
let instrumentsCache = null;
let lastInstrumentsFetch = 0;

/**
 * Initialize Kite Connect Instance
 */
export const getKiteInstance = () => {
  if (!kc && apiKey) {
    kc = new KiteConnect({ api_key: apiKey });
    if (accessToken) {
      kc.setAccessToken(accessToken);
    }
  }
  return kc;
};

/**
 * Fetch and cache Zerodha instrument list (refreshed daily)
 */
export const getInstrumentsList = async () => {
  const now = Date.now();
  // Cache for 12 hours
  if (instrumentsCache && (now - lastInstrumentsFetch < 12 * 60 * 60 * 1000)) {
    return instrumentsCache;
  }

  try {
    const kite = getKiteInstance();
    if (!kite || !accessToken) return [];

    console.log('🔄 Syncing instrument tokens from Zerodha Kite...');
    const instruments = await kite.getInstruments('NSE');
    instrumentsCache = instruments;
    lastInstrumentsFetch = now;
    console.log(`✅ Loaded ${instruments.length} instruments from Zerodha NSE.`);
    return instrumentsCache;
  } catch (err) {
    console.warn('⚠️ Could not load Zerodha instruments list:', err.message);
    return instrumentsCache || [];
  }
};

/**
 * Dynamic Symbol Normalizer & Zerodha Token Resolver (100% Dynamic - No Hardcoding)
 */
export const resolveInstrumentToken = async (rawSymbol) => {
  if (!rawSymbol) return null;
  const input = rawSymbol.toString().trim().toUpperCase()
    .replace(/\s+(LTD|LIMITED|CORP|CORPORATION|INC|INDUSTRIES|INDIA|INDEX)$/gi, '').trim();

  const list = await getInstrumentsList();
  if (!list || list.length === 0) {
    return { tradingsymbol: input, instrumentToken: null };
  }

  // Tier 1: Exact tradingsymbol match (e.g. "RELIANCE", "SBIN", "LTFOODS", "BAJAJHIND", "TCS")
  let match = list.find(i => i.tradingsymbol === input);

  // Tier 2: Strip spaces/hyphens and check tradingsymbol (e.g. "LT FOODS" -> "LTFOODS", "BAJAJ HINDUSTHAN" -> "BAJAJHIND")
  if (!match) {
    const compactInput = input.replace(/[\s\-]/g, '');
    match = list.find(i => i.tradingsymbol === compactInput);
  }

  // Tier 3: Search by Zerodha's company name field (e.g. "LT FOODS" -> name: "LT FOODS LIMITED")
  if (!match) {
    match = list.find(i => i.name && i.name.toUpperCase().startsWith(input));
  }

  // Tier 4: Substring search in Zerodha company name (e.g. "STATE BANK" -> name: "STATE BANK OF INDIA")
  if (!match) {
    match = list.find(i => i.name && i.name.toUpperCase().includes(input));
  }

  // Tier 5: First word match on company name (e.g. "BAJAJ" -> name: "BAJAJ AUTO LIMITED")
  if (!match && input.length >= 3) {
    const firstWord = input.split(' ')[0];
    match = list.find(i => i.name && i.name.toUpperCase().startsWith(firstWord));
  }

  if (match) {
    return {
      tradingsymbol: match.tradingsymbol,
      instrumentToken: match.instrument_token,
      name: match.name,
      exchange: match.exchange,
    };
  }

  return { tradingsymbol: input, instrumentToken: null };
};

/**
 * Fetch Live Real-Time LTP from Zerodha Kite
 */
export const getKiteLTP = async (rawSymbol) => {
  try {
    const kite = getKiteInstance();
    if (!kite || !accessToken) return null;

    const resolved = await resolveInstrumentToken(rawSymbol);
    const key = `NSE:${resolved.tradingsymbol}`;

    const quote = await kite.getLTP([key]);
    if (quote && quote[key]) {
      return {
        symbol: resolved.tradingsymbol,
        price: quote[key].last_price,
        instrument_token: quote[key].instrument_token,
      };
    }
  } catch (err) {
    console.warn(`⚠️ Kite LTP fetch failed for ${rawSymbol}:`, err.message);
  }
  return null;
};

/**
 * Fetch Historical Candles from Zerodha Kite Connect
 */
export const getKiteHistoricalCandles = async (rawSymbol, timeframe = '1_hour', lookbackDays = 30) => {
  try {
    const kite = getKiteInstance();
    if (!kite || !accessToken) return null;

    const resolved = await resolveInstrumentToken(rawSymbol);
    if (!resolved.instrumentToken) {
      console.warn(`⚠️ Instrument token not found for ${rawSymbol}`);
      return null;
    }

    // Map timeframe to Zerodha interval & cap lookback days to Zerodha API limits
    let interval = '60minute';
    let maxAllowedDays = 90;

    const tf = (timeframe || '').toLowerCase();
    if (tf.includes('15')) {
      interval = '15minute';
      maxAllowedDays = 60;
    } else if (tf.includes('5_m') || tf.includes('5m') || tf.includes('5_min') || tf.includes('5_minute')) {
      interval = '5minute';
      maxAllowedDays = 60;
    } else if (tf.includes('1_m') || tf.includes('1m') || tf.includes('1_min') || tf.includes('1_minute')) {
      interval = 'minute';
      maxAllowedDays = 30;
    } else if (tf.includes('day')) {
      interval = 'day';
      maxAllowedDays = 1000;
    } else if (tf.includes('week')) {
      interval = 'day';
      maxAllowedDays = 1000;
    } else {
      interval = '60minute';
      maxAllowedDays = 90;
    }

    const effectiveLookback = Math.min(lookbackDays || 30, maxAllowedDays);

    // Calculate Date Range
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - effectiveLookback);

    console.log(`📡 Fetching Zerodha Kite candles for ${resolved.tradingsymbol} (${effectiveLookback}d lookback, interval: ${interval})...`);

    const rawCandles = await kite.getHistoricalData(
      resolved.instrumentToken,
      interval,
      fromDate,
      toDate
    );

    if (!rawCandles || rawCandles.length === 0) return null;

    // Convert Zerodha candles format to Finvedas Trading Agent format
    const formatted = rawCandles.map(c => ({
      BUCKET: new Date(c.date).toISOString(),
      INSTRUMENT_SYMBOL: resolved.tradingsymbol,
      OPEN: Number(c.open),
      HIGH: Number(c.high),
      LOW: Number(c.low),
      CLOSE: Number(c.close),
      VOLUME: Number(c.volume),
      OPEN_INTEREST: Number(c.oi || 0),
    }));

    return {
      symbol: resolved.tradingsymbol,
      candles: formatted,
      currentPrice: formatted[formatted.length - 1]?.CLOSE,
      token: resolved.instrumentToken,
    };

  } catch (err) {
    console.warn(`⚠️ Zerodha Kite candles fetch error for ${rawSymbol}:`, err.message);
    return null;
  }
};
