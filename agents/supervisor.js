import { sendAlert, runLLMCompletion, parseLLMJson } from '../tools/alerts.js';
import { getUserTradingProfiles, getInstrumentChampionTrader } from '../tools/finvedasDB.js';
import dotenv from 'dotenv';

dotenv.config();

// ─── Signal Strength Calculator (Regime-Aware Dynamic Weighting) ──
const calculateSignalStrength = (marketAnalysis, sentiment, patterns, regime = null) => {
  let bullishScore = 0;
  let bearishScore = 0;

  const primaryRegime = regime?.primary_regime || 'TRANSITIONAL';
  const weights = regime?.weights || {
    ema_vwap: 0.15,
    macd: 0.12,
    camarilla_breakout: 0.10,
    cpr_camarilla_fade: 0.15,
    bollinger_edges: 0.10,
    mfi_divergences: 0.18,
    oi_walls: 0.15,
    volume: 0.05,
  };

  // Find primary timeframe indicators
  const indicatorsMap = marketAnalysis?.indicators || {};
  const primaryInd = indicatorsMap['1_hour'] || indicatorsMap['15_minute'] || Object.values(indicatorsMap)[0] || null;
  const currentPrice = Number(marketAnalysis?.currentPrice || primaryInd?.current_price || 0);

  // ── 1. EMA Cloud / VWAP Bias (Weight: 25% Trend, 5% Range, 10% Breakout) ──
  const emaWeight = Math.round(weights.ema_vwap * 100);
  if (primaryInd) {
    if (primaryInd.trend === 'UPTREND' || primaryInd.vwap_bands?.bias === 'ABOVE_VWAP') {
      bullishScore += emaWeight;
    } else if (primaryInd.trend === 'DOWNTREND' || primaryInd.vwap_bands?.bias === 'BELOW_VWAP') {
      bearishScore += emaWeight;
    }
  } else if (marketAnalysis?.analysis) {
    if (marketAnalysis.analysis.trend === 'UPTREND') bullishScore += emaWeight;
    if (marketAnalysis.analysis.trend === 'DOWNTREND') bearishScore += emaWeight;
  }

  // ── 2. MACD Signal (Weight: 20% Trend, 5% Range, 15% Breakout) ─────────────
  const macdWeight = Math.round(weights.macd * 100);
  const macdData = primaryInd?.macd || marketAnalysis?.analysis?.macd;
  if (macdData) {
    if (macdData.trend === 'BULLISH' || (macdData.histogram && macdData.histogram > 0)) {
      bullishScore += macdWeight;
    } else if (macdData.trend === 'BEARISH' || (macdData.histogram && macdData.histogram < 0)) {
      bearishScore += macdWeight;
    }
  }

  // ── 3. Camarilla H4/L4 Breakout (Weight: 15% Trend, 0% Range, 30% Breakout) ─
  const breakoutWeight = Math.round(weights.camarilla_breakout * 100);
  if (breakoutWeight > 0 && primaryInd?.pivot_levels && currentPrice > 0) {
    const pl = primaryInd.pivot_levels;
    if (currentPrice >= pl.H4 * 0.998) bullishScore += breakoutWeight;
    else if (currentPrice <= pl.L4 * 1.002) bearishScore += breakoutWeight;
  }

  // ── 4. CPR / Camarilla H3/L3 Fade (Weight: 0% Trend, 25% Range, 5% Breakout) 
  const fadeWeight = Math.round(weights.cpr_camarilla_fade * 100);
  if (fadeWeight > 0 && primaryInd?.pivot_levels && currentPrice > 0) {
    const pl = primaryInd.pivot_levels;
    const range = pl.H3 - pl.L3;
    // In Ranging: bounce off L3 support floor = Bullish; fade off H3 ceiling = Bearish
    if (range > 0) {
      if (Math.abs(currentPrice - pl.L3) <= range * 0.25 || currentPrice <= pl.L3) bullishScore += fadeWeight;
      else if (Math.abs(currentPrice - pl.H3) <= range * 0.25 || currentPrice >= pl.H3) bearishScore += fadeWeight;
    }
  }

  // ── 5. Bollinger Band Edges (Weight: 0% Trend, 20% Range, 20% Breakout) ───
  const bbWeight = Math.round(weights.bollinger_edges * 100);
  if (bbWeight > 0 && primaryInd?.bollinger) {
    const bb = primaryInd.bollinger;
    if (primaryRegime === 'RANGING') {
      if (bb.signal === 'OVERSOLD' || (currentPrice > 0 && currentPrice <= bb.lower * 1.002)) bullishScore += bbWeight;
      else if (bb.signal === 'OVERBOUGHT' || (currentPrice > 0 && currentPrice >= bb.upper * 0.998)) bearishScore += bbWeight;
    } else if (primaryRegime === 'BREAKOUT_IMMINENT') {
      if (primaryInd.bollinger_squeeze?.is_squeeze) {
        if (primaryInd.trend === 'UPTREND' || primaryInd.vwap_bands?.bias === 'ABOVE_VWAP') bullishScore += bbWeight;
        else if (primaryInd.trend === 'DOWNTREND' || primaryInd.vwap_bands?.bias === 'BELOW_VWAP') bearishScore += bbWeight;
      }
    }
  }

  // ── 6. MFI / Divergences (Weight: 15% Trend, 20% Range, 10% Breakout) ──────
  const mfiWeight = Math.round(weights.mfi_divergences * 100);
  if (mfiWeight > 0) {
    if (primaryInd?.mfi) {
      if (primaryInd.mfi.signal === 'ACCUMULATION' || primaryInd.mfi.value > 60) bullishScore += Math.round(mfiWeight * 0.5);
      else if (primaryInd.mfi.signal === 'DISTRIBUTION' || primaryInd.mfi.value < 40) bearishScore += Math.round(mfiWeight * 0.5);
    }
    if (primaryInd?.divergences?.divergences?.length > 0) {
      if (primaryInd.divergences.bias === 'BULLISH_DIVERGENCE_ACTIVE') bullishScore += Math.round(mfiWeight * 0.5);
      else if (primaryInd.divergences.bias === 'BEARISH_DIVERGENCE_ACTIVE') bearishScore += Math.round(mfiWeight * 0.5);
    }
  }

  // ── 7. OI Call/Put Wall & ΔOI (Weight: 10% Trend, 20% Range, 10% Breakout) ─
  const wallsWeight = Math.round(weights.oi_walls * 100);
  const doi = sentiment?.delta_oi || sentiment?.nse_options?.deltaOI;
  if (doi) {
    if (doi.signal === 'SHORT_COVERING' || doi.signal === 'FRESH_PUT_BUILDUP' || doi.signal === 'FRESH_LONG_BUILDUP') {
      bullishScore += wallsWeight;
    } else if (doi.signal === 'LONG_LIQUIDATION' || doi.signal === 'FRESH_CALL_WRITING' || doi.signal === 'FRESH_SHORT_BUILDUP') {
      bearishScore += wallsWeight;
    }
  }
  const zp = sentiment?.zone_pcr || sentiment?.nse_options?.zonePCR;
  if (zp) {
    if (zp.signal === 'STRONG_SUPPORT_FLOOR' || zp.signal === 'SUPPORT_ACTIVE') bullishScore += 10;
    else if (zp.signal === 'STRONG_RESISTANCE_CEILING' || zp.signal === 'HEAVY_CALL_CEILING') bearishScore += 10;
  }

  // ── 8. Volume Confirmation (Weight: 15% Trend, 5% Range, 0% Breakout) ──────
  const volWeight = Math.round(weights.volume * 100);
  if (volWeight > 0 && primaryInd?.volume?.surge) {
    if (primaryInd.trend === 'UPTREND') bullishScore += volWeight;
    else if (primaryInd.trend === 'DOWNTREND') bearishScore += volWeight;
  }

  // ── 9. RSI Regime-Aware Rule (Root Cause Fix) ──────────────────────────────
  // In TRENDING markets: Do NOT fade overbought/oversold! Strong trends stay overbought.
  // In RANGING markets: Overbought/oversold are high-probability reversal boundaries.
  const rsiVal = primaryInd?.rsi?.value ?? marketAnalysis?.analysis?.rsi?.value;
  if (primaryRegime === 'RANGING') {
    if (primaryInd?.rsi?.signal === 'OVERSOLD' || rsiVal < 30) bullishScore += 15;
    else if (primaryInd?.rsi?.signal === 'OVERBOUGHT' || rsiVal > 70) bearishScore += 15;
  } else if (primaryRegime === 'TRENDING') {
    // In trends, RSI > 55 confirms trend strength, not reversal!
    if (rsiVal > 60) bullishScore += 10;
    else if (rsiVal < 40) bearishScore += 10;
  }

  // ── 10. Multi-Timeframe Alignment Bonus ────────────────────────────────────
  if (marketAnalysis?.mtf_alignment === 'ALL_BULLISH') bullishScore += 20;
  if (marketAnalysis?.mtf_alignment === 'ALL_BEARISH') bearishScore += 20;
  if (marketAnalysis?.mtf_alignment === 'MOSTLY_BULLISH') bullishScore += 10;
  if (marketAnalysis?.mtf_alignment === 'MOSTLY_BEARISH') bearishScore += 10;

  // ── 11. Sentiment Agent Signals ───────────────────────────────────────────
  if (sentiment?.sentiment) {
    const s = sentiment.sentiment;
    if (s.overall_sentiment === 'BULLISH') bullishScore += 15;
    if (s.overall_sentiment === 'BEARISH') bearishScore += 15;
    if (s.smart_money === 'BUYING') bullishScore += 10;
    if (s.smart_money === 'SELLING') bearishScore += 10;
    if (sentiment.active_position_bias === 'NET_LONG') bullishScore += 10;
    if (sentiment.active_position_bias === 'NET_SHORT') bearishScore += 10;
  }

  // ── 12. Pattern Agent Signals ─────────────────────────────────────────────
  if (patterns?.pattern_analysis) {
    const p = patterns.pattern_analysis;
    // In ranging chop, suppress breakout calls unless breakout probability is high
    if (primaryRegime === 'RANGING') {
      if (p.pattern_bias === 'BULLISH' && p.breakout_probability > 75) bullishScore += 10;
      if (p.pattern_bias === 'BEARISH' && p.breakout_probability > 75) bearishScore += 10;
    } else {
      if (p.pattern_bias === 'BULLISH') bullishScore += 15;
      if (p.pattern_bias === 'BEARISH') bearishScore += 15;
      if (p.breakout_direction === 'UP') bullishScore += 10;
      if (p.breakout_direction === 'DOWN') bearishScore += 10;
    }
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
    direction: netScore > 15 ? 'BULLISH' :
      netScore < -15 ? 'BEARISH' : 'NEUTRAL',
    strength: Math.abs(netScore) > 40 ? 'STRONG' :
      Math.abs(netScore) > 20 ? 'MODERATE' : 'WEAK',
    regime_applied: primaryRegime,
    weights_applied: weights,
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

    let behaviourContext = '';
    let championTrader = null;
    try {
      championTrader = await getInstrumentChampionTrader(symbol);
      if (championTrader) {
        if (championTrader.is_instrument_specific) {
          console.log(`👑 [Champion Playbook] Active Instrument Champion for '${symbol}': ${championTrader.trader_name} (Win Rate: ${championTrader.win_rate_pct}%, Trades: ${championTrader.total_trades}, Net PnL: ₹${championTrader.total_pnl.toLocaleString('en-IN')}, Avg Hold: ${championTrader.avg_hold_mins}m)`);
        } else {
          console.log(`👑 [Champion Playbook] No specific champion for '${symbol}' — using Platform Fallback: ${championTrader.trader_name} [${championTrader.favourite_instrument}] (Win Rate: ${championTrader.win_rate_pct}%, Net PnL: ₹${championTrader.total_pnl.toLocaleString('en-IN')})`);
        }
      } else {
        console.log(`ℹ️ [Champion Playbook] No champion trader found for '${symbol}'`);
      }

      const userProfiles = await getUserTradingProfiles();
      const topTraders = (userProfiles || [])
        .filter(u => u.TOTAL_TRADE_PNL > 0 && u.TOTAL_TRADES >= 5)
        .slice(0, 5);

      let championSection = '';
      if (championTrader) {
        if (championTrader.is_instrument_specific) {
          championSection = `
👑 #1 INSTRUMENT CHAMPION TRADER PLAYBOOK FOR ${symbol.toUpperCase()} (CLONE THIS TRADER'S STYLE):
- Top Trader Name: ${championTrader.trader_name}
- Proven Performance on ${symbol}: Net PNL ₹${championTrader.total_pnl.toLocaleString('en-IN')} across ${championTrader.total_trades} trades | Win Rate: ${championTrader.win_rate_pct}%
- Proven Avg Hold Time: ~${championTrader.avg_hold_mins} minutes
- Typical Entry Timing: Around ${championTrader.best_entry_hour_ist}:00 IST
- Realized Risk-Reward: Avg Win ₹${championTrader.avg_win_pnl} vs Avg Loss ₹${championTrader.avg_loss_pnl} (Realized R:R 1:${championTrader.risk_reward_ratio || '1.5+'})
- Preferred Product Type: ${championTrader.preferred_product_type}

🎯 AI CLONING DIRECTIVES FOR ${symbol.toUpperCase()}:
1. HOLD TIME: Set 'max_hold_duration_minutes' and 'hold_until' close to ~${championTrader.avg_hold_mins} mins (this exact duration produced ₹${championTrader.total_pnl} profit specifically on ${symbol}).
2. RISK/REWARD: Anchor entry, target, and stop loss to achieve at least 1:${championTrader.risk_reward_ratio || '1.5'} reward-to-risk.
3. PRODUCT TYPE: Recommend ${championTrader.preferred_product_type} execution.
`;
        } else {
          championSection = `
👑 #1 PLATFORM CHAMPION TRADER PLAYBOOK (No high-volume trader on ${symbol.toUpperCase()} yet — Learn General Discipline from Platform Leader):
- Platform Champion: ${championTrader.trader_name} (Top Instrument: ${championTrader.favourite_instrument || 'N/A'})
- Proven Performance: Net PNL ₹${championTrader.total_pnl.toLocaleString('en-IN')} across ${championTrader.total_trades} trades | Win Rate: ${championTrader.win_rate_pct}%
- Realized Risk-Reward: Avg Win ₹${championTrader.avg_win_pnl} vs Avg Loss ₹${championTrader.avg_loss_pnl} (Realized R:R 1:${championTrader.risk_reward_ratio || '1.5+'})

🎯 AI CLONING DIRECTIVES FOR ${symbol.toUpperCase()}:
1. RISK/REWARD: Emulate ${championTrader.trader_name}'s strict profit-to-loss discipline (target at least 1:${championTrader.risk_reward_ratio || '1.5'} R:R ratio).
2. HOLD TIME CAUTION: DO NOT copy ${championTrader.trader_name}'s holding duration (they trade ${championTrader.favourite_instrument}, not ${symbol.toUpperCase()}). Instead, determine 'max_hold_duration_minutes' and 'hold_until' strictly based on ${symbol.toUpperCase()}'s real-time ATR volatility, Camarilla levels, and selected timeframe!
3. PRODUCT TYPE: Recommend intraday MIS or CNC based on the technical setup of ${symbol.toUpperCase()}, do not force Futures/Options.
`;
        }
      }

      let topTradersSection = '';
      if (topTraders.length > 0) {
        topTradersSection = `
🏆 TOP 5 PLATFORM WINNERS BENCHMARK:
${topTraders.map((u, i) => `  Trader #${i + 1}: ${u.FULL_NAME} | Trades: ${u.TOTAL_TRADES} | Win Rate: ${u.WIN_RATE_PCT}% | Net PNL: ₹${u.NET_PNL_AFTER_CHARGES} | Avg Hold: ${u.AVG_HOLD_MINS?.toFixed(1)}m | Fav: ${u.FAVOURITE_INSTRUMENT}`).join('\n')}
`;
      }

      behaviourContext = `${championSection}\n${topTradersSection}`;
    } catch (err) {
      console.warn('⚠️ Could not load user behaviour context:', err.message);
    }

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

    const currentPrice = marketAnalysis?.currentPrice ||
      marketAnalysis?.candles?.[marketAnalysis?.candles?.length - 1]?.CLOSE ||
      'N/A';

    // Extract ATR volatility metrics and Market Regime from primary timeframe
    const primaryTf = timeframe || '1_hour';
    const primaryInd = marketAnalysis?.indicators?.[primaryTf] || marketAnalysis?.indicators?.['1_hour'] || Object.values(marketAnalysis?.indicators || {})[0];
    const marketRegime = primaryInd?.market_regime || marketAnalysis?.market_regime || null;
    const timeFilter = marketRegime?.time_of_day || null;

    // Calculate signal strength using dynamic regime weight table
    const signalStrength = calculateSignalStrength(
      marketAnalysis,
      sentiment,
      patterns,
      marketRegime
    );

    const atrInfo = primaryInd?.atr || null;
    const numPrice = typeof currentPrice === 'number' ? currentPrice : parseFloat(currentPrice) || 100;
    const atrVal = atrInfo?.value || Number((numPrice * 0.008).toFixed(2));
    const suggestedStopDist = atrInfo?.stop_distance || Number((atrVal * 1.5).toFixed(2));
    const suggestedTargetDist = atrInfo?.target_conservative || Number((atrVal * 2.0).toFixed(2));

    // Phase 3: Extract institutional indicators
    const pivotLevels = primaryInd?.pivot_levels || null;
    const vwapBands = primaryInd?.vwap_bands || null;
    const mfiData = primaryInd?.mfi || null;
    const divergenceData = primaryInd?.divergences || null;
    const institutionalLevels = primaryInd?.institutional_levels || null;

    // Phase 3: Extract F&O Option Chain walls & ΔOI from sentiment agent
    const nseOI = sentiment?.nse_options || null;
    const callWall = sentiment?.call_wall || nseOI?.callWall || null;
    const putWall = sentiment?.put_wall || nseOI?.putWall || null;
    const maxPain = sentiment?.max_pain || nseOI?.maxPain || null;
    const deltaOI = sentiment?.delta_oi || nseOI?.deltaOI || null;
    const zonePCR = sentiment?.zone_pcr || nseOI?.zonePCR || null;

    // Phase 3: Compute institutional confluence S/R
    // Support = max(Camarilla L3, Put Wall, Fastest Put Writing strike, VWAP Lower Band 1)
    // Resistance = min(Camarilla H3, Call Wall, Fastest Call Writing strike, VWAP Upper Band 1)
    const instSupportCandidates = [
      institutionalLevels?.primary_support,
      putWall,
      (deltaOI?.fastestPutWriting?.strike && currentPrice && deltaOI.fastestPutWriting.strike <= currentPrice) ? deltaOI.fastestPutWriting.strike : null,
      vwapBands?.lower_1,
    ].filter(v => v && !isNaN(v));

    const instResistanceCandidates = [
      institutionalLevels?.primary_resistance,
      callWall,
      (deltaOI?.fastestCallWriting?.strike && currentPrice && deltaOI.fastestCallWriting.strike >= currentPrice) ? deltaOI.fastestCallWriting.strike : null,
      vwapBands?.upper_1,
    ].filter(v => v && !isNaN(v));

    const instSupport = instSupportCandidates.length > 0 ? Math.max(...instSupportCandidates) : null;
    const instResistance = instResistanceCandidates.length > 0 ? Math.min(...instResistanceCandidates) : null;

    // Step 2: Prepare comprehensive context for Chief Analyst AI
    const prompt = `
You are the Chief Market Analyst AI for an Indian trading platform (Finvedas).
You have received reports from 3 specialized agents. Your job is to synthesize 
all information and make the FINAL trading signal decision.

═══════════════════════════════════════════════════════
SYMBOL: ${symbol}
TIMEFRAME: ${timeframe}
CURRENT REAL-TIME MARKET PRICE: ₹ ${currentPrice}
14-PERIOD ATR VOLATILITY: ₹ ${atrVal} (${atrInfo?.pct || '0.8'}% of price | ${atrInfo?.volatility_category || 'NORMAL'} Volatility)
TIME: ${new Date().toISOString()}
═══════════════════════════════════════════════════════

⚠️ CRITICAL ATR VOLATILITY & PRICE ANCHORING RULES:
The CURRENT REAL-TIME LIVE MARKET PRICE for ${symbol} is ₹ ${currentPrice}.
- FOR "BUY" OR "SELL" SIGNALS:
  * "entry_price" MUST be near ₹ ${currentPrice}.
  * "stop_loss" MUST be set approx. 1.2x to 1.5x ATR away from entry (minimum ₹ ${suggestedStopDist} buffer) so random noise wicks do NOT trigger premature stop-outs. For BUY: stop_loss < entry. For SELL: stop_loss > entry.
  * "target_price" MUST be set at 1.5x to 2.5x ATR away (minimum ₹ ${suggestedTargetDist} profit potential) to guarantee at least 1:1.5 Risk-to-Reward ratio. For BUY: target_price > entry. For SELL: target_price < entry.
  * NEVER set stop-loss inside the normal candle noise zone! Anchor all levels strictly to ₹ ${currentPrice}!
- FOR "HOLD" SIGNALS:
  * Do NOT provide trade entry, target, or stop loss. Set "entry_price", "target_price", "stop_loss", and "risk_reward" strictly to null.
  * In "action" and "reasoning", clearly explain why the trader should remain on the sidelines (e.g. choppy/ranging market, conflicting indicators) and specify what breakout level or condition to wait for before entering.
  * Set "hold_until" to the specific condition or time to wait (e.g. 'Wait for breakout past ₹X or ~30 mins').

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

🏛️ INSTITUTIONAL INDICATORS (Phase 3 — High-Conviction Edge):
${pivotLevels ? `
📊 SESSION VWAP BANDS:
- VWAP: ₹${vwapBands?.vwap || 'N/A'} | +1σ: ₹${vwapBands?.upper_1 || 'N/A'} | -1σ: ₹${vwapBands?.lower_1 || 'N/A'} | +2σ: ₹${vwapBands?.upper_2 || 'N/A'} | -2σ: ₹${vwapBands?.lower_2 || 'N/A'}
- VWAP Bias: ${vwapBands?.bias || 'N/A'}

🏛️ CPR (Central Pivot Range):
- Pivot: ₹${pivotLevels.pivot} | TC: ₹${pivotLevels.TC} | BC: ₹${pivotLevels.BC}
- CPR Width: ${pivotLevels.cpr_width_pct}% → ${pivotLevels.cpr_type}
- Today's Position: ${pivotLevels.cpr_position}
- NARROW CPR = Expect strong directional trend day. WIDE CPR = Expect range-bound sideways.

🎯 CAMARILLA PIVOTS:
- H4: ₹${pivotLevels.H4} (Breakout Long trigger — if price breaks above, go LONG aggressively)
- H3: ₹${pivotLevels.H3} (Institutional Resistance — expect reversal/fade SHORT here)
- L3: ₹${pivotLevels.L3} (Institutional Support — expect bounce/fade LONG here)
- L4: ₹${pivotLevels.L4} (Breakdown Short trigger — if price breaks below, go SHORT aggressively)

📍 PREVIOUS DAY HIGH/LOW:
- PDH: ₹${pivotLevels.PDH} (Sweep: ${pivotLevels.pdh_sweep}) | PDL: ₹${pivotLevels.PDL} (Sweep: ${pivotLevels.pdl_sweep})
- BULL_TRAP = PDH swept then price fell back (bearish). BEAR_TRAP = PDL swept then price bounced (bullish).
` : '- Pivot levels not available (insufficient multi-day data)'}
${mfiData ? `
💰 MFI (Money Flow Index — Smart Money):
- MFI: ${mfiData.value} → ${mfiData.signal}
- ACCUMULATION (MFI>60) = Smart money buying. DISTRIBUTION (MFI<40) = Smart money selling.
` : ''}
${divergenceData && divergenceData.divergences?.length > 0 ? `
⚡ DIVERGENCE ALERTS (MACD + MFI):
- ${divergenceData.summary}
- Bias: ${divergenceData.bias}
${divergenceData.divergences.slice(0, 5).map(d => `  → ${d.type} (${d.strength}): ${d.description}`).join('\n')}
- BULLISH DIVERGENCE = Trend exhaustion, expect reversal UP. BEARISH DIVERGENCE = Trend exhaustion, expect reversal DOWN.
` : '- No active divergences detected'}
${callWall || putWall || maxPain || deltaOI ? `
🛡️ F&O OPTION CHAIN & ΔOI DEFENSE WALLS:
- Call Wall (Max Call OI): ₹${callWall || 'N/A'} → Major RESISTANCE ceiling (institutions defend this)
- Put Wall (Max Put OI): ₹${putWall || 'N/A'} → Major SUPPORT floor (institutions defend this)
- Max Pain Strike: ₹${maxPain || 'N/A'} → Market gravitates toward this price
${deltaOI ? `
⚡ REAL-TIME ΔOI (CHANGE IN OPEN INTEREST — Live Institutional Shifts):
- ΔOI Signal: ${deltaOI.signal} (${deltaOI.description})
- Call ΔOI: ${deltaOI.totalCallDelta > 0 ? '+' : ''}${deltaOI.totalCallDelta?.toLocaleString() || '0'} | Put ΔOI: ${deltaOI.totalPutDelta > 0 ? '+' : ''}${deltaOI.totalPutDelta?.toLocaleString() || '0'}
- Top Institutional Defense Strikes: ${deltaOI.topBuildups?.slice(0, 3).map(b => `₹${b.strike} [Call Δ: ${b.call_delta > 0 ? '+' : ''}${b.call_delta}, Put Δ: ${b.put_delta > 0 ? '+' : ''}${b.put_delta} → ${b.activity}]`).join(', ') || 'N/A'}
- Fastest Call Writing: ₹${deltaOI.fastestCallWriting?.strike || 'N/A'} (+${deltaOI.fastestCallWriting?.delta?.toLocaleString() || 0} OI)
- Fastest Put Writing: ₹${deltaOI.fastestPutWriting?.strike || 'N/A'} (+${deltaOI.fastestPutWriting?.delta?.toLocaleString() || 0} OI)
` : ''}
${zonePCR ? `
🎯 ZONE-SPECIFIC PCR (Market Pinned Range):
- Ceiling PCR (Above Spot): ${zonePCR.ceilingPCR ?? 'N/A'} (Pressure from Call writers above)
- Floor PCR (Below Spot): ${zonePCR.floorPCR ?? 'N/A'} (Support from Put writers below)
- Zone Signal: ${zonePCR.signal}
` : ''}
` : '- Option chain walls and ΔOI not available'}
${instSupport || instResistance ? `
🏦 INSTITUTIONAL CONFLUENCE LEVELS:
- Confluence Support: ₹${instSupport || 'N/A'} = max(Camarilla L3, Put Wall, VWAP Lower Band)
- Confluence Resistance: ₹${instResistance || 'N/A'} = min(Camarilla H3, Call Wall, VWAP Upper Band)
- These are the STRONGEST levels — prefer them over naive S/R from 20-candle max/min.
` : ''}

${marketRegime ? `
🧭 MARKET REGIME DETECTION (Phase 4 — Institutional Filter):
- Active Regime:        ${marketRegime.primary_regime} (${marketRegime.trend_direction})
- ADX(14):              ${marketRegime.adx?.value ?? 'N/A'} (Slope: ${marketRegime.adx?.slope ?? 'FLAT'} | +DI: ${marketRegime.adx?.plus_di ?? 'N/A'} | -DI: ${marketRegime.adx?.minus_di ?? 'N/A'})
- CPR Dual Confirmation: ${marketRegime.cpr_dual_confirmation}
- ATR Volatility Sizing: ${marketRegime.atr_volatility_cross}
- Time Window (IST):    ${timeFilter?.label || 'N/A'} → ${timeFilter?.action || 'N/A'}
${timeFilter?.block_signals ? '⚠️ TIME FILTER ADVISORY: High volatility / false move zone. Advise extreme caution or HOLD.\n' : ''}- Regime Directive:     ${marketRegime.guidance}
` : ''}

🎭 SENTIMENT ANALYST REPORT:
${sentiment?.error ? `ERROR: ${sentiment.error}` : `
- Overall Sentiment:    ${sentiment?.sentiment?.overall_sentiment} | Strength: ${sentiment?.sentiment?.strength}
- PCR:                 ${sentiment?.put_call_ratio} → ${sentiment?.sentiment?.pcr_signal}
- Smart Money:         ${sentiment?.sentiment?.smart_money}
- Active Positions:    ${sentiment?.active_longs || 0} longs (${sentiment?.active_long_qty || 0} qty) vs ${sentiment?.active_shorts || 0} shorts (${sentiment?.active_short_qty || 0} qty) → ${sentiment?.active_position_bias}
- Fear/Greed:          ${sentiment?.fear_greed} | Drawdown: ${sentiment?.drawdown_pct?.toFixed(2)}% | Margin Used: ${sentiment?.margin_utilization}%
- User Bias (24h):     ${sentiment?.user_bias} (${sentiment?.total_buy_orders || 0} buys vs ${sentiment?.total_sell_orders || 0} sells)
- Market Breadth:      ${sentiment?.breadth_signal}
- Call Wall:           ₹${sentiment?.call_wall || 'N/A'} | Put Wall: ₹${sentiment?.put_wall || 'N/A'} | Max Pain: ₹${sentiment?.max_pain || 'N/A'}
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

${behaviourContext}
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
  "entry_price": <number or null - MUST BE null if final_signal is HOLD>,
  "target_price": <number or null - MUST BE null if final_signal is HOLD>,
  "stop_loss": <number or null - MUST BE null if final_signal is HOLD>,
  "risk_reward": <number or null - MUST BE null if final_signal is HOLD>,
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

    // Feature 4: Time-of-Day Filter Hard Signal Block (e.g. 9:15–9:30 AM opening noise / 3:00–3:30 PM closing chaos)
    if (timeFilter?.block_signals) {
      console.log(`⏰ Signal BLOCKED by Time-of-Day Filter: ${timeFilter.label} (${timeFilter.action})`);
      finalSignal.final_signal = 'HOLD';
      finalSignal.action = 'WAIT / DO NOT TRADE';
      finalSignal.direction = 'NEUTRAL';
      finalSignal.blocked_by_time_filter = true;
      finalSignal.time_filter_advisory = `${timeFilter.label}: ${timeFilter.description}`;
      finalSignal.reasoning = `[BLOCKED BY TIME-OF-DAY FILTER: ${timeFilter.label}] ${timeFilter.description} Fresh trade signals are strictly paused during this window to prevent false opening whipsaws. ${finalSignal.reasoning || ''}`;
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`🎯 FINAL SIGNAL for ${symbol}:`);
    console.log(`   Signal:     ${finalSignal.final_signal}`);
    console.log(`   Direction:  ${finalSignal.direction}`);
    console.log(`   Confidence: ${finalSignal.confidence}%`);
    console.log(`   Strength:   ${finalSignal.strength}`);
    console.log(`   Action:     ${finalSignal.action}`);
    if (finalSignal.blocked_by_time_filter) {
      console.log(`   Time Block: ACTIVE (${timeFilter.label})`);
    }
    console.log(`${'═'.repeat(50)}\n`);

    // Step 5: Send alert if strong signal and not blocked by time filter
    if (
      !finalSignal.blocked_by_time_filter &&
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

    // Phase 3: Prefer institutional confluence levels over naive candle-based S/R
    const support = instSupport || marketAnalysis?.analysis?.key_support || marketAnalysis?.indicators?.['1_hour']?.support_resistance?.support;
    const resistance = instResistance || marketAnalysis?.analysis?.key_resistance || marketAnalysis?.indicators?.['1_hour']?.support_resistance?.resistance;

    // Fallback logic to ensure prices and targets are ALWAYS numeric and NEVER N/A
    const parseNum = (val) => {
      if (!val || val === 'N/A' || isNaN(Number(val))) return null;
      return Number(val);
    };

    const currentPriceNum = parseNum(currentPrice) || parseNum(livePriceNum);
    const isHoldSignal = finalSignal.final_signal === 'HOLD' || finalSignal.direction === 'NEUTRAL';
    const isSellSignal = finalSignal.final_signal === 'SELL' || finalSignal.direction === 'BEARISH';
    const isBuySignal = finalSignal.final_signal === 'BUY' || finalSignal.direction === 'BULLISH';

    let entryPrice = null;
    let targetPrice = null;
    let stopLoss = null;

    if (!isHoldSignal && (isBuySignal || isSellSignal)) {
      entryPrice = parseNum(finalSignal.entry_price) || currentPriceNum;
      targetPrice = parseNum(finalSignal.target_price);
      stopLoss = parseNum(finalSignal.stop_loss);

      const supNum = parseNum(support);
      const resNum = parseNum(resistance);

      // Phase 3: Camarilla breakout/breakdown levels for extended targets
      const camH4 = parseNum(pivotLevels?.H4);
      const camL4 = parseNum(pivotLevels?.L4);

      // Dynamic ATR-based fallbacks
      const defaultTargetDist = Number((atrVal * 2.0).toFixed(2));
      const defaultStopDist = Number((atrVal * 1.5).toFixed(2));

      if (!targetPrice && currentPriceNum) {
        if (isBuySignal) {
          targetPrice = camH4 && camH4 > currentPriceNum ? camH4
            : resNum && resNum > currentPriceNum ? resNum
            : Number((currentPriceNum + defaultTargetDist).toFixed(2));
        } else if (isSellSignal) {
          targetPrice = camL4 && camL4 < currentPriceNum ? camL4
            : supNum && supNum < currentPriceNum ? supNum
            : Number((currentPriceNum - defaultTargetDist).toFixed(2));
        }
      }

      if (!stopLoss && currentPriceNum) {
        if (isBuySignal) {
          stopLoss = supNum && supNum < currentPriceNum ? supNum : Number((currentPriceNum - defaultStopDist).toFixed(2));
        } else if (isSellSignal) {
          stopLoss = resNum && resNum > currentPriceNum ? resNum : Number((currentPriceNum + defaultStopDist).toFixed(2));
        }
      }
    }

    // ── Compute profit / risk metrics (arithmetic, no LLM needed) ──────────
    let profitAbs = null;
    let riskAbs = null;
    let profitPct = null;
    let riskPct = null;
    let rrRatio = null;

    if (!isHoldSignal && entryPrice && targetPrice && stopLoss) {
      if (isSellSignal) {
        profitAbs = Number((entryPrice - targetPrice).toFixed(2));
        riskAbs = Number((stopLoss - entryPrice).toFixed(2));
      } else {
        profitAbs = Number((targetPrice - entryPrice).toFixed(2));
        riskAbs = Number((entryPrice - stopLoss).toFixed(2));
      }

      profitPct = entryPrice ? Number(((profitAbs / entryPrice) * 100).toFixed(2)) : null;
      riskPct = entryPrice ? Number(((Math.abs(riskAbs) / entryPrice) * 100).toFixed(2)) : null;
      rrRatio = (profitAbs !== null && riskAbs && Math.abs(riskAbs) > 0)
        ? Number((Math.abs(profitAbs) / Math.abs(riskAbs)).toFixed(2))
        : null;

      // Safety Gate: Ensure Positive Mathematical Expectancy (R:R >= 1.25 and positive reward)
      if (rrRatio !== null && (rrRatio < 1.25 || profitAbs <= 0)) {
        const minReward = Number((Math.abs(riskAbs) * 1.5).toFixed(2));
        if (isBuySignal) {
          targetPrice = Number((entryPrice + minReward).toFixed(2));
          profitAbs = Number((targetPrice - entryPrice).toFixed(2));
        } else {
          targetPrice = Number((entryPrice - minReward).toFixed(2));
          profitAbs = Number((entryPrice - targetPrice).toFixed(2));
        }
        profitPct = Number(((profitAbs / entryPrice) * 100).toFixed(2));
        rrRatio = Number((Math.abs(profitAbs) / Math.abs(riskAbs)).toFixed(2));
      }
    }

    // Fallback for hold_until if LLM didn't return it
    const holdUntil = finalSignal.hold_until || (isHoldSignal ? 'Wait for breakout confirmation past key levels' : finalSignal.timeframe_to_play || null);
    const holdMins = finalSignal.max_hold_duration_minutes || (isHoldSignal ? 30 : null);

    return {
      ...finalSignal,
      current_price: currentPrice,
      entry_price: entryPrice,
      target_price: targetPrice,
      stop_loss: stopLoss,
      signal_strength: signalStrength,
      atr_metrics: {
        atr_value: atrVal,
        atr_pct: atrInfo?.pct || null,
        volatility_category: atrInfo?.volatility_category || 'NORMAL',
        stop_distance: suggestedStopDist,
        target_distance: suggestedTargetDist,
      },
      // ── Hold & Profit fields ──────────────────────────────
      hold_until: holdUntil,
      max_hold_duration_minutes: holdMins,
      profit_abs: profitAbs,
      profit_potential_pct: profitPct,
      risk_abs: riskAbs ? Math.abs(riskAbs) : null,
      risk_pct: riskPct,
      risk_reward_computed: rrRatio,
      // ── Institutional Levels & Defense Hotspots ───────────
      institutional_levels: {
        confluence_support: instSupport,
        confluence_resistance: instResistance,
        call_wall: callWall,
        put_wall: putWall,
        max_pain: maxPain,
        delta_oi: deltaOI,
        zone_pcr: zonePCR,
        cpr: pivotLevels ? {
          pivot: pivotLevels.pivot,
          tc: pivotLevels.TC,
          bc: pivotLevels.BC,
          width_pct: pivotLevels.cpr_width_pct,
          type: pivotLevels.cpr_type,
          position: pivotLevels.cpr_position,
        } : null,
        camarilla: pivotLevels ? {
          h4: pivotLevels.H4,
          h3: pivotLevels.H3,
          l3: pivotLevels.L3,
          l4: pivotLevels.L4,
        } : null,
      },
      // ── Phase 4: Market Regime & Time Overlay ─────────────
      market_regime: marketRegime,
      time_filter: timeFilter,
      // ── Champion Trader Playbook Cloned ───────────────────
      champion_playbook: championTrader ? {
        is_instrument_specific: championTrader.is_instrument_specific,
        trader_name: championTrader.trader_name,
        symbol: championTrader.symbol,
        win_rate_pct: championTrader.win_rate_pct,
        total_pnl: championTrader.total_pnl,
        avg_hold_mins: championTrader.avg_hold_mins,
        risk_reward_ratio: championTrader.risk_reward_ratio,
        preferred_product_type: championTrader.preferred_product_type,
        best_entry_hour_ist: championTrader.best_entry_hour_ist,
      } : null,
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