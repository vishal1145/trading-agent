import snowflake from 'snowflake-sdk';
import dotenv from 'dotenv';
import { getFromCache, saveToCache } from './localCache.js';

dotenv.config();

snowflake.configure({ logLevel: 'WARN' });


// ─── Create Connection ───────────────────────────────────
const connection = snowflake.createConnection({
  account:   process.env.SF_ACCOUNT,
  username:  process.env.SF_USER,
  password:  process.env.SF_PASSWORD,
  database:  process.env.SF_DATABASE,
  schema:    process.env.SF_SCHEMA,
  warehouse: process.env.SF_WAREHOUSE,
});

// ─── Connect ─────────────────────────────────────────────
export const connectSnowflake = () => {
  return new Promise((resolve, reject) => {
    connection.connect((err, conn) => {
      if (err) {
        console.error('❌ Snowflake connection failed:', err.message);
        reject(err);
      } else {
        console.log('✅ Snowflake connected!');
        resolve(conn);
      }
    });
  });
};

// ─── Execute Query ───────────────────────────────────────
export const query = (sql, binds = []) => {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: sql,
      binds,
      complete: (err, stmt, rows) => {
        if (err) {
          console.error('❌ Query failed:', err.message);
          reject(err);
        } else {
          resolve(rows);
        }
      },
    });
  });
};

// ─── Ticker Normalizer Helper ───────────────────────────
export const normalizeSymbol = (rawSymbol) => {
  if (!rawSymbol) return 'NIFTY 50';
  let s = rawSymbol.toString().trim().toUpperCase();

  // Strip common corporate suffixes & extra noise
  s = s.replace(/\s+(LTD|LIMITED|CORP|CORPORATION|INC|INDUSTRIES|INDIA|INDEX)$/gi, '').trim();

  // Benchmark Indices
  if (s === 'NIFTY' || s === 'NIFTY 50' || s === 'NIFTY50' || s === 'NIFTY INDEX') return 'NIFTY 50';
  if (s === 'BANK NIFTY' || s === 'BANKNIFTY' || s === 'NIFTY BANK' || s === 'BANK') return 'BANKNIFTY';
  if (s === 'FIN NIFTY' || s === 'FINNIFTY') return 'FINNIFTY';
  if (s === 'MIDCAP NIFTY' || s === 'MIDCPNIFTY') return 'MIDCPNIFTY';

  // Major Stock & Banking Aliases
  if (s === 'HDFC' || s === 'HDFC BANK' || s === 'HDFCBANK') return 'HDFCBANK';
  if (s === 'SBI' || s === 'STATE BANK OF INDIA' || s === 'STATE BANK' || s === 'SBIN') return 'SBIN';
  if (s === 'ICICI' || s === 'ICICI BANK' || s === 'ICICIBANK') return 'ICICIBANK';
  if (s === 'AXIS' || s === 'AXIS BANK' || s === 'AXISBANK') return 'AXISBANK';
  if (s === 'KOTAK' || s === 'KOTAK BANK' || s === 'KOTAK MAHINDRA' || s === 'KOTAKBANK') return 'KOTAKBANK';
  if (s === 'BAJAJ' || s === 'BAJAJ AUTO' || s === 'BAJAJ-AUTO') return 'BAJAJ-AUTO';
  if (s === 'BAJAJ FINANCE' || s === 'BAJAJ FIN' || s === 'BAJAJFINSV') return 'BAJAJFINSV';
  if (s === 'TATA' || s === 'TATA MOTORS' || s === 'TATAMOTORS') return 'TATAMOTORS';
  if (s === 'TATA STEEL' || s === 'TATASTEEL') return 'TATASTEEL';
  if (s === 'TCS' || s === 'TATA CONSULTANCY') return 'TCS';
  if (s === 'BHARTI' || s === 'AIRTEL' || s === 'BHARTI AIRTEL' || s === 'BHARTIARTL') return 'BHARTIARTL';
  if (s === 'L&T' || s === 'LARSEN' || s === 'LARSEN & TOUBRO' || s === 'LT') return 'LT';
  if (s === 'M&M' || s === 'MAHINDRA' || s === 'MAHINDRA & MAHINDRA') return 'M&M';
  if (s === 'MARUTI SUZUKI' || s === 'MARUTI') return 'MARUTI';
  if (s === 'RELIANCE INDUSTRIES' || s === 'RELIANCE' || s === 'RIL') return 'RELIANCE';
  if (s === 'LT FOODS' || s === 'LT-FOODS' || s === 'LTFOODS' || s === 'DAAWAT') return 'LTFOODS';

  return s;
};

export const getLatestCandles = async (symbol, timeframe = '1_hour', limit = 50) => {
  const cleanSymbol = normalizeSymbol(symbol);
  let tf = timeframe;
  // Snowflake DB only has 1m, 5m, 15m, and 1h tables. Map 1_day and 1_week to 1_hour
  if (tf === '1_day' || tf === 'day' || tf === '1_week' || tf === 'week' || tf === 'daily' || tf === 'weekly') {
    tf = '1_hour';
  }
  const table = `ltp_${tf}_candle`;
  let sql = `
    SELECT 
      BUCKET,
      INSTRUMENT_SYMBOL,
      OPEN,
      HIGH,
      LOW,
      CLOSE,
      VOLUME,
      OPEN_INTEREST
    FROM FINVEDAS_SYNC.RAW.${table}
    WHERE UPPER(INSTRUMENT_SYMBOL) = ?
    ORDER BY BUCKET DESC
    LIMIT ?
  `;
  let rows = await query(sql, [cleanSymbol, limit]);

  // Fallback 1: Try fuzzy search if exact symbol name differs, strictly excluding derivative option/futures contracts
  if (!rows || rows.length === 0) {
    const fuzzySymbol = cleanSymbol.split(' ')[0];
    const fallbackSql = `
      SELECT 
        BUCKET,
        INSTRUMENT_SYMBOL,
        OPEN,
        HIGH,
        LOW,
        CLOSE,
        VOLUME,
        OPEN_INTEREST
      FROM FINVEDAS_SYNC.RAW.${table}
      WHERE UPPER(INSTRUMENT_SYMBOL) LIKE ?
        AND UPPER(INSTRUMENT_SYMBOL) NOT LIKE '%CE'
        AND UPPER(INSTRUMENT_SYMBOL) NOT LIKE '%PE'
        AND UPPER(INSTRUMENT_SYMBOL) NOT LIKE '%FUT'
      ORDER BY LENGTH(INSTRUMENT_SYMBOL) ASC, BUCKET DESC
      LIMIT ?
    `;
    rows = await query(fallbackSql, [`%${fuzzySymbol}%`, limit]);
  }

  return rows.reverse(); // oldest first
};

// ─── Get All Instruments ─────────────────────────────────
export const getInstruments = async () => {
  const sql = `
    SELECT DISTINCT INSTRUMENT_SYMBOL
    FROM FINVEDAS_SYNC.RAW.ltp_1_hour_candle
    WHERE INSTRUMENT_SYMBOL NOT LIKE '%CE'
      AND INSTRUMENT_SYMBOL NOT LIKE '%PE'
      AND INSTRUMENT_SYMBOL NOT LIKE '%FUT'
    ORDER BY INSTRUMENT_SYMBOL
  `;
  return await query(sql);
};

// ─── Get Latest LTP ──────────────────────────────────────
export const getLatestLTP = async (symbol) => {
  const cleanSymbol = normalizeSymbol(symbol);
  const cacheKey = `latest_ltp_${cleanSymbol}`;
  const cached = getFromCache(cacheKey);
  if (cached) { console.log(`📦 Cache hit: ${cacheKey}`); return cached; }
  console.log(`❄️  Cache miss: fetching ${cacheKey} from Snowflake...`);

  const sql = `
    SELECT 
      INSTRUMENT_SYMBOL,
      PRICE,
      VOLUME_TRADED_TODAY,
      TIME
    FROM FINVEDAS_SYNC.RAW.ltp
    WHERE UPPER(INSTRUMENT_SYMBOL) = ?
    ORDER BY TIME DESC
    LIMIT 1
  `;
  const rows = await query(sql, [cleanSymbol]);
  if (rows && rows.length > 0) {
    saveToCache(cacheKey, rows[0]);
    return rows[0];
  }

  // Smart Fallback for LTP: Exclude derivative options & futures so LTP never grabs a ₹7 option contract
  const fuzzySymbol = cleanSymbol.split(' ')[0];
  const fallbackSql = `
    SELECT 
      INSTRUMENT_SYMBOL,
      PRICE,
      VOLUME_TRADED_TODAY,
      TIME
    FROM FINVEDAS_SYNC.RAW.ltp
    WHERE UPPER(INSTRUMENT_SYMBOL) LIKE ?
      AND UPPER(INSTRUMENT_SYMBOL) NOT LIKE '%CE'
      AND UPPER(INSTRUMENT_SYMBOL) NOT LIKE '%PE'
      AND UPPER(INSTRUMENT_SYMBOL) NOT LIKE '%FUT'
    ORDER BY LENGTH(INSTRUMENT_SYMBOL) ASC, TIME DESC
    LIMIT 1
  `;
  const fallbackRows = await query(fallbackSql, [`%${fuzzySymbol}%`]);
  const result = fallbackRows ? fallbackRows[0] : null;
  if (result) saveToCache(cacheKey, result);
  return result;
};

// ─── Get Market Breadth ──────────────────────────────────
export const getMarketBreadth = async () => {
  const cacheKey = 'market_breadth';
  const cached = getFromCache(cacheKey);
  if (cached) { console.log(`📦 Cache hit: ${cacheKey}`); return cached; }
  console.log(`❄️  Cache miss: fetching ${cacheKey} from Snowflake...`);

  const sql = `
    WITH latest AS (
      SELECT 
        INSTRUMENT_SYMBOL,
        CLOSE,
        LAG(CLOSE) OVER (
          PARTITION BY INSTRUMENT_SYMBOL 
          ORDER BY BUCKET
        ) AS prev_close
      FROM FINVEDAS_SYNC.RAW.ltp_1_hour_candle
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY INSTRUMENT_SYMBOL 
        ORDER BY BUCKET DESC
      ) = 1
    )
    SELECT
      COUNT(CASE WHEN CLOSE > prev_close THEN 1 END) AS advancing,
      COUNT(CASE WHEN CLOSE < prev_close THEN 1 END) AS declining,
      COUNT(CASE WHEN CLOSE = prev_close THEN 1 END) AS unchanged,
      COUNT(*) AS total
    FROM latest
    WHERE prev_close IS NOT NULL
  `;
  const rows = await query(sql);
  const result = rows[0] || null;
  if (result) saveToCache(cacheKey, result);
  return result;
};

// ─── Get User Sentiment (Full Orders History Scan) ────────
export const getUserSentiment = async (symbol) => {
  try {
    const cleanSymbol = normalizeSymbol(symbol);
    const cacheKey = `user_sentiment_${cleanSymbol}`;
    const cached = getFromCache(cacheKey);
    if (cached) { console.log(`📦 Cache hit: ${cacheKey}`); return cached; }
    console.log(`❄️  Cache miss: fetching ${cacheKey} from Snowflake...`);

    const sql = `
      SELECT
        ORDER_TYPE,
        STATUS,
        COUNT(*)          AS order_count,
        SUM(QUANTITY)     AS total_quantity,
        AVG(PRICE)        AS avg_price,
        SUM(QUANTITY * PRICE) AS total_value
      FROM FINVEDAS_SYNC.RAW.ORDERS
      WHERE UPPER(INSTRUMENT_TOKEN) LIKE ? OR ? = 'NIFTY 50'
      GROUP BY ORDER_TYPE, STATUS
      ORDER BY ORDER_TYPE, STATUS
    `;
    const rows = await query(sql, [`%${cleanSymbol}%`, cleanSymbol]);
    saveToCache(cacheKey, rows);
    return rows;
  } catch (error) {
    console.warn('⚠️  getUserSentiment skipped:', error.message.split('\n')[0]);
    return [];
  }
};

// ─── Get Options Data (Full 111M Row LTP Tick Scan) ─────
export const getOptionsData = async (symbol) => {
  try {
    const cleanSymbol = normalizeSymbol(symbol);
    const cacheKey = `options_data_${cleanSymbol}`;
    const cached = getFromCache(cacheKey);
    if (cached) { console.log(`📦 Cache hit: ${cacheKey}`); return cached; }
    console.log(`❄️  Cache miss: fetching ${cacheKey} from Snowflake...`);

    const sql = `
      SELECT
        INSTRUMENT_SYMBOL,
        PRICE,
        VOLUME_TRADED_TODAY,
        TIME
      FROM FINVEDAS_SYNC.RAW.LTP
      WHERE UPPER(INSTRUMENT_SYMBOL) LIKE ?
      AND (
        UPPER(INSTRUMENT_SYMBOL) LIKE '%CE' 
        OR UPPER(INSTRUMENT_SYMBOL) LIKE '%PE'
      )
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY INSTRUMENT_SYMBOL 
        ORDER BY TIME DESC
      ) = 1
      ORDER BY VOLUME_TRADED_TODAY DESC
    `;
    const rows = await query(sql, [`%${cleanSymbol}%`]);
    saveToCache(cacheKey, rows);
    return rows;
  } catch (error) {
    console.warn('⚠️  getOptionsData skipped (table may not exist):', error.message.split('\n')[0]);
    return [];
  }
};

// ─── Get Active Orders (Full Open Positions Scan) ─────────
export const getActiveOrders = async (symbol) => {
  try {
    const cleanSymbol = normalizeSymbol(symbol);
    const cacheKey = `active_orders_${cleanSymbol}`;
    const cached = getFromCache(cacheKey);
    if (cached) { console.log(`📦 Cache hit: ${cacheKey}`); return cached; }
    console.log(`❄️  Cache miss: fetching ${cacheKey} from Snowflake...`);

    const sql = `
      SELECT
        ao.ID,
        ao.INSTRUMENT_ID,
        ao.QUANTITY,
        ao.REMAINING_QUANTITY,
        ao.PRICE,
        ao.ORDER_PRODUCT_TYPE,
        ao.CREATED_AT,
        o.ORDER_TYPE,
        o.INSTRUMENT_TOKEN
      FROM FINVEDAS_SYNC.RAW.ACTIVE_ORDERS ao
      LEFT JOIN FINVEDAS_SYNC.RAW.ORDERS o
        ON ao.ORIGIN_ORDER_ID = o.ID
      WHERE UPPER(o.INSTRUMENT_TOKEN) LIKE ?
         OR ao.INSTRUMENT_ID IS NOT NULL
      ORDER BY ao.CREATED_AT DESC
    `;
    const rows = await query(sql, [`%${cleanSymbol}%`]);
    saveToCache(cacheKey, rows);
    return rows;
  } catch (error) {
    console.warn('⚠️  getActiveOrders skipped:', error.message.split('\n')[0]);
    return [];
  }
};

// ─── Deep Historical Candle Stats (10M+ Rows Analysis Across 1m, 5m, 15m, 1h) ──
export const getHistoricalCandleStats = async (symbol) => {
  try {
    const cleanSymbol = normalizeSymbol(symbol);
    const sql = `
      SELECT
        (SELECT COUNT(*) FROM FINVEDAS_SYNC.RAW.LTP_1_MINUTE_CANDLE WHERE UPPER(INSTRUMENT_SYMBOL) = ?)  AS total_1min_candles,
        (SELECT COUNT(*) FROM FINVEDAS_SYNC.RAW.LTP_5_MINUTE_CANDLE WHERE UPPER(INSTRUMENT_SYMBOL) = ?)  AS total_5min_candles,
        (SELECT COUNT(*) FROM FINVEDAS_SYNC.RAW.LTP_15_MINUTE_CANDLE WHERE UPPER(INSTRUMENT_SYMBOL) = ?) AS total_15min_candles,
        (SELECT COUNT(*) FROM FINVEDAS_SYNC.RAW.LTP_1_HOUR_CANDLE WHERE UPPER(INSTRUMENT_SYMBOL) = ?)   AS total_1hr_candles,
        MIN(LOW)               AS historical_support_low,
        MAX(HIGH)              AS historical_resistance_high,
        AVG(VOLUME)            AS avg_volume,
        STDDEV(CLOSE)          AS price_volatility,
        MIN(BUCKET)            AS oldest_record_date,
        MAX(BUCKET)            AS newest_record_date
      FROM FINVEDAS_SYNC.RAW.LTP_5_MINUTE_CANDLE
      WHERE UPPER(INSTRUMENT_SYMBOL) = ?
    `;
    const rows = await query(sql, [cleanSymbol, cleanSymbol, cleanSymbol, cleanSymbol, cleanSymbol]);
    const r = rows[0] || {};
    return {
      total_1min_candles: Number(r.TOTAL_1MIN_CANDLES || 0),
      total_5min_candles: Number(r.TOTAL_5MIN_CANDLES || 0),
      total_15min_candles: Number(r.TOTAL_15MIN_CANDLES || 0),
      total_1hr_candles:   Number(r.TOTAL_1HR_CANDLES || 0),
      total_rows_scanned: (Number(r.TOTAL_1MIN_CANDLES || 0) + Number(r.TOTAL_5MIN_CANDLES || 0) + Number(r.TOTAL_15MIN_CANDLES || 0) + Number(r.TOTAL_1HR_CANDLES || 0)),
      historical_support_low: r.HISTORICAL_SUPPORT_LOW,
      historical_resistance_high: r.HISTORICAL_RESISTANCE_HIGH,
      avg_volume: r.AVG_VOLUME,
      price_volatility: r.PRICE_VOLATILITY,
      oldest_record_date: r.OLDEST_RECORD_DATE,
      newest_record_date: r.NEWEST_RECORD_DATE,
    };
  } catch (error) {
    console.warn('⚠️  getHistoricalCandleStats skipped:', error.message.split('\n')[0]);
    return null;
  }
};

// ─── Get PnL Snapshot (Platform Fear/Greed Full Scan) ──────
export const getPnlSnapshot = async () => {
  try {
    const cacheKey = 'pnl_snapshot';
    const cached = getFromCache(cacheKey);
    if (cached) { console.log(`📦 Cache hit: ${cacheKey}`); return cached; }
    console.log(`❄️  Cache miss: fetching ${cacheKey} from Snowflake...`);

    const sql = `
      SELECT
        COUNT(*)             AS total_snapshots_analyzed,
        SUM(REALIZED_PNL)    AS total_realized_pnl,
        SUM(UNREALIZED_PNL)  AS total_unrealized_pnl,
        SUM(TOTAL_PNL)       AS total_pnl,
        AVG(DD_PCT)          AS avg_drawdown_pct,
        SUM(USED_MARGIN)     AS total_used_margin,
        SUM(AVAILABLE_MARGIN)AS total_available_margin,
        SUM(GROSS_EXPOSURE)  AS total_gross_exposure,
        COUNT(DISTINCT ACCOUNT_ID) AS active_accounts
      FROM FINVEDAS_SYNC.RAW.PNL_SNAPSHOTS
    `;
    const rows = await query(sql);
    const result = rows[0] || null;
    if (result) saveToCache(cacheKey, result);
    return result;
  } catch (error) {
    console.warn('⚠️  getPnlSnapshot skipped:', error.message.split('\n')[0]);
    return null;
  }
};

// ─── Get Multi-Timeframe Candles ─────────────────────────
// Returns candles for 1min, 5min, 15min alongside 1hour
export const getMultiTimeframeCandles = async (symbol, limit = 20) => {
  try {
    const timeframes = ['1_minute', '5_minute', '15_minute'];
    const results = await Promise.all(
      timeframes.map(tf =>
        getLatestCandles(symbol, tf, limit).catch(() => [])
      )
    );
    return {
      '1_minute':  results[0],
      '5_minute':  results[1],
      '15_minute': results[2],
    };
  } catch (error) {
    console.warn('⚠️  getMultiTimeframeCandles skipped:', error.message.split('\n')[0]);
    return {};
  }
};

// ─── Get Available Instruments ────────────────────────────
export const getAvailableInstruments = async () => {
  try {
    const sql = `
      SELECT DISTINCT INSTRUMENT_SYMBOL
      FROM FINVEDAS_SYNC.RAW.LTP_1_HOUR_CANDLE
      WHERE INSTRUMENT_SYMBOL IS NOT NULL
        AND INSTRUMENT_SYMBOL NOT LIKE '%CE'
        AND INSTRUMENT_SYMBOL NOT LIKE '%PE'
        AND INSTRUMENT_SYMBOL NOT LIKE '%FUT'
      ORDER BY INSTRUMENT_SYMBOL ASC
      LIMIT 50
    `;
    const rows = await query(sql);
    const cleaned = rows
      .map(r => r.INSTRUMENT_SYMBOL)
      .filter(s => s && !/\d{2}[A-Z]{3}/.test(s));

    const defaults = ['NIFTY 50', 'BANKNIFTY', 'SENSEX', '360ONE', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'MARUTI', 'ONGC'];
    const merged = Array.from(new Set([...defaults, ...cleaned]));
    return merged.slice(0, 12);
  } catch (error) {
    console.warn('⚠️  getAvailableInstruments skipped:', error.message.split('\n')[0]);
    return ['NIFTY 50', 'BANKNIFTY', 'SENSEX', '360ONE', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'MARUTI', 'ONGC'];
  }
};

// ─── Initialize Connection on startup ───────────────────
await connectSnowflake();