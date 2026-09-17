import { runLLMCompletion, parseLLMJson } from '../tools/alerts.js';
import { calculateIndicators } from '../tools/indicators.js';
import { getSynchronizedCandles } from '../tools/candleSync.js';
import dotenv from 'dotenv';

dotenv.config();

// ─── Helper: summarize indicators for a timeframe ────────
const summarizeIndicators = (ind, tf) => {
  if (!ind) return `${tf.toUpperCase()}: No data available`;

  const lines = [
    `[${tf.toUpperCase()}]`,
    `  Price: ₹${ind.current_price} | Trend: ${ind.trend}`,
    `  ATR (Volatility): ₹${ind.atr?.value ?? 'N/A'} (${ind.atr?.pct ?? 'N/A'}% | ${ind.atr?.volatility_category ?? 'NORMAL'}) | SL Buffer: ±₹${ind.atr?.stop_distance ?? 'N/A'}`,
    `  EMA9: ${ind.ema?.ema9 ?? 'N/A'} | EMA21: ${ind.ema?.ema21 ?? 'N/A'} | EMA50: ${ind.ema?.ema50 ?? 'N/A'} | EMA200: ${ind.ema?.ema200 ?? 'N/A'}`,
    `  RSI: ${ind.rsi?.value ?? 'N/A'} (${ind.rsi?.signal ?? 'N/A'})`,
    `  MACD: ${ind.macd?.macd ?? 'N/A'} | Hist: ${ind.macd?.histogram ?? 'N/A'} | ${ind.macd?.trend ?? 'N/A'}`,
    `  BB: ${ind.bollinger?.signal ?? 'N/A'} | VWAP: ${ind.vwap?.signal ?? 'N/A'} (₹${ind.vwap?.value ?? 'N/A'})`,
    `  Support: ${ind.support_resistance?.support ?? 'N/A'} | Resistance: ${ind.support_resistance?.resistance ?? 'N/A'}`,
    `  Volume: ${ind.volume?.trend ?? 'N/A'} (${ind.volume?.ratio ?? 1}x avg)`,
  ];

  // Phase 3: Session-Anchored VWAP Bands
  if (ind.vwap_bands) {
    const vb = ind.vwap_bands;
    lines.push(`  📊 SESSION VWAP BANDS: VWAP=₹${vb.vwap} | +1σ=₹${vb.upper_1} | -1σ=₹${vb.lower_1} | +2σ=₹${vb.upper_2} | -2σ=₹${vb.lower_2} | Bias: ${vb.bias} (${vb.session_candles_used} session candles)`);
  }

  // Phase 3: CPR + Camarilla + PDH/PDL
  if (ind.pivot_levels) {
    const pl = ind.pivot_levels;
    lines.push(`  🏛️ CPR: Pivot=₹${pl.pivot} | TC=₹${pl.TC} | BC=₹${pl.BC} | Width: ${pl.cpr_width_pct}% → ${pl.cpr_type} | Position: ${pl.cpr_position}`);
    lines.push(`  🎯 CAMARILLA: H4=₹${pl.H4} (Breakout) | H3=₹${pl.H3} (Resistance) | L3=₹${pl.L3} (Support) | L4=₹${pl.L4} (Breakdown)`);
    lines.push(`  📍 PDH=₹${pl.PDH} (${pl.pdh_sweep}) | PDL=₹${pl.PDL} (${pl.pdl_sweep})`);
  }

  // Phase 3: MFI (Smart Money)
  if (ind.mfi) {
    lines.push(`  💰 MFI (Smart Money): ${ind.mfi.value} → ${ind.mfi.signal}`);
  }

  // Phase 3: Divergences
  if (ind.divergences && ind.divergences.divergences?.length > 0) {
    lines.push(`  ⚡ DIVERGENCES: ${ind.divergences.summary} | Bias: ${ind.divergences.bias}`);
    for (const d of ind.divergences.divergences.slice(0, 3)) {
      lines.push(`    → ${d.type} (${d.strength}): ${d.description}`);
    }
  }

  // Phase 3: Institutional Levels Summary
  if (ind.institutional_levels) {
    const il = ind.institutional_levels;
    lines.push(`  🏦 INSTITUTIONAL S/R: Support=₹${il.primary_support} | Resistance=₹${il.primary_resistance} | Breakout=₹${il.breakout_long} | Breakdown=₹${il.breakdown_short}`);
  }

  // Phase 4: Market Regime Engine
  if (ind.market_regime) {
    const mr = ind.market_regime;
    lines.push(`  🧭 REGIME: ${mr.primary_regime} (${mr.trend_direction}) | ADX(14): ${mr.adx?.value} (Slope: ${mr.adx?.slope}, +DI: ${mr.adx?.plus_di}, -DI: ${mr.adx?.minus_di})`);
    lines.push(`  🎯 DUAL CONFIRMATION: ${mr.cpr_dual_confirmation} | Sizing: ${mr.atr_volatility_cross}`);
    if (mr.time_of_day) {
      lines.push(`  ⏰ TIME WINDOW (IST): ${mr.time_of_day.label} → ${mr.time_of_day.action}`);
    }
    lines.push(`  💡 REGIME GUIDANCE: ${mr.guidance}`);
  }

  return lines.join('\n');
};

// ─── Market Analyst Agent ────────────────────────────────
export const marketAnalyst = async (symbol, timeframe = '1_hour', lookbackDays = 30, screenLivePrice = null, abortSignal = null) => {
  try {
    if (abortSignal?.aborted) throw new Error('Analysis aborted by user.');
    console.log(`📊 Market Analyst analyzing ${symbol} on [${timeframe}] (${lookbackDays}d lookback range)...`);

    // Fetch synchronized candles across primary and context timeframes from the SAME active provider
    const syncResult = await getSynchronizedCandles(symbol, timeframe, lookbackDays, screenLivePrice);

    if (syncResult.error || !syncResult.primaryCandles || syncResult.primaryCandles.length < 5) {
      return {
        error: syncResult.error || `Not enough candle data for ${symbol}`,
        symbol,
        timeframe,
      };
    }

    const {
      provider,
      primaryTimeframe,
      primaryCandles,
      contextTimeframes,
      contextCandles,
      currentLivePrice,
      historicalStats,
    } = syncResult;

    // Step 2: Calculate indicators for primary timeframe
    const primaryInd = calculateIndicators(primaryCandles);
    if (!primaryInd) {
      return { error: `Could not calculate indicators for ${symbol} on ${primaryTimeframe}`, symbol, timeframe: primaryTimeframe };
    }

    // Calculate indicators for all context timeframes (from the SAME provider)
    const contextIndMap = {};
    for (const cTf of contextTimeframes) {
      const cCandles = contextCandles[cTf] || [];
      if (cCandles.length >= 5) {
        contextIndMap[cTf] = calculateIndicators(cCandles);
      } else {
        contextIndMap[cTf] = null;
      }
    }

    // Step 3: Count how many timeframes agree on direction
    const allIndicators = [primaryInd, ...Object.values(contextIndMap)].filter(Boolean);
    const trendVotes = allIndicators.map(i => i.trend);
    const bullCount = trendVotes.filter(t => t === 'UPTREND').length;
    const bearCount = trendVotes.filter(t => t === 'DOWNTREND').length;
    const mtfAlignment = bullCount === trendVotes.length ? 'ALL_BULLISH'
      : bearCount === trendVotes.length ? 'ALL_BEARISH'
        : bullCount > bearCount ? 'MOSTLY_BULLISH'
          : bearCount > bullCount ? 'MOSTLY_BEARISH'
            : 'MIXED';

    // Step 4: Sample primary candle trajectory across full dataset
    const sampleSize = Math.min(25, primaryCandles.length);
    const step = Math.max(1, Math.floor(primaryCandles.length / sampleSize));
    const sampledPrimaryTrajectory = [];
    for (let i = 0; i < primaryCandles.length; i += step) {
      const c = primaryCandles[i];
      sampledPrimaryTrajectory.push({
        idx: i,
        time: c.BUCKET,
        open: +c.OPEN,
        high: +c.HIGH,
        low: +c.LOW,
        close: +c.CLOSE,
        volume: +c.VOLUME,
      });
    }

    const last5Primary = primaryCandles.slice(-5).map(c => ({
      time: c.BUCKET, open: +c.OPEN, high: +c.HIGH, low: +c.LOW,
      close: +c.CLOSE, volume: +c.VOLUME,
    }));

    // Find the lowest available context timeframe for entry timing
    const lowestContextTf = contextTimeframes.find(tf => tf.includes('1_m') || tf.includes('5_m')) || contextTimeframes[0];
    const lowestContextCandles = (contextCandles[lowestContextTf] || []).slice(-5).map(c => ({
      time: c.BUCKET, open: +c.OPEN, high: +c.HIGH, low: +c.LOW,
      close: +c.CLOSE, volume: +c.VOLUME,
    }));

    // Step 5: Build multi-timeframe indicator section for prompt
    const contextIndicatorSummaries = contextTimeframes
      .map(tf => summarizeIndicators(contextIndMap[tf], tf))
      .join('\n\n');

    // Step 6: Build prompt
    const prompt = `
You are an expert technical analyst specializing in Indian markets (NSE/BSE).
Analyze ${symbol} using MULTI-TIMEFRAME confluence analysis across ALL ${primaryCandles.length} loaded candles for ${primaryTimeframe}.
Data Source: ${provider.toUpperCase()} (100% Synchronized multi-timeframe feed).

CURRENT REAL-TIME PRICE: ₹ ${currentLivePrice}

PRIMARY TIMEFRAME CANDLE DATASET STATS (${primaryTimeframe.toUpperCase()}):
- Total Primary Candles Analyzed: ${primaryCandles.length} candles across lookback range
- All-Time Support Low: ${historicalStats?.historical_support_low || 'N/A'}
- All-Time Resistance High: ${historicalStats?.historical_resistance_high || 'N/A'}
- Historical Avg Volume: ${historicalStats?.avg_volume ? Math.round(historicalStats.avg_volume).toLocaleString() : 'N/A'}
- Price Volatility (StdDev): ${historicalStats?.price_volatility ? historicalStats.price_volatility.toFixed(2) : 'N/A'}

SAMPLED TRAJECTORY ACROSS ALL ${primaryCandles.length} PRIMARY CANDLES (from start to end):
${JSON.stringify(sampledPrimaryTrajectory, null, 2)}

PRIMARY TIMEFRAME INDICATOR SUMMARY:
${summarizeIndicators(primaryInd, 'PRIMARY_' + primaryTimeframe)}

CONTEXT TIMEFRAME INDICATOR SUMMARIES (Synchronized on same feed):
${contextIndicatorSummaries}

TIMEFRAME CONFLUENCE ALIGNMENT: ${mtfAlignment} (${bullCount} bullish, ${bearCount} bearish out of ${trendVotes.length} TFs)

RECENT PRIMARY CANDLES (last 5):
${JSON.stringify(last5Primary)}

RECENT ENTRY-TIMING CANDLES (${lowestContextTf ? lowestContextTf.toUpperCase() : 'MICRO'} - last 5):
${JSON.stringify(lowestContextCandles)}

Multi-timeframe trading rules:
- The primary timeframe (${primaryTimeframe}) sets the CORE BIAS for this trade.
- Higher timeframes confirm the MACRO trend and major institutional levels.
- Lower timeframes (${lowestContextTf || 'lower'}) indicate MOMENTUM and ENTRY timing.
- ALL timeframes agreeing (${mtfAlignment}) = HIGH CONVICTION signal.
- Mixed timeframes = wait or recommend conservative entry.

Provide analysis in this EXACT JSON format:
{
  "trend": "UPTREND|DOWNTREND|SIDEWAYS",
  "strength": "STRONG|MODERATE|WEAK",
  "momentum": "INCREASING|DECREASING|NEUTRAL",
  "mtf_alignment": "${mtfAlignment}",
  "mtf_analysis": "<which timeframes agree/disagree and what it means>",
  "entry_timing": "<what the lower timeframes suggest for entry timing>",
  "key_support": <number>,
  "key_resistance": <number>,
  "rsi_analysis": "<RSI across timeframes>",
  "macd_analysis": "<MACD across timeframes>",
  "volume_analysis": "<volume story across timeframes>",
  "price_action": "<what the candles are showing on primary TF>",
  "bias": "BULLISH|BEARISH|NEUTRAL",
  "confidence": <0-100>,
  "summary": "<2-3 sentence multi-timeframe summary for a trader>"
}

Respond ONLY with valid JSON. No explanation outside JSON.
    `;

    const systemPrompt = 'You are an expert multi-timeframe technical analyst for Indian stock markets. Always respond with valid JSON only.';
    const rawText = await runLLMCompletion({
      systemPrompt,
      prompt,
      maxTokens: 5000,
      temperature: 0.1,
      signal: abortSignal,
    });

    const analysis = parseLLMJson(rawText);

    console.log(`✅ Market Analyst done [${mtfAlignment} via ${provider}]:`, analysis.bias, analysis.confidence + '%');

    const indicatorsOutput = {
      [primaryTimeframe]: primaryInd,
      ...contextIndMap,
    };

    return {
      symbol,
      timeframe: primaryTimeframe,
      provider,
      currentPrice: currentLivePrice,
      candles: primaryCandles,
      context_candles: contextCandles,
      mtf_alignment: mtfAlignment,
      bull_tf_count: bullCount,
      bear_tf_count: bearCount,
      indicators: indicatorsOutput,
      market_regime: primaryInd?.market_regime || null,
      analysis,
      candle_count: primaryCandles.length,
      historical_stats: historicalStats,
      last_candle: last5Primary[last5Primary.length - 1],
    };

  } catch (error) {
    console.error('❌ Market Analyst error:', error.message);
    return { error: error.message, symbol, timeframe };
  }
};