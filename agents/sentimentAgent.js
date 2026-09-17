import { runLLMCompletion, parseLLMJson } from '../tools/alerts.js';
import {
  getOptionsData,
  getMarketBreadth,
} from '../tools/snowflake.js';
import {
  getUserSentiment,
  getActiveOrders,
  getPnlSnapshot,
} from '../tools/finvedasDB.js';
import { getUnifiedLTP } from '../tools/price.js';
import { getNSEOptionsPCR, getFIIDIIData, getIndiaVIX } from '../tools/nse.js';
import { getStockNews } from '../tools/news.js';
import { getRedditSentiment } from '../tools/reddit.js';
import dotenv from 'dotenv';

dotenv.config();

// ─── Sentiment Agent ─────────────────────────────────────
// Multi-Source Sentiment Architecture:
// 1. Proprietary Snowflake DB (User orders, active positions, platform PnL)
// 2. Free NSE Option Chain (Real-time PCR Volume & Open Interest)
// 3. FII/DII Institutional Activity (Smart Money Net Flows)
// 4. India VIX (Market Volatility / Fear-Greed Index)
// 5. Google News RSS Headlines (Media sentiment)
// 6. Reddit r/IndianStreetBets (Social sentiment)

export const sentimentAgent = async (symbol, abortSignal = null) => {
  try {
    if (abortSignal?.aborted) throw new Error('Analysis aborted by user.');
    console.log(`🎭 Sentiment Agent analyzing ${symbol} (Snowflake + Free Multi-Source)...`);

    // Step 1: Fetch all data sources in parallel safely
    const [
      snowflakeOptions,
      userSentiment,
      marketBreadth,
      latestLTP,
      activeOrders,
      pnlSnapshot,
      nseOptions,
      fiiDiiData,
      indiaVix,
      newsHeadlines,
      redditPosts,
    ] = await Promise.all([
      getOptionsData(symbol).catch(() => []),
      getUserSentiment(symbol).catch(() => []),
      getMarketBreadth().catch(() => null),
      getUnifiedLTP(symbol).catch(() => null),
      getActiveOrders(symbol).catch(() => []),
      getPnlSnapshot().catch(() => null),
      getNSEOptionsPCR(symbol).catch(() => null),
      getFIIDIIData().catch(() => null),
      getIndiaVIX().catch(() => null),
      getStockNews(symbol).catch(() => []),
      getRedditSentiment(symbol).catch(() => []),
    ]);

    // ─── 1. Active Orders & Position Bias ────────────────
    const activeLongs = (activeOrders || []).filter(o => o.ORDER_TYPE === 'BUY');
    const activeShorts = (activeOrders || []).filter(o => o.ORDER_TYPE === 'SELL');
    const activeLongQty = activeLongs.reduce((s, o) => s + parseInt(o.QUANTITY || 0), 0);
    const activeShortQty = activeShorts.reduce((s, o) => s + parseInt(o.QUANTITY || 0), 0);
    const activePositionBias = activeLongQty > activeShortQty ? 'NET_LONG' :
      activeShortQty > activeLongQty ? 'NET_SHORT' : 'FLAT';

    // ─── 2. Platform PnL / Fear-Greed ─────────────────────
    const totalPnl = parseFloat(pnlSnapshot?.TOTAL_PNL || 0);
    const drawdownPct = parseFloat(pnlSnapshot?.AVG_DRAWDOWN_PCT || 0);
    const usedMargin = parseFloat(pnlSnapshot?.TOTAL_USED_MARGIN || 0);
    const availMargin = parseFloat(pnlSnapshot?.TOTAL_AVAILABLE_MARGIN || 0);
    const marginUtil = availMargin > 0 ? parseFloat(((usedMargin / (usedMargin + availMargin)) * 100).toFixed(1)) : 0;
    
    // Combine Platform PnL with India VIX for Master Fear/Greed
    const vixMood = indiaVix?.mood || 'NEUTRAL_NORMAL';
    const fearGreed = vixMood === 'HIGH_FEAR' ? 'FEAR' :
      totalPnl > 0 ? 'GREED' : totalPnl < 0 ? 'FEAR' : 'NEUTRAL';

    // ─── 3. Option Chain & PCR Analysis (Snowflake + Fallback NSE) ──
    const calls = (snowflakeOptions || []).filter(o => o.INSTRUMENT_SYMBOL?.endsWith('CE'));
    const puts = (snowflakeOptions || []).filter(o => o.INSTRUMENT_SYMBOL?.endsWith('PE'));
    const sfCallVol = calls.reduce((s, c) => s + parseFloat(c.VOLUME_TRADED_TODAY || 0), 0);
    const sfPutVol = puts.reduce((s, p) => s + parseFloat(p.VOLUME_TRADED_TODAY || 0), 0);
    const sfPCR = sfCallVol > 0 ? parseFloat((sfPutVol / sfCallVol).toFixed(2)) : null;

    // Use NSE live PCR if Snowflake PCR is unavailable or 0
    const finalPCR = sfPCR || nseOptions?.pcrOI || nseOptions?.pcrVolume || null;
    const pcrSource = sfPCR ? 'Snowflake DB' : nseOptions ? 'NSE Live Option Chain' : 'N/A';

    // ─── 4. User Order Flow Sentiment ──────────────────────
    const executedBuys = (userSentiment || []).filter(s => s.ORDER_TYPE === 'BUY' && s.STATUS === 'EXECUTED');
    const executedSells = (userSentiment || []).filter(s => s.ORDER_TYPE === 'SELL' && s.STATUS === 'EXECUTED');
    const pendingBuys = (userSentiment || []).filter(s => s.ORDER_TYPE === 'BUY' && s.STATUS !== 'EXECUTED');
    const pendingSells = (userSentiment || []).filter(s => s.ORDER_TYPE === 'SELL' && s.STATUS !== 'EXECUTED');

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

    // ─── 5. Market Breadth ─────────────────────────────────
    const advanceDeclineRatio = marketBreadth?.DECLINING > 0
      ? parseFloat((marketBreadth.ADVANCING / marketBreadth.DECLINING).toFixed(2))
      : null;

    const breadthSignal = advanceDeclineRatio
      ? advanceDeclineRatio > 1.5 ? 'STRONG_BULLISH'
        : advanceDeclineRatio > 1.0 ? 'BULLISH'
          : advanceDeclineRatio < 0.5 ? 'STRONG_BEARISH'
            : 'BEARISH'
      : 'NEUTRAL';

    // ─── 6. Build Multi-Source LLM Prompt ──────────────────
    const prompt = `
You are an expert market sentiment analyst for Indian stock markets (NSE/BSE).
Analyze multi-source sentiment data for ${symbol}.

CURRENT PRICE: ${latestLTP?.PRICE || 'N/A'}
VOLUME TODAY: ${latestLTP?.VOLUME_TRADED_TODAY || 'N/A'}

1. OPTIONS DATA (Put/Call Analysis — Source: ${pcrSource}):
- Put/Call Ratio (PCR): ${finalPCR || 'N/A'}
- Call Volume: ${sfCallVol || nseOptions?.totalCallVolume || 0}
- Put Volume: ${sfPutVol || nseOptions?.totalPutVolume || 0}
- Open Interest PCR: ${nseOptions?.pcrOI || 'N/A'}
- PCR Signal: ${nseOptions?.pcrSignal || (finalPCR > 1 ? 'BULLISH' : 'BEARISH')}
- Call Wall: ₹${nseOptions?.callWall || 'N/A'} (Max Call OI — resistance ceiling)
- Put Wall: ₹${nseOptions?.putWall || 'N/A'} (Max Put OI — support floor)
- Max Pain: ₹${nseOptions?.maxPain || 'N/A'}
${nseOptions?.deltaOI ? `
1b. ΔOI (CHANGE IN OPEN INTEREST — What's happening RIGHT NOW):
- Total Call ΔOI: ${nseOptions.deltaOI.totalCallDelta > 0 ? '+' : ''}${nseOptions.deltaOI.totalCallDelta?.toLocaleString() || '0'}
- Total Put ΔOI: ${nseOptions.deltaOI.totalPutDelta > 0 ? '+' : ''}${nseOptions.deltaOI.totalPutDelta?.toLocaleString() || '0'}
- ΔOI Signal: ${nseOptions.deltaOI.signal} — ${nseOptions.deltaOI.description}
- Top OI Buildup Strikes: ${nseOptions.deltaOI.topBuildups?.slice(0, 3).map(b => `₹${b.strike} (Call Δ: ${b.call_delta > 0 ? '+' : ''}${b.call_delta}, Put Δ: ${b.put_delta > 0 ? '+' : ''}${b.put_delta} → ${b.activity})`).join(', ') || 'N/A'}
- Fastest Call Writing at: ₹${nseOptions.deltaOI.fastestCallWriting?.strike || 'N/A'} (+${nseOptions.deltaOI.fastestCallWriting?.delta?.toLocaleString() || 0} OI)
- Fastest Put Writing at: ₹${nseOptions.deltaOI.fastestPutWriting?.strike || 'N/A'} (+${nseOptions.deltaOI.fastestPutWriting?.delta?.toLocaleString() || 0} OI)
` : ''}
${nseOptions?.zonePCR ? `
1c. ZONE PCR (OI Distribution Above vs Below Spot):
- Ceiling PCR (above spot): ${nseOptions.zonePCR.ceilingPCR ?? 'N/A'} — ${nseOptions.zonePCR.ceilingPCR < 0.5 ? 'Heavy call writing above = strong resistance' : 'Moderate ceiling pressure'}
- Floor PCR (below spot): ${nseOptions.zonePCR.floorPCR ?? 'N/A'} — ${nseOptions.zonePCR.floorPCR > 1.5 ? 'Heavy put writing below = strong support' : 'Moderate floor support'}
- Zone Signal: ${nseOptions.zonePCR.signal}
` : ''}

2. INSTITUTIONAL SMART MONEY (FII / DII Net Flow):
- Summary: ${fiiDiiData?.summary || 'N/A'}
- Smart Money Bias: ${fiiDiiData?.smartMoneyBias || 'NEUTRAL'}

3. MARKET VOLATILITY & FEAR/GREED:
- India VIX Index: ${indiaVix?.vix || 15.0} (${indiaVix?.change ? indiaVix.change.toFixed(2) + '%' : '0%'})
- Fear/Greed Gauge: ${fearGreed} (VIX Mood: ${vixMood})
- Margin Utilization: ${marginUtil}% | Drawdown: ${drawdownPct.toFixed(2)}%

4. MEDIA & NEWS HEADLINES (Last 24 Hours):
${newsHeadlines.length > 0 ? newsHeadlines.map(n => `- "${n.title}" (${n.pubDate})`).join('\n') : '- No recent news headlines found'}

5. SOCIAL SENTIMENT (r/IndianStreetBets Reddit):
${redditPosts.length > 0 ? redditPosts.map(p => `- "${p.title}" (${p.ups} upvotes)`).join('\n') : '- No recent social discussions found'}

6. PLATFORM USER ORDER FLOW & POSITIONS:
- User Order Bias: ${userBias} (${totalBuyOrders} Buy orders vs ${totalSellOrders} Sell orders)
- Active Positions Bias: ${activePositionBias} (${activeLongs.length} Longs vs ${activeShorts.length} Shorts)

Provide comprehensive sentiment analysis in this EXACT JSON format:
{
  "overall_sentiment": "BULLISH|BEARISH|NEUTRAL",
  "strength": "STRONG|MODERATE|WEAK",
  "put_call_analysis": "<what PCR and options data indicate>",
  "pcr_signal": "${nseOptions?.pcrSignal || 'NEUTRAL'}",
  "smart_money": "${fiiDiiData?.smartMoneyBias || 'NEUTRAL'}",
  "smart_money_analysis": "<what FII/DII institutional net flows indicate>",
  "vix_analysis": "<what India VIX ${indiaVix?.vix} indicates about market fear/greed>",
  "news_sentiment": "<analysis of recent media headlines>",
  "social_sentiment": "<analysis of social media discussions>",
  "user_sentiment": "${userBias}",
  "active_position_bias": "${activePositionBias}",
  "confidence": <0-100>,
  "summary": "<2-3 sentence multi-source sentiment summary for a trader>"
}

Respond ONLY with valid JSON. No explanation outside JSON.
    `;

    const systemPrompt = 'You are an expert multi-source market sentiment analyst for Indian stock markets. Always respond with valid JSON only.';
    const rawText = await runLLMCompletion({
      systemPrompt,
      prompt,
      maxTokens: 2500,
      temperature: 0.1,
      signal: abortSignal,
    });

    const sentiment = parseLLMJson(rawText);

    console.log(`✅ Multi-Source Sentiment Agent done for ${symbol}:`,
      sentiment.overall_sentiment,
      sentiment.confidence + '%',
      `| PCR: ${finalPCR || 'N/A'} (${pcrSource}) | FII/DII: ${fiiDiiData?.smartMoneyBias || 'N/A'} | VIX: ${indiaVix?.vix} | LTP Source: ${latestLTP?.source || 'N/A'}`
    );

    return {
      symbol,
      put_call_ratio: finalPCR,
      pcr_source: pcrSource,
      advance_decline: advanceDeclineRatio,
      breadth_signal: breadthSignal,
      user_bias: userBias,
      active_position_bias: activePositionBias,
      active_longs: activeLongs.length,
      active_shorts: activeShorts.length,
      active_long_qty: activeLongQty,
      active_short_qty: activeShortQty,
      fear_greed: fearGreed,
      india_vix: indiaVix,
      fii_dii: fiiDiiData,
      news_count: newsHeadlines.length,
      reddit_count: redditPosts.length,
      margin_utilization: marginUtil,
      drawdown_pct: drawdownPct,
      total_buy_orders: totalBuyOrders,
      total_sell_orders: totalSellOrders,
      total_buy_qty: totalBuyQty,
      total_sell_qty: totalSellQty,
      total_buy_value: totalBuyValue,
      total_sell_value: totalSellValue,
      market_breadth: marketBreadth,
      pnl_snapshot: pnlSnapshot,
      sentiment,
      // Phase 3: F&O Institutional Defense Walls
      nse_options: nseOptions,
      call_wall: nseOptions?.callWall || null,
      put_wall: nseOptions?.putWall || null,
      max_pain: nseOptions?.maxPain || null,
      // ΔOI (Change in Open Interest)
      delta_oi: nseOptions?.deltaOI || null,
      zone_pcr: nseOptions?.zonePCR || null,
    };

  } catch (error) {
    console.error('❌ Sentiment Agent error:', error.message);
    return {
      error: error.message,
      symbol,
    };
  }
};