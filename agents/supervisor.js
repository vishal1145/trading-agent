import { sendAlert, runLLMCompletion, parseLLMJson } from '../tools/alerts.js';
import dotenv from 'dotenv';

dotenv.config();

// ─── Signal Strength Calculator ──────────────────────────
const calculateSignalStrength = (marketAnalysis, sentiment, patterns) => {
  let bullishScore = 0;
  let bearishScore = 0;

  // Market Analysis signals
  if (marketAnalysis?.analysis) {
    const a = marketAnalysis.analysis;
    if (a.bias === 'BULLISH') bullishScore += 30;
    if (a.bias === 'BEARISH') bearishScore += 30;
    if (a.trend === 'UPTREND') bullishScore += 20;
    if (a.trend === 'DOWNTREND') bearishScore += 20;
    if (a.rsi?.signal === 'OVERSOLD') bullishScore += 10;
    if (a.rsi?.signal === 'OVERBOUGHT') bearishScore += 10;
    if (a.macd?.trend === 'BULLISH') bullishScore += 10;
    if (a.macd?.trend === 'BEARISH') bearishScore += 10;
    // MTF alignment bonus — all timeframes agreeing = strong conviction
    if (marketAnalysis.mtf_alignment === 'ALL_BULLISH') bullishScore += 20;
    if (marketAnalysis.mtf_alignment === 'ALL_BEARISH') bearishScore += 20;
    if (marketAnalysis.mtf_alignment === 'MOSTLY_BULLISH') bullishScore += 10;
    if (marketAnalysis.mtf_alignment === 'MOSTLY_BEARISH') bearishScore += 10;
  }

  // Sentiment signals
  if (sentiment?.sentiment) {
    const s = sentiment.sentiment;
    if (s.overall_sentiment === 'BULLISH') bullishScore += 20;
    if (s.overall_sentiment === 'BEARISH') bearishScore += 20;
    if (s.smart_money === 'BUYING') bullishScore += 15;
    if (s.smart_money === 'SELLING') bearishScore += 15;
    if (s.pcr_signal === 'BULLISH') bullishScore += 10;
    if (s.pcr_signal === 'BEARISH') bearishScore += 10;
    // Active position bias bonus
    if (sentiment.active_position_bias === 'NET_LONG') bullishScore += 10;
    if (sentiment.active_position_bias === 'NET_SHORT') bearishScore += 10;
    // Fear/Greed contrarian signal
    if (sentiment.fear_greed === 'FEAR') bullishScore += 5;  // contrarian
    if (sentiment.fear_greed === 'GREED') bearishScore += 5;  // contrarian
  }

  // Pattern signals
  if (patterns?.pattern_analysis) {
    const p = patterns.pattern_analysis;
    if (p.pattern_bias === 'BULLISH') bullishScore += 20;
    if (p.pattern_bias === 'BEARISH') bearishScore += 20;
    if (p.breakout_direction === 'UP') bullishScore += 10;
    if (p.breakout_direction === 'DOWN') bearishScore += 10;
  }

  const total = (bullishScore + bearishScore) || 1;
  const netScore = bullishScore - bearishScore;
  const bullishPct = Math.round((bullishScore / total) * 100);
  const bearishPct = Math.round((bearishScore / total) * 100);

  return {
    bullish_score: bullishScore,
    bearish_score: bearishScore,
    bullish_pct: bullishPct,
    bearish_pct: bearishPct,
    net_score: netScore,
    direction: netScore > 20 ? 'BULLISH' :
      netScore < -20 ? 'BEARISH' : 'NEUTRAL',
    strength: Math.abs(netScore) > 50 ? 'STRONG' :
      Math.abs(netScore) > 25 ? 'MODERATE' : 'WEAK',
  };
};

// ─── Supervisor Agent (Claude) ───────────────────────────
export const supervisor = async ({
  symbol,
  timeframe,
  lookbackDays = 30,
  marketAnalysis,
  sentiment,
  patterns,
  abortSignal = null,
}) => {
  try {
    if (abortSignal?.aborted) throw new Error('Analysis aborted by user.');
    console.log(`\n🤖 Supervisor synthesizing agent signals for ${symbol} (${lookbackDays}d lookback)...`);

    // Fast-fail if instrument/company does NOT exist in Snowflake DB
    if (marketAnalysis?.error) {
      console.log(`⚠️ Instrument '${symbol}' not found in Snowflake DB.`);
      return {
        symbol,
        not_found: true,
        error: `Instrument '${symbol}' does not exist in your Snowflake market database.`,
        message: `Hey! The company or product '${symbol}' does not exist in your synced database. Please try searching for a valid instrument (e.g., NIFTY 50, BANKNIFTY, 360ONE, TCS, MARUTI, ONGC).`,
        agents: {
          market: marketAnalysis,
          sentiment,
          pattern: patterns,
        }
      };
    }

    // Calculate signal strength
    const signalStrength = calculateSignalStrength(
      marketAnalysis,
      sentiment,
      patterns
    );

    const currentPrice = marketAnalysis?.currentPrice ||
      marketAnalysis?.candles?.[marketAnalysis?.candles?.length - 1]?.CLOSE ||
      'N/A';

    // Step 2: Prepare comprehensive context for Claude
    const prompt = `
You are the Chief Market Analyst AI for an Indian trading platform (Finvedas).
You have received reports from 3 specialized agents. Your job is to synthesize 
all information and make the FINAL trading signal decision.

═══════════════════════════════════════════════════════
SYMBOL: ${symbol}
TIMEFRAME: ${timeframe}
CURRENT REAL-TIME MARKET PRICE: ₹ ${currentPrice}
TIME: ${new Date().toISOString()}
═══════════════════════════════════════════════════════

⚠️ CRITICAL PRICE ANCHORING RULE:
The CURRENT REAL-TIME LIVE MARKET PRICE for ${symbol} is ₹ ${currentPrice}.
- "entry_price" MUST be near ₹ ${currentPrice}.
- "target_price" MUST be calculated above/below ₹ ${currentPrice}.
- "stop_loss" MUST be placed safely relative to ₹ ${currentPrice}.
DO NOT use stale historical database prices. Anchor all levels strictly to ₹ ${currentPrice}!

📊 MARKET ANALYST REPORT (Multi-Timeframe):
${marketAnalysis?.error ? `ERROR: ${marketAnalysis.error}` : `
- Current Price:    ₹ ${currentPrice}
- MTF Alignment:   ${marketAnalysis?.mtf_alignment} (${marketAnalysis?.bull_tf_count} bull TFs, ${marketAnalysis?.bear_tf_count} bear TFs)
- MTF Analysis:   ${marketAnalysis?.analysis?.mtf_analysis}
- Trend (1hr):    ${marketAnalysis?.analysis?.trend} | Strength: ${marketAnalysis?.analysis?.strength}
- Momentum:       ${marketAnalysis?.analysis?.momentum}
- Bias:           ${marketAnalysis?.analysis?.bias} | Confidence: ${marketAnalysis?.analysis?.confidence}%
- RSI Analysis:   ${marketAnalysis?.analysis?.rsi_analysis}
- MACD Analysis:  ${marketAnalysis?.analysis?.macd_analysis}
- Volume:         ${marketAnalysis?.analysis?.volume_analysis}
- Entry Timing:   ${marketAnalysis?.analysis?.entry_timing}
- Support:        ${marketAnalysis?.analysis?.key_support}
- Resistance:     ${marketAnalysis?.analysis?.key_resistance}
- Summary:        ${marketAnalysis?.analysis?.summary}
`}

🎭 SENTIMENT ANALYST REPORT:
${sentiment?.error ? `ERROR: ${sentiment.error}` : `
- Overall Sentiment:    ${sentiment?.sentiment?.overall_sentiment} | Strength: ${sentiment?.sentiment?.strength}
- PCR:                 ${sentiment?.put_call_ratio} → ${sentiment?.sentiment?.pcr_signal}
- Smart Money:         ${sentiment?.sentiment?.smart_money}
- Active Positions:    ${sentiment?.active_longs || 0} longs (${sentiment?.active_long_qty || 0} qty) vs ${sentiment?.active_shorts || 0} shorts (${sentiment?.active_short_qty || 0} qty) → ${sentiment?.active_position_bias}
- Fear/Greed:          ${sentiment?.fear_greed} | Drawdown: ${sentiment?.drawdown_pct?.toFixed(2)}% | Margin Used: ${sentiment?.margin_utilization}%
- User Bias (24h):     ${sentiment?.user_bias} (${sentiment?.total_buy_orders || 0} buys vs ${sentiment?.total_sell_orders || 0} sells)
- Market Breadth:      ${sentiment?.breadth_signal}
- Confidence:          ${sentiment?.sentiment?.confidence}%
- Summary:             ${sentiment?.sentiment?.summary}
`}

🔍 PATTERN ANALYST REPORT:
${patterns?.error ? `ERROR: ${patterns.error}` : `
- Pattern Bias: ${patterns?.pattern_analysis?.pattern_bias}
- Patterns Found: ${patterns?.patterns_found} (${patterns?.bullish_count} bullish, ${patterns?.bearish_count} bearish)
- Breakout Direction: ${patterns?.pattern_analysis?.breakout_direction}
- Breakout Probability: ${patterns?.pattern_analysis?.breakout_probability}%
- Price Target: ${patterns?.pattern_analysis?.price_target}
- Stop Loss: ${patterns?.pattern_analysis?.stop_loss}
- Key Level: ${patterns?.pattern_analysis?.key_level_to_watch}
- Confidence: ${patterns?.pattern_analysis?.confidence}%
- Summary: ${patterns?.pattern_analysis?.pattern_summary}
`}

📈 SIGNAL STRENGTH CALCULATION:
- Bullish Score: ${signalStrength.bullish_score}
- Bearish Score: ${signalStrength.bearish_score}
- Net Score: ${signalStrength.net_score}
- Direction: ${signalStrength.direction}
- Strength: ${signalStrength.strength}

═══════════════════════════════════════════════════════

As the Chief Analyst, synthesize ALL the above information and provide 
the FINAL trading signal. Consider:
1. Where do multiple agents agree? (confluence = stronger signal)
2. Where do they disagree? (conflicting signals = lower confidence)
3. What is the overall risk/reward?
4. What should a trader DO right now?

Respond in this EXACT JSON format:
{
  "symbol": "${symbol}",
  "timeframe": "${timeframe}",
  "timestamp": "${new Date().toISOString()}",
  "final_signal": "BUY|SELL|HOLD",
  "direction": "BULLISH|BEARISH|NEUTRAL",
  "confidence": <0-100>,
  "strength": "STRONG|MODERATE|WEAK",
  "entry_price": <number or null>,
  "target_price": <number or null>,
  "stop_loss": <number or null>,
  "risk_reward": <number or null>,
  "timeframe_to_play": "<e.g. 1-2 hours, intraday, swing>",
  "hold_until": "<specific human-readable time estimate to hold the trade, e.g. '3:15 PM IST (End of Day)', 'Within 2-3 hours', '1-2 trading sessions', 'Until next resistance at ₹720'>",
  "max_hold_duration_minutes": <integer: estimated minutes to hold before reassessing, e.g. 60 for 1hr trade, 390 for full day>,
  "confluence_factors": [
    "<factor 1 where agents agree>",
    "<factor 2 where agents agree>"
  ],
  "conflicting_factors": [
    "<factor where agents disagree>"
  ],
  "key_risks": [
    "<risk 1>",
    "<risk 2>"
  ],
  "market_analysis_weight": <0-100>,
  "sentiment_weight": <0-100>,
  "pattern_weight": <0-100>,
  "agent_agreement": "HIGH|MEDIUM|LOW",
  "action": "<clear 1 sentence action for trader>",
  "reasoning": "<3-4 sentence explanation of final decision>",
  "disclaimer": "This is AI analysis for educational purposes only. Not financial advice."
}

Respond ONLY with valid JSON. No explanation outside JSON.
    `;

    // Step 3: Ask LLM (Anthropic Claude priority, Gemini fallback, Groq tertiary) for final decision
    const systemPrompt = `You are the Chief Market Analyst AI for Finvedas, an Indian trading platform. 
You synthesize reports from multiple AI agents and make final trading signal decisions.
You are analytical, precise, and always consider risk management.
Always respond with valid JSON only.
Always include disclaimer that this is not financial advice.`;

    const rawText = await runLLMCompletion({
      systemPrompt,
      prompt,
      maxTokens: 2500,
      temperature: 0.1,
      signal: abortSignal,
    });

    const finalSignal = parseLLMJson(rawText);

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🎯 FINAL SIGNAL for ${symbol}:`);
    console.log(`   Signal:     ${finalSignal.final_signal}`);
    console.log(`   Direction:  ${finalSignal.direction}`);
    console.log(`   Confidence: ${finalSignal.confidence}%`);
    console.log(`   Strength:   ${finalSignal.strength}`);
    console.log(`   Action:     ${finalSignal.action}`);
    console.log(`${'═'.repeat(50)}\n`);

    // Step 5: Send alert if strong signal
    if (
      finalSignal.confidence >= 70 &&
      finalSignal.strength === 'STRONG' &&
      finalSignal.final_signal !== 'HOLD'
    ) {
      await sendAlert({
        symbol,
        signal: finalSignal.final_signal,
        direction: finalSignal.direction,
        confidence: finalSignal.confidence,
        entry: finalSignal.entry_price,
        target: finalSignal.target_price,
        stopLoss: finalSignal.stop_loss,
        action: finalSignal.action,
        reasoning: finalSignal.reasoning,
      });
    }

    // Use anchored current live price
    const livePriceNum = Number(currentPrice) || Number(marketAnalysis?.indicators?.['1_hour']?.current_price) || Number(marketAnalysis?.last_candle?.close) || null;
    const support = marketAnalysis?.analysis?.key_support || marketAnalysis?.indicators?.['1_hour']?.support_resistance?.support;
    const resistance = marketAnalysis?.analysis?.key_resistance || marketAnalysis?.indicators?.['1_hour']?.support_resistance?.resistance;

    // Fallback logic to ensure prices and targets are ALWAYS numeric and NEVER N/A
    const parseNum = (val) => {
      if (!val || val === 'N/A' || isNaN(Number(val))) return null;
      return Number(val);
    };

    const entryPrice = parseNum(finalSignal.entry_price) || parseNum(currentPrice);
    let targetPrice = parseNum(finalSignal.target_price);
    let stopLoss = parseNum(finalSignal.stop_loss);

    const supNum = parseNum(support);
    const resNum = parseNum(resistance);

    if (!targetPrice && currentPrice) {
      if (finalSignal.direction === 'BULLISH' || finalSignal.final_signal === 'BUY') {
        targetPrice = resNum && resNum > currentPrice ? resNum : Number((currentPrice * 1.015).toFixed(2));
      } else if (finalSignal.direction === 'BEARISH' || finalSignal.final_signal === 'SELL') {
        targetPrice = supNum && supNum < currentPrice ? supNum : Number((currentPrice * 0.985).toFixed(2));
      } else {
        // HOLD / NEUTRAL: Use Resistance as breakout target or 1% gain
        targetPrice = resNum || Number((currentPrice * 1.01).toFixed(2));
      }
    }

    if (!stopLoss && currentPrice) {
      if (finalSignal.direction === 'BULLISH' || finalSignal.final_signal === 'BUY') {
        stopLoss = supNum || Number((currentPrice * 0.992).toFixed(2));
      } else if (finalSignal.direction === 'BEARISH' || finalSignal.final_signal === 'SELL') {
        stopLoss = resNum || Number((currentPrice * 1.008).toFixed(2));
      } else {
        stopLoss = supNum || Number((currentPrice * 0.99).toFixed(2));
      }
    }

    // ── Compute profit / risk metrics (arithmetic, no LLM needed) ──────────
    const profitAbs = (targetPrice && entryPrice) ? Number((targetPrice - entryPrice).toFixed(2)) : null;
    const riskAbs = (entryPrice && stopLoss) ? Number((entryPrice - stopLoss).toFixed(2)) : null;
    const profitPct = (profitAbs !== null && entryPrice) ? Number(((profitAbs / entryPrice) * 100).toFixed(2)) : null;
    const riskPct = (riskAbs !== null && entryPrice) ? Number(((Math.abs(riskAbs) / entryPrice) * 100).toFixed(2)) : null;
    const rrRatio = (profitAbs !== null && riskAbs && riskAbs > 0) ? Number((profitAbs / riskAbs).toFixed(2)) : null;

    // Fallback for hold_until if LLM didn't return it
    const holdUntil = finalSignal.hold_until || finalSignal.timeframe_to_play || null;
    const holdMins = finalSignal.max_hold_duration_minutes || null;

    return {
      ...finalSignal,
      current_price: currentPrice,
      entry_price: entryPrice,
      target_price: targetPrice,
      stop_loss: stopLoss,
      signal_strength: signalStrength,
      // ── New: Hold & Profit fields ──────────────────────────────
      hold_until: holdUntil,
      max_hold_duration_minutes: holdMins,
      profit_abs: profitAbs,
      profit_potential_pct: profitPct,
      risk_abs: riskAbs ? Math.abs(riskAbs) : null,
      risk_pct: riskPct,
      risk_reward_computed: rrRatio,
    };

  } catch (error) {
    console.error('❌ Supervisor error:', error.message);
    return {
      error: error.message,
      symbol,
      final_signal: 'HOLD',
      direction: 'NEUTRAL',
      confidence: 0,
      reasoning: 'Error in analysis pipeline',
    };
  }
};