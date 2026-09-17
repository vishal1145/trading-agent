/**
 * Finvedas Trading Agent — PostgreSQL Central Data Layer (via Prisma + Neon)
 *
 * Implements Instrument-Specific On-Demand Sync:
 *   - Only user orders, active orders, and PnL snapshots are stored in PostgreSQL.
 *   - Market data (candles & LTP ticks) is fetched real-time via Kite/Yahoo (without writing to DB).
 *
 * Pattern:
 *   1. Check PostgreSQL for the requested instrument's order / active position data.
 *   2. If present and fresh (< TTL) → Return directly from PostgreSQL ⚡
 *   3. If missing or stale → Fetch from Snowflake for that instrument → Save to PostgreSQL 📥 → Return from PostgreSQL
 */

import prisma from './db.js';
import * as sf from './snowflake.js';
export { normalizeSymbol } from './snowflake.js';

const TTL = {
  ACTIVE_ORDERS: 24 * 60 * 60 * 1000, // 24 hours
  PNL:           24 * 60 * 60 * 1000, // 24 hours
  ORDERS:        24 * 60 * 60 * 1000, // 24 hours
  CHAMPION:      24 * 60 * 60 * 1000, // 24 hours
};

// Helper to check if record is older than TTL
const isStale = (date, ttlMs) => {
  if (!date) return true;
  return (Date.now() - new Date(date).getTime()) > ttlMs;
};

// Safe date parser to avoid invalid Date objects being passed to Prisma
const parseDate = (val) => {
  if (!val) return new Date();
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date() : d;
};


// ─── 1. Get User Sentiment (Order History for Specific Instrument) ───────────
export const getUserSentiment = async (symbol) => {
  try {
    const cleanSymbol = sf.normalizeSymbol(symbol);

    // Check PostgreSQL first for this instrument
    const existingOrders = await prisma.orders.findMany({
      where: {
        OR: [
          { instrument_token: { contains: cleanSymbol, mode: 'insensitive' } },
          ...(cleanSymbol === 'NIFTY 50' ? [{}] : []),
        ],
      },
      orderBy: { created_at: 'desc' },
      take: 1,
    });

    const needSync = existingOrders.length === 0 || isStale(existingOrders[0]?.created_at, TTL.ORDERS);

    if (needSync) {
      console.log(`📡 [On-Demand Sync] Order history for '${cleanSymbol}' missing/stale in PostgreSQL. Fetching from Snowflake...`);
      const sfRawOrders = await sf.getRawOrders(cleanSymbol);

      if (sfRawOrders && sfRawOrders.length > 0) {
        console.log(`📥 [PostgreSQL] Saving ${sfRawOrders.length} orders for '${cleanSymbol}' into PostgreSQL...`);
        await prisma.orders.createMany({
          data: sfRawOrders.map(r => ({
            instrument_token: r.INSTRUMENT_TOKEN || cleanSymbol,
            order_type:       r.ORDER_TYPE,
            status:           r.STATUS,
            quantity:         parseFloat(r.QUANTITY || 0),
            price:            parseFloat(r.PRICE || 0),
            created_at:       parseDate(r.CREATED_AT),
          })),
          skipDuplicates: true,
        });
      }
    } else {
      console.log(`⚡ [PostgreSQL] Serving Order Sentiment for '${cleanSymbol}' directly from PostgreSQL`);
    }

    // Run aggregate query on PostgreSQL for this instrument
    const rows = await prisma.orders.groupBy({
      by: ['order_type', 'status'],
      where: {
        OR: [
          { instrument_token: { contains: cleanSymbol, mode: 'insensitive' } },
          ...(cleanSymbol === 'NIFTY 50' ? [{}] : []),
        ],
      },
      _count: { _all: true },
      _sum:   { quantity: true, price: true },
      _avg:   { price: true },
    });

    return rows.map(r => ({
      ORDER_TYPE:     r.order_type,
      STATUS:         r.status,
      ORDER_COUNT:    r._count._all,
      TOTAL_QUANTITY: r._sum.quantity || 0,
      AVG_PRICE:      r._avg.price    || 0,
      TOTAL_VALUE:    (r._sum.quantity || 0) * (r._avg.price || 0),
    }));

  } catch (err) {
    console.warn('⚠️ [PostgreSQL] getUserSentiment failed, falling back to Snowflake:', err.message);
    return await sf.getUserSentiment(symbol);
  }
};

// ─── 2. Get Active Orders (Open Positions for Specific Instrument) ───────────
export const getActiveOrders = async (symbol) => {
  try {
    const cleanSymbol = sf.normalizeSymbol(symbol);

    const existingActive = await prisma.active_orders.findMany({
      where: {
        OR: [
          { instrument_token: { contains: cleanSymbol, mode: 'insensitive' } },
          { instrument_id: { not: null } },
        ],
      },
      orderBy: { created_at: 'desc' },
      take: 1,
    });

    const needSync = existingActive.length === 0 || isStale(existingActive[0]?.created_at, TTL.ACTIVE_ORDERS);

    if (needSync) {
      console.log(`📡 [On-Demand Sync] Active positions for '${cleanSymbol}' missing/stale in PostgreSQL. Fetching from Snowflake...`);
      const sfActive = await sf.getActiveOrders(cleanSymbol);

      if (sfActive && sfActive.length > 0) {
        console.log(`📥 [PostgreSQL] Saving ${sfActive.length} active positions for '${cleanSymbol}' into PostgreSQL...`);
        await prisma.active_orders.createMany({
          data: sfActive.map(r => ({
            instrument_id:      r.INSTRUMENT_ID ? String(r.INSTRUMENT_ID) : null,
            origin_order_id:    r.ID ? String(r.ID) : null,
            quantity:           parseFloat(r.QUANTITY || 0),
            remaining_quantity: parseFloat(r.REMAINING_QUANTITY || 0),
            price:              parseFloat(r.PRICE || 0),
            order_product_type: r.ORDER_PRODUCT_TYPE || null,
            order_type:         r.ORDER_TYPE || null,
            instrument_token:   r.INSTRUMENT_TOKEN || cleanSymbol,
            created_at:         parseDate(r.CREATED_AT),
          })),
          skipDuplicates: true,
        });
      }
    } else {
      console.log(`⚡ [PostgreSQL] Serving Active Positions for '${cleanSymbol}' directly from PostgreSQL`);
    }

    const rows = await prisma.active_orders.findMany({
      where: {
        OR: [
          { instrument_token: { contains: cleanSymbol, mode: 'insensitive' } },
          { instrument_id: { not: null } },
        ],
      },
      orderBy: { created_at: 'desc' },
    });

    return rows.map(r => ({
      ID:                 r.id,
      INSTRUMENT_ID:      r.instrument_id,
      QUANTITY:           r.quantity,
      REMAINING_QUANTITY: r.remaining_quantity,
      PRICE:              r.price,
      ORDER_PRODUCT_TYPE: r.order_product_type,
      CREATED_AT:         r.created_at,
      ORDER_TYPE:         r.order_type,
      INSTRUMENT_TOKEN:   r.instrument_token,
    }));

  } catch (err) {
    console.warn('⚠️ [PostgreSQL] getActiveOrders failed, falling back to Snowflake:', err.message);
    return await sf.getActiveOrders(symbol);
  }
};

// ─── 3. Get PnL Snapshot (Platform Risk & Drawdown Data) ─────────────────────
export const getPnlSnapshot = async () => {
  try {
    return await sf.getPnlSnapshot();
  } catch (err) {
    console.warn('⚠️ [PostgreSQL] getPnlSnapshot failed:', err.message);
    return null;
  }
};

// ─── 4. User Behaviour & Profiles ───────────────────────────────────────────
export const getUserTradingProfiles = async () => {
  try {
    return await sf.getUserTradingProfiles();
  } catch (err) {
    console.warn('⚠️ [Data Layer] getUserTradingProfiles failed:', err.message);
    return [];
  }
};

export const getTopTraders = async () => {
  try {
    return await sf.getTopTraders();
  } catch (err) {
    console.warn('⚠️ [Data Layer] getTopTraders failed:', err.message);
    return [];
  }
};

export const getUserInstrumentPreference = async () => {
  try {
    return await sf.getUserInstrumentPreference();
  } catch (err) {
    console.warn('⚠️ [Data Layer] getUserInstrumentPreference failed:', err.message);
    return [];
  }
};

export const getTradeDurationPatterns = async () => {
  try {
    return await sf.getTradeDurationPatterns();
  } catch (err) {
    console.warn('⚠️ [Data Layer] getTradeDurationPatterns failed:', err.message);
    return [];
  }
};

export const getTradingHourPatterns = async () => {
  try {
    return await sf.getTradingHourPatterns();
  } catch (err) {
    console.warn('⚠️ [Data Layer] getTradingHourPatterns failed:', err.message);
    return [];
  }
};

export const getInstrumentChampionTrader = async (symbol) => {
  try {
    const cleanSymbol = sf.normalizeSymbol(symbol);

    // 1. Check PostgreSQL cache first
    const cached = await prisma.champion_traders.findUnique({
      where: { symbol: cleanSymbol },
    });

    if (cached && !isStale(cached.updated_at, TTL.CHAMPION)) {
      console.log(`⚡ [PostgreSQL] Serving Champion Playbook for '${cleanSymbol}' directly from PostgreSQL cache (0 Snowflake cost)`);
      return {
        is_instrument_specific: cached.is_instrument_specific,
        symbol:                 cached.symbol,
        trader_name:            cached.trader_name,
        favourite_instrument:   cached.favourite_instrument,
        total_trades:           cached.total_trades,
        total_pnl:              cached.total_pnl,
        win_rate_pct:           cached.win_rate_pct,
        avg_hold_mins:          cached.avg_hold_mins,
        avg_win_pnl:            cached.avg_win_pnl,
        avg_loss_pnl:           cached.avg_loss_pnl,
        risk_reward_ratio:      cached.risk_reward_ratio,
        preferred_product_type: cached.preferred_product_type,
        best_entry_hour_ist:    cached.best_entry_hour_ist,
      };
    }

    // 2. If missing or stale in PostgreSQL, fetch from Snowflake
    console.log(`📡 [On-Demand Sync] Champion Playbook for '${cleanSymbol}' missing/stale in PostgreSQL. Fetching from Snowflake...`);
    const sfChampion = await sf.getInstrumentChampionTrader(cleanSymbol);

    if (sfChampion) {
      console.log(`📥 [PostgreSQL] Saving Champion Playbook for '${cleanSymbol}' into PostgreSQL...`);
      await prisma.champion_traders.upsert({
        where: { symbol: cleanSymbol },
        update: {
          is_instrument_specific: sfChampion.is_instrument_specific,
          trader_name:            sfChampion.trader_name,
          favourite_instrument:   sfChampion.favourite_instrument || null,
          total_trades:           sfChampion.total_trades,
          total_pnl:              sfChampion.total_pnl,
          win_rate_pct:           sfChampion.win_rate_pct,
          avg_hold_mins:          sfChampion.avg_hold_mins,
          avg_win_pnl:            sfChampion.avg_win_pnl,
          avg_loss_pnl:           sfChampion.avg_loss_pnl,
          risk_reward_ratio:      sfChampion.risk_reward_ratio,
          preferred_product_type: sfChampion.preferred_product_type,
          best_entry_hour_ist:    sfChampion.best_entry_hour_ist,
          updated_at:             new Date(),
        },
        create: {
          symbol:                 cleanSymbol,
          is_instrument_specific: sfChampion.is_instrument_specific,
          trader_name:            sfChampion.trader_name,
          favourite_instrument:   sfChampion.favourite_instrument || null,
          total_trades:           sfChampion.total_trades,
          total_pnl:              sfChampion.total_pnl,
          win_rate_pct:           sfChampion.win_rate_pct,
          avg_hold_mins:          sfChampion.avg_hold_mins,
          avg_win_pnl:            sfChampion.avg_win_pnl,
          avg_loss_pnl:           sfChampion.avg_loss_pnl,
          risk_reward_ratio:      sfChampion.risk_reward_ratio,
          preferred_product_type: sfChampion.preferred_product_type,
          best_entry_hour_ist:    sfChampion.best_entry_hour_ist,
        },
      });
    }

    return sfChampion;
  } catch (err) {
    console.warn(`⚠️ [PostgreSQL] getInstrumentChampionTrader failed, falling back directly to Snowflake:`, err.message);
    return await sf.getInstrumentChampionTrader(symbol);
  }
};



