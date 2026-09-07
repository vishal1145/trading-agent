/**
 * Finvedas Trading Agent — Unified LTP Price Resolver
 *
 * Fetches the Last Traded Price (LTP) with a 3-tier priority fallback:
 *   Priority 1: Zerodha Kite Connect API (fastest, most accurate — real-time tick)
 *   Priority 2: Yahoo Finance API        (free, live — fallback if Kite is unavailable)
 *   Priority 3: Snowflake DB + SQLite    (proprietary DB — last resort with 2-min cache)
 *
 * All three sources return a normalised shape:
 *   { symbol, PRICE, VOLUME_TRADED_TODAY, TIME, source }
 */

import { getKiteLTP } from './kite.js';
import { getYahooLTP } from './yahoo.js';
import { getLatestLTP } from './snowflake.js';

/**
 * Get unified LTP with 3-tier priority fallback.
 * @param {string} symbol - Raw instrument symbol (e.g. 'RELIANCE', 'NIFTY 50')
 * @returns {object|null} Normalised LTP object or null if all sources fail
 */
export const getUnifiedLTP = async (symbol) => {
  // ── Priority 1: Zerodha Kite Connect ──────────────────────────────────
  try {
    const kiteResult = await getKiteLTP(symbol);
    if (kiteResult && kiteResult.price) {
      console.log(`✅ [LTP] Kite Connect — ${symbol}: ₹${kiteResult.price}`);
      return {
        symbol:               kiteResult.symbol,
        PRICE:                kiteResult.price,
        VOLUME_TRADED_TODAY:  kiteResult.volume || 0,
        TIME:                 new Date().toISOString(),
        source:               'Kite',
      };
    }
  } catch (err) {
    console.warn(`⚠️ [LTP] Kite failed for ${symbol}:`, err.message);
  }

  // ── Priority 2: Yahoo Finance ──────────────────────────────────────────
  try {
    const yahooResult = await getYahooLTP(symbol);
    if (yahooResult && yahooResult.PRICE) {
      console.log(`⭐ [LTP] Yahoo Finance — ${symbol}: ₹${yahooResult.PRICE}`);
      return yahooResult; // already normalised in getYahooLTP
    }
  } catch (err) {
    console.warn(`⚠️ [LTP] Yahoo Finance failed for ${symbol}:`, err.message);
  }

  // ── Priority 3: Snowflake DB (with SQLite cache) ───────────────────────
  try {
    const sfResult = await getLatestLTP(symbol);
    if (sfResult && sfResult.PRICE) {
      console.log(`❄️ [LTP] Snowflake DB — ${symbol}: ₹${sfResult.PRICE}`);
      return {
        symbol:               sfResult.INSTRUMENT_SYMBOL || symbol,
        PRICE:                sfResult.PRICE,
        VOLUME_TRADED_TODAY:  sfResult.VOLUME_TRADED_TODAY || 0,
        TIME:                 sfResult.TIME || new Date().toISOString(),
        source:               'Snowflake',
      };
    }
  } catch (err) {
    console.warn(`⚠️ [LTP] Snowflake failed for ${symbol}:`, err.message);
  }

  // All sources exhausted
  console.error(`❌ [LTP] All 3 sources failed for ${symbol}`);
  return null;
};
