import snowflake from 'snowflake-sdk';
import dotenv from 'dotenv';

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

// ─── Get Connection ──────────────────────────────────────
export const getConnection = async () => {
  return connection;
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
  if (s === 'SBI' || s === 'STATE BANK OF INDIA' || s === 'STATE BANK' || s === 'STATE BANK OF' || s === 'SBIN') return 'SBIN';
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

  return (rows || []).reverse(); // oldest first
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
  console.log(`❄️ Fetching latest LTP for ${cleanSymbol} from Snowflake...`);

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
    return rows[0];
  }

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
  return fallbackRows ? fallbackRows[0] : null;
};

// ─── Get Market Breadth ──────────────────────────────────
export const getMarketBreadth = async () => {
  console.log(`❄️ Fetching Market Breadth from Snowflake...`);

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
  return rows[0] || null;
};

// ─── Get User Sentiment ───────────────────────────────────
export const getUserSentiment = async (symbol) => {
  try {
    const cleanSymbol = normalizeSymbol(symbol);
    console.log(`❄️ Fetching User Sentiment for ${cleanSymbol} from Snowflake...`);

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
    return rows;
  } catch (error) {
    console.warn('⚠️ getUserSentiment skipped:', error.message.split('\n')[0]);
    return [];
  }
};

// ─── Get Raw Orders for DB Sync ───────────────────────────
export const getRawOrders = async (symbol) => {
  try {
    const cleanSymbol = normalizeSymbol(symbol);
    const sql = `
      SELECT
        ID,
        INSTRUMENT_TOKEN,
        ORDER_TYPE,
        STATUS,
        QUANTITY,
        PRICE,
        CREATED_AT
      FROM FINVEDAS_SYNC.RAW.ORDERS
      WHERE UPPER(INSTRUMENT_TOKEN) LIKE ? OR ? = 'NIFTY 50'
      LIMIT 200
    `;
    const rows = await query(sql, [`%${cleanSymbol}%`, cleanSymbol]);
    return rows;
  } catch (error) {
    console.warn('⚠️ getRawOrders skipped:', error.message.split('\n')[0]);
    return [];
  }
};

// ─── Get Options Data ─────────────────────────────────────
export const getOptionsData = async (symbol) => {
  try {
    const cleanSymbol = normalizeSymbol(symbol);
    console.log(`❄️ Fetching Options Data for ${cleanSymbol} from Snowflake...`);

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
    return rows;
  } catch (error) {
    console.warn('⚠️ getOptionsData skipped:', error.message.split('\n')[0]);
    return [];
  }
};

// ─── Get Active Orders ────────────────────────────────────
export const getActiveOrders = async (symbol) => {
  try {
    const cleanSymbol = normalizeSymbol(symbol);
    console.log(`❄️ Fetching Active Orders for ${cleanSymbol} from Snowflake...`);

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
    return rows;
  } catch (error) {
    console.warn('⚠️ getActiveOrders skipped:', error.message.split('\n')[0]);
    return [];
  }
};

// ─── Deep Historical Candle Stats ─────────────────────────
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
    console.warn('⚠️ getHistoricalCandleStats skipped:', error.message.split('\n')[0]);
    return null;
  }
};

// ─── Get PnL Snapshot ─────────────────────────────────────
export const getPnlSnapshot = async () => {
  try {
    console.log(`❄️ Fetching PnL Snapshot from Snowflake...`);

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
    return rows[0] || null;
  } catch (error) {
    console.warn('⚠️ getPnlSnapshot skipped:', error.message.split('\n')[0]);
    return null;
  }
};

// ─── Get Raw PnL Rows for Sync ────────────────────────────
export const getRawPnlRows = async () => {
  try {
    const sql = `
      SELECT
        ACCOUNT_ID,
        REALIZED_PNL,
        UNREALIZED_PNL,
        TOTAL_PNL,
        DD_PCT,
        USED_MARGIN,
        AVAILABLE_MARGIN,
        GROSS_EXPOSURE,
        CREATED_AT
      FROM FINVEDAS_SYNC.RAW.PNL_SNAPSHOTS
      LIMIT 100
    `;
    return await query(sql);
  } catch (error) {
    console.warn('⚠️ getRawPnlRows skipped:', error.message.split('\n')[0]);
    return [];
  }
};

// ─── Get Multi-Timeframe Candles ─────────────────────────
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
    console.warn('⚠️ getMultiTimeframeCandles skipped:', error.message.split('\n')[0]);
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
    console.warn('⚠️ getAvailableInstruments skipped:', error.message.split('\n')[0]);
    return ['NIFTY 50', 'BANKNIFTY', 'SENSEX', '360ONE', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'MARUTI', 'ONGC'];
  }
};

// ─── User Behaviour: Top Profitable Users ────────────────
export const getTopTraders = async () => {
  const conn = await getConnection();
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText: `
        SELECT 
          u.FULL_NAME,
          u.EMAIL,
          COUNT(t.ID)                    AS TOTAL_TRADES,
          SUM(t.REALISED_PNL)            AS TOTAL_PNL,
          AVG(t.REALISED_PNL)            AS AVG_PNL_PER_TRADE,
          SUM(CASE WHEN t.REALISED_PNL > 0 THEN 1 ELSE 0 END) AS WINNING_TRADES,
          SUM(CASE WHEN t.REALISED_PNL < 0 THEN 1 ELSE 0 END) AS LOSING_TRADES,
          ROUND(SUM(CASE WHEN t.REALISED_PNL > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(t.ID), 2) AS WIN_RATE_PCT,
          AVG(t.TRADE_DURATION / 60)     AS AVG_DURATION_MINS,
          SUM(t.TOTAL_CHARGES)           AS TOTAL_CHARGES
        FROM FINVEDAS_SYNC.RAW.USERS u
        JOIN FINVEDAS_SYNC.RAW.TRADES t ON t.USER_ID = u.ID
        WHERE t.STATUS = 'CLOSED'
        GROUP BY u.ID, u.FULL_NAME, u.EMAIL
        ORDER BY TOTAL_PNL DESC
      `,
      complete: (err, stmt, rows) => err ? reject(err) : resolve(rows),
    });
  });
};

// ─── User Behaviour: Instrument Preference per User ──────
export const getUserInstrumentPreference = async () => {
  const conn = await getConnection();
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText: `
        SELECT 
          u.FULL_NAME,
          t.INSTRUMENT_SYMBOL,
          COUNT(*)                  AS TRADES,
          SUM(t.REALISED_PNL)       AS PNL,
          AVG(t.REALISED_PNL)       AS AVG_PNL,
          AVG(t.TRADE_DURATION/60)  AS AVG_DURATION_MINS,
          t.ORDER_PRODUCT_TYPE
        FROM FINVEDAS_SYNC.RAW.TRADES t
        JOIN FINVEDAS_SYNC.RAW.USERS u ON u.ID = t.USER_ID
        WHERE t.STATUS = 'CLOSED'
        GROUP BY u.FULL_NAME, t.INSTRUMENT_SYMBOL, t.ORDER_PRODUCT_TYPE
        ORDER BY PNL DESC
      `,
      complete: (err, stmt, rows) => err ? reject(err) : resolve(rows),
    });
  });
};

// ─── User Behaviour: Trade Duration Patterns ─────────────
export const getTradeDurationPatterns = async () => {
  const conn = await getConnection();
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText: `
        SELECT
          u.FULL_NAME,
          CASE 
            WHEN t.TRADE_DURATION < 60   THEN 'under_1_min'
            WHEN t.TRADE_DURATION < 300  THEN '1_to_5_mins'
            WHEN t.TRADE_DURATION < 900  THEN '5_to_15_mins'
            WHEN t.TRADE_DURATION < 3600 THEN '15_to_60_mins'
            ELSE 'over_1_hour'
          END AS HOLD_DURATION,
          COUNT(*)              AS TRADES,
          SUM(t.REALISED_PNL)   AS TOTAL_PNL,
          AVG(t.REALISED_PNL)   AS AVG_PNL,
          ROUND(SUM(CASE WHEN t.REALISED_PNL > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS WIN_RATE
        FROM FINVEDAS_SYNC.RAW.TRADES t
        JOIN FINVEDAS_SYNC.RAW.USERS u ON u.ID = t.USER_ID
        WHERE t.STATUS = 'CLOSED'
        GROUP BY u.FULL_NAME, HOLD_DURATION
        ORDER BY TOTAL_PNL DESC
      `,
      complete: (err, stmt, rows) => err ? reject(err) : resolve(rows),
    });
  });
};

// ─── User Behaviour: Best Trading Hours (IST) ────────────
export const getTradingHourPatterns = async () => {
  const conn = await getConnection();
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText: `
        SELECT 
          u.FULL_NAME,
          HOUR(CONVERT_TIMEZONE('Asia/Kolkata', t.ENTRY_TIME)) AS HOUR_IST,
          COUNT(*)              AS TRADES,
          SUM(t.REALISED_PNL)   AS PNL,
          ROUND(SUM(CASE WHEN t.REALISED_PNL > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS WIN_RATE
        FROM FINVEDAS_SYNC.RAW.TRADES t
        JOIN FINVEDAS_SYNC.RAW.USERS u ON u.ID = t.USER_ID
        WHERE t.STATUS = 'CLOSED'
        GROUP BY u.FULL_NAME, HOUR_IST
        ORDER BY PNL DESC
      `,
      complete: (err, stmt, rows) => err ? reject(err) : resolve(rows),
    });
  });
};

// ─── User Behaviour: Comprehensive User Trading Profiles ─
export const getUserTradingProfiles = async () => {
  const conn = await getConnection();
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText: `
        SELECT 
          u.ID                                                           AS USER_ID,
          u.FULL_NAME,
          u.EMAIL,
          a.ACCOUNT_NO,
          a.ACCOUNT_SIZE,
          a.CURRENT_BALANCE,
          a.REALISED_PNL                                                 AS ACCOUNT_PNL,
          ROUND(a.REALISED_PNL * 100.0 / NULLIF(a.ACCOUNT_SIZE, 0), 2) AS PNL_PCT,
          a.STATUS                                                       AS ACCOUNT_STATUS,

          -- Trade summary
          COUNT(t.ID)                                                    AS TOTAL_TRADES,
          SUM(t.REALISED_PNL)                                            AS TOTAL_TRADE_PNL,
          AVG(t.REALISED_PNL)                                            AS AVG_PNL_PER_TRADE,
          MAX(t.REALISED_PNL)                                            AS BEST_TRADE,
          MIN(t.REALISED_PNL)                                            AS WORST_TRADE,
          SUM(CASE WHEN t.REALISED_PNL > 0 THEN 1 ELSE 0 END)           AS WINNING_TRADES,
          SUM(CASE WHEN t.REALISED_PNL < 0 THEN 1 ELSE 0 END)           AS LOSING_TRADES,
          ROUND(
            SUM(CASE WHEN t.REALISED_PNL > 0 THEN 1 ELSE 0 END) * 100.0
            / NULLIF(COUNT(t.ID), 0), 2
          )                                                              AS WIN_RATE_PCT,

          -- How they trade
          AVG(t.TRADE_DURATION / 60)                                     AS AVG_HOLD_MINS,
          MODE(t.INSTRUMENT_SYMBOL)                                      AS FAVOURITE_INSTRUMENT,
          MODE(t.ORDER_PRODUCT_TYPE)                                      AS PREFERRED_PRODUCT_TYPE,
          SUM(t.TOTAL_CHARGES)                                           AS TOTAL_CHARGES_PAID,
          SUM(t.REALISED_PNL) - SUM(t.TOTAL_CHARGES)                    AS NET_PNL_AFTER_CHARGES,

          -- Order behaviour
          COUNT(o.ID)                                                    AS TOTAL_ORDERS,
          SUM(CASE WHEN o.STATUS = 'EXECUTED' THEN 1 ELSE 0 END)        AS EXECUTED_ORDERS,
          SUM(CASE WHEN o.STATUS = 'CANCELLED' THEN 1 ELSE 0 END)       AS CANCELLED_ORDERS

        FROM FINVEDAS_SYNC.RAW.USERS u
        JOIN FINVEDAS_SYNC.RAW.ACCOUNTS a    ON a.USER_ID = u.ID
        LEFT JOIN FINVEDAS_SYNC.RAW.TRADES t ON t.USER_ID = u.ID AND t.STATUS = 'CLOSED'
        LEFT JOIN FINVEDAS_SYNC.RAW.ORDERS o ON o.USER_ID = u.ID
        WHERE u.DELETED_AT IS NULL
          AND a.DELETED_AT IS NULL
        GROUP BY u.ID, u.FULL_NAME, u.EMAIL, a.ACCOUNT_NO, a.ACCOUNT_SIZE, 
                 a.CURRENT_BALANCE, a.REALISED_PNL, a.STATUS
        ORDER BY TOTAL_TRADE_PNL DESC NULLS LAST
      `,
      complete: (err, stmt, rows) => err ? reject(err) : resolve(rows),
    });
  });
};

// ─── Champion Trader Reverse-Engineering: Instrument & Platform Playbook ──
export const getInstrumentChampionTrader = async (symbol) => {
  try {
    const cleanSymbol = normalizeSymbol(symbol);
    const shortSymbol = cleanSymbol.split(' ')[0];
    const conn = await getConnection();

    // 1. Try to find the #1 most profitable trader for this specific instrument
    const instrumentSql = `
      SELECT 
        u.FULL_NAME,
        COUNT(t.ID)                                         AS TOTAL_TRADES,
        SUM(t.REALISED_PNL)                                 AS TOTAL_PNL,
        AVG(t.TRADE_DURATION / 60)                          AS AVG_HOLD_MINS,
        ROUND(SUM(CASE WHEN t.REALISED_PNL > 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(t.ID), 0), 2) AS WIN_RATE_PCT,
        AVG(CASE WHEN t.REALISED_PNL > 0 THEN t.REALISED_PNL END) AS AVG_WIN_PNL,
        AVG(CASE WHEN t.REALISED_PNL < 0 THEN ABS(t.REALISED_PNL) END) AS AVG_LOSS_PNL,
        MODE(t.ORDER_PRODUCT_TYPE)                          AS PREFERRED_PRODUCT_TYPE,
        MODE(HOUR(CONVERT_TIMEZONE('Asia/Kolkata', t.ENTRY_TIME))) AS BEST_ENTRY_HOUR_IST,
        SUM(t.TOTAL_CHARGES)                                AS TOTAL_CHARGES
      FROM FINVEDAS_SYNC.RAW.TRADES t
      JOIN FINVEDAS_SYNC.RAW.USERS u ON u.ID = t.USER_ID
      WHERE t.STATUS = 'CLOSED'
        AND (
          UPPER(t.INSTRUMENT_SYMBOL) LIKE ?
          OR UPPER(t.INSTRUMENT_SYMBOL) LIKE ?
          OR ? = 'NIFTY 50'
        )
      GROUP BY u.ID, u.FULL_NAME
      HAVING SUM(t.REALISED_PNL) > 0 AND COUNT(t.ID) >= 3
      ORDER BY TOTAL_PNL DESC
      LIMIT 1
    `;

    const specificRows = await new Promise((resolve, reject) => {
      conn.execute({
        sqlText: instrumentSql,
        binds: [`%${cleanSymbol}%`, `%${shortSymbol}%`, cleanSymbol],
        complete: (err, stmt, rows) => err ? reject(err) : resolve(rows),
      });
    });

    if (specificRows && specificRows.length > 0) {
      const row = specificRows[0];
      const avgWin = Number(row.AVG_WIN_PNL || 0);
      const avgLoss = Number(row.AVG_LOSS_PNL || 0);
      const rrRatio = (avgLoss > 0 && avgWin > 0) ? Number((avgWin / avgLoss).toFixed(2)) : 1.5;

      return {
        is_instrument_specific: true,
        symbol: cleanSymbol,
        trader_name: row.FULL_NAME,
        total_trades: Number(row.TOTAL_TRADES || 0),
        total_pnl: Number(row.TOTAL_PNL || 0),
        win_rate_pct: Number(row.WIN_RATE_PCT || 0),
        avg_hold_mins: row.AVG_HOLD_MINS ? Number(Number(row.AVG_HOLD_MINS).toFixed(1)) : 30,
        avg_win_pnl: avgWin ? Number(avgWin.toFixed(2)) : null,
        avg_loss_pnl: avgLoss ? Number(avgLoss.toFixed(2)) : null,
        risk_reward_ratio: rrRatio,
        preferred_product_type: row.PREFERRED_PRODUCT_TYPE || 'MIS',
        best_entry_hour_ist: row.BEST_ENTRY_HOUR_IST !== null ? Number(row.BEST_ENTRY_HOUR_IST) : 10,
      };
    }

    // 2. Fallback: Find Platform-Wide Champion Trader across all instruments
    const platformSql = `
      SELECT 
        u.FULL_NAME,
        COUNT(t.ID)                                         AS TOTAL_TRADES,
        SUM(t.REALISED_PNL)                                 AS TOTAL_PNL,
        AVG(t.TRADE_DURATION / 60)                          AS AVG_HOLD_MINS,
        ROUND(SUM(CASE WHEN t.REALISED_PNL > 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(t.ID), 0), 2) AS WIN_RATE_PCT,
        AVG(CASE WHEN t.REALISED_PNL > 0 THEN t.REALISED_PNL END) AS AVG_WIN_PNL,
        AVG(CASE WHEN t.REALISED_PNL < 0 THEN ABS(t.REALISED_PNL) END) AS AVG_LOSS_PNL,
        MODE(t.INSTRUMENT_SYMBOL)                           AS FAVOURITE_INSTRUMENT,
        MODE(t.ORDER_PRODUCT_TYPE)                          AS PREFERRED_PRODUCT_TYPE,
        MODE(HOUR(CONVERT_TIMEZONE('Asia/Kolkata', t.ENTRY_TIME))) AS BEST_ENTRY_HOUR_IST
      FROM FINVEDAS_SYNC.RAW.TRADES t
      JOIN FINVEDAS_SYNC.RAW.USERS u ON u.ID = t.USER_ID
      WHERE t.STATUS = 'CLOSED'
      GROUP BY u.ID, u.FULL_NAME
      HAVING SUM(t.REALISED_PNL) > 0 AND COUNT(t.ID) >= 5
      ORDER BY TOTAL_PNL DESC
      LIMIT 1
    `;

    const platformRows = await new Promise((resolve, reject) => {
      conn.execute({
        sqlText: platformSql,
        complete: (err, stmt, rows) => err ? reject(err) : resolve(rows),
      });
    });

    if (platformRows && platformRows.length > 0) {
      const row = platformRows[0];
      const avgWin = Number(row.AVG_WIN_PNL || 0);
      const avgLoss = Number(row.AVG_LOSS_PNL || 0);
      const rrRatio = (avgLoss > 0 && avgWin > 0) ? Number((avgWin / avgLoss).toFixed(2)) : 1.5;

      return {
        is_instrument_specific: false,
        symbol: cleanSymbol,
        trader_name: row.FULL_NAME,
        favourite_instrument: row.FAVOURITE_INSTRUMENT || 'NIFTY 50',
        total_trades: Number(row.TOTAL_TRADES || 0),
        total_pnl: Number(row.TOTAL_PNL || 0),
        win_rate_pct: Number(row.WIN_RATE_PCT || 0),
        avg_hold_mins: row.AVG_HOLD_MINS ? Number(Number(row.AVG_HOLD_MINS).toFixed(1)) : 30,
        avg_win_pnl: avgWin ? Number(avgWin.toFixed(2)) : null,
        avg_loss_pnl: avgLoss ? Number(avgLoss.toFixed(2)) : null,
        risk_reward_ratio: rrRatio,
        preferred_product_type: row.PREFERRED_PRODUCT_TYPE || 'MIS',
        best_entry_hour_ist: row.BEST_ENTRY_HOUR_IST !== null ? Number(row.BEST_ENTRY_HOUR_IST) : 10,
      };
    }

    return null;
  } catch (err) {
    console.warn(`⚠️ getInstrumentChampionTrader skipped for ${symbol}:`, err.message.split('\n')[0]);
    return null;
  }
};

// ─── Initialize Connection on startup ───────────────────
await connectSnowflake();