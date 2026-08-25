import Groq from 'groq-sdk';
import {
  getOptionsData,
  getUserSentiment,
  getMarketBreadth,
  getLatestLTP,
  getActiveOrders,
  getPnlSnapshot,
} from '../tools/snowflake.js';
import dotenv from 'dotenv';

dotenv.config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ─── Sentiment Agent ─────────────────────────────────────
// Analyzes:
// 1. Options data (Put/Call ratio)
// 2. User trade sentiment (what users are buying/selling)
// 3. Market breadth (how many stocks up vs down)

export const sentimentAgent = async (symbol) => {
  try {
    console.log(`🎭 Sentiment Agent analyzing ${symbol}...`);

    // Step 1: Fetch all sentiment data in parallel
    const [optionsData, userSentiment, marketBreadth, latestLTP, activeOrders, pnlSnapshot] =
      await Promise.all([
        getOptionsData(symbol),
        getUserSentiment(symbol),
        getMarketBreadth(),
        getLatestLTP(symbol),
        getActiveOrders(symbol),
        getPnlSnapshot(),
      ]);

    // ─── Active Orders Analysis ───────────────────────────
    const activeLongs = activeOrders.filter(o => o.ORDER_TYPE === 'BUY');
    const activeShorts = activeOrders.filter(o => o.ORDER_TYPE === 'SELL');
    const activeLongQty = activeLongs.reduce((s, o) => s + parseInt(o.QUANTITY || 0), 0);
    const activeShortQty = activeShorts.reduce((s, o) => s + parseInt(o.QUANTITY || 0), 0);
    const activePositionBias = activeLongQty > activeShortQty ? 'NET_LONG' :
      activeShortQty > activeLongQty ? 'NET_SHORT' : 'FLAT';

    // ─── PnL / Fear-Greed ────────────────────────────────
    const totalPnl = parseFloat(pnlSnapshot?.TOTAL_PNL || 0);
    const drawdownPct = parseFloat(pnlSnapshot?.AVG_DRAWDOWN_PCT || 0);
    const usedMargin = parseFloat(pnlSnapshot?.TOTAL_USED_MARGIN || 0);
    const availMargin = parseFloat(pnlSnapshot?.TOTAL_AVAILABLE_MARGIN || 0);
    const marginUtil = availMargin > 0 ? parseFloat(((usedMargin / (usedMargin + availMargin)) * 100).toFixed(1)) : 0;
    const fearGreed = totalPnl > 0 ? 'GREED' : totalPnl < 0 ? 'FEAR' : 'NEUTRAL';


    // Step 2: Calculate Put/Call Ratio
    const calls = optionsData.filter(o =>
      o.INSTRUMENT_SYMBOL.endsWith('CE')
    );
    const puts = optionsData.filter(o =>
      o.INSTRUMENT_SYMBOL.endsWith('PE')
    );

    const totalCallVolume = calls.reduce(
      (sum, c) => sum + parseFloat(c.VOLUME_TRADED_TODAY || 0), 0
    );
    const totalPutVolume = puts.reduce(
      (sum, p) => sum + parseFloat(p.VOLUME_TRADED_TODAY || 0), 0
    );

    const putCallRatio = totalCallVolume > 0
      ? parseFloat((totalPutVolume / totalCallVolume).toFixed(2))
      : null;

    // Step 3: Calculate user sentiment from real ORDERS data
    // userSentiment rows: { ORDER_TYPE, STATUS, order_count, total_quantity, avg_price, total_value }
    const executedBuys = userSentiment.filter(s => s.ORDER_TYPE === 'BUY' && s.STATUS === 'EXECUTED');
    const executedSells = userSentiment.filter(s => s.ORDER_TYPE === 'SELL' && s.STATUS === 'EXECUTED');
    const pendingBuys = userSentiment.filter(s => s.ORDER_TYPE === 'BUY' && s.STATUS !== 'EXECUTED');
    const pendingSells = userSentiment.filter(s => s.ORDER_TYPE === 'SELL' && s.STATUS !== 'EXECUTED');

    const totalBuyQty = executedBuys.reduce((s, r) => s + parseInt(r.TOTAL_QUANTITY || 0), 0);
    const totalSellQty = executedSells.reduce((s, r) => s + parseInt(r.TOTAL_QUANTITY || 0), 0);
    const totalBuyValue = executedBuys.reduce((s, r) => s + parseFloat(r.TOTAL_VALUE || 0), 0);
    const totalSellValue = executedSells.reduce((s, r) => s + parseFloat(r.TOTAL_VALUE || 0), 0);
    const totalBuyOrders = executedBuys.reduce((s, r) => s + parseInt(r.ORDER_COUNT || 0), 0);
    const totalSellOrders = executedSells.reduce((s, r) => s + parseInt(r.ORDER_COUNT || 0), 0);
    const avgBuyPrice = executedBuys[0]?.AVG_PRICE || null;
    const avgSellPrice = executedSells[0]?.AVG_PRICE || null;
    const totalOrders = totalBuyOrders + totalSellOrders;

    const userBias = totalBuyQty > totalSellQty ? 'BUYING' :
      totalSellQty > totalBuyQty ? 'SELLING' : 'NEUTRAL';

    // Step 4: Market breadth analysis
    const advanceDeclineRatio = marketBreadth?.DECLINING > 0
      ? parseFloat((marketBreadth.ADVANCING / marketBreadth.DECLINING).toFixed(2))
      : null;

    const breadthSignal = advanceDeclineRatio
      ? advanceDeclineRatio > 1.5 ? 'STRONG_BULLISH'
        : advanceDeclineRatio > 1.0 ? 'BULLISH'
          : advanceDeclineRatio < 0.5 ? 'STRONG_BEARISH'
            : 'BEARISH'
      : 'NEUTRAL';

    // Step 5: Ask Groq to analyze sentiment
    const prompt = `
You are an expert market sentiment analyst for Indian markets.
Analyze the following sentiment data for ${symbol}.

CURRENT PRICE: ${latestLTP?.PRICE || 'N/A'}
VOLUME TODAY: ${latestLTP?.VOLUME_TRADED_TODAY || 'N/A'}

OPTIONS DATA (Put/Call Analysis):
- Total Call Volume (CE): ${totalCallVolume.toLocaleString()}
- Total Put Volume (PE): ${totalPutVolume.toLocaleString()}
- Put/Call Ratio: ${putCallRatio}
- Top Calls: ${JSON.stringify(calls.slice(0, 3).map(c => ({
      symbol: c.INSTRUMENT_SYMBOL,
      price: c.PRICE,
      volume: c.VOLUME_TRADED_TODAY
    })))}
- Top Puts: ${JSON.stringify(puts.slice(0, 3).map(p => ({
      symbol: p.INSTRUMENT_SYMBOL,
      price: p.PRICE,
      volume: p.VOLUME_TRADED_TODAY
    })))}

ACTIVE POSITIONS (Right Now):
- Open Long positions: ${activeLongs.length} orders | ${activeLongQty.toLocaleString()} qty
- Open Short positions: ${activeShorts.length} orders | ${activeShortQty.toLocaleString()} qty
- Net Position Bias: ${activePositionBias}

PLATFORM PnL / FEAR-GREED:
- Total Realized PnL: ₹${parseFloat(pnlSnapshot?.TOTAL_REALIZED_PNL || 0).toFixed(0)}
- Total Unrealized PnL: ₹${parseFloat(pnlSnapshot?.TOTAL_UNREALIZED_PNL || 0).toFixed(0)}
- Avg Drawdown: ${drawdownPct.toFixed(2)}%
- Margin Utilization: ${marginUtil}%
- Fear/Greed Gauge: ${fearGreed}
- Active Accounts: ${pnlSnapshot?.ACTIVE_ACCOUNTS || 0}

USER ORDER FLOW (Last 24 hours — EXECUTED orders):
- Buy Orders:  ${totalBuyOrders} orders | ${totalBuyQty.toLocaleString()} qty | ₹${totalBuyValue.toFixed(0)} total | avg price ₹${avgBuyPrice?.toFixed(2) || 'N/A'}
- Sell Orders: ${totalSellOrders} orders | ${totalSellQty.toLocaleString()} qty | ₹${totalSellValue.toFixed(0)} total | avg price ₹${avgSellPrice?.toFixed(2) || 'N/A'}
- Pending Buys:  ${pendingBuys.reduce((s, r) => s + parseInt(r.ORDER_COUNT || 0), 0)} orders
- Pending Sells: ${pendingSells.reduce((s, r) => s + parseInt(r.ORDER_COUNT || 0), 0)} orders
- Net User Bias: ${userBias}
- Total Orders: ${totalOrders}

MARKET BREADTH:
- Advancing stocks: ${marketBreadth?.ADVANCING || 0}
- Declining stocks: ${marketBreadth?.DECLINING || 0}
- Unchanged: ${marketBreadth?.UNCHANGED || 0}
- Advance/Decline Ratio: ${advanceDeclineRatio}
- Breadth Signal: ${breadthSignal}

Provide sentiment analysis in this EXACT JSON format:
{
  "overall_sentiment": "BULLISH|BEARISH|NEUTRAL",
  "strength": "STRONG|MODERATE|WEAK",
  "put_call_analysis": "<what PCR indicates>",
  "pcr_signal": "BULLISH|BEARISH|NEUTRAL",
  "active_position_bias": "${activePositionBias}",
  "active_position_analysis": "<what live open positions indicate>",
  "fear_greed": "${fearGreed}",
  "fear_greed_analysis": "<what PnL and margin data tells us about trader psychology>",
  "user_sentiment": "${userBias}",
  "user_sentiment_analysis": "<what user order flow indicates about retail behavior>",
  "buy_sell_ratio": "<buy qty vs sell qty interpretation>",
  "market_breadth_signal": "${breadthSignal}",
  "breadth_analysis": "<what market breadth indicates>",
  "options_insight": "<key options market insight>",
  "smart_money": "BUYING|SELLING|NEUTRAL",
  "retail_money": "BUYING|SELLING|NEUTRAL",
  "confidence": <0-100>,
  "summary": "<2-3 sentence sentiment summary for a trader>"
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
              content: 'You are an expert market sentiment analyst for Indian stock markets. Always respond with valid JSON only.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 2000,
        });
        if (response && response.choices && response.choices[0]) break;
      } catch (err) {
        console.warn(`⚠️ Sentiment Agent model '${model}' failed/rate limited: ${err.message}. Trying next fallback...`);
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
    const sentiment = JSON.parse(cleanText);

    console.log(`✅ Sentiment Agent done for ${symbol}:`,
      sentiment.overall_sentiment,
      sentiment.confidence + '%'
    );

    return {
      symbol,
      put_call_ratio: putCallRatio,
      advance_decline: advanceDeclineRatio,
      breadth_signal: breadthSignal,
      user_bias: userBias,
      active_position_bias: activePositionBias,
      active_longs: activeLongs.length,
      active_shorts: activeShorts.length,
      active_long_qty: activeLongQty,
      active_short_qty: activeShortQty,
      fear_greed: fearGreed,
      margin_utilization: marginUtil,
      drawdown_pct: drawdownPct,
      total_buy_orders: totalBuyOrders,
      total_sell_orders: totalSellOrders,
      total_buy_qty: totalBuyQty,
      total_sell_qty: totalSellQty,
      total_buy_value: totalBuyValue,
      total_sell_value: totalSellValue,
      total_call_volume: totalCallVolume,
      total_put_volume: totalPutVolume,
      market_breadth: marketBreadth,
      pnl_snapshot: pnlSnapshot,
      sentiment,
    };

  } catch (error) {
    console.error('❌ Sentiment Agent error:', error.message);
    return {
      error: error.message,
      symbol,
    };
  }
};