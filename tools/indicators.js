// ─── Technical Indicators ────────────────────────────────
// Calculates RSI, MACD, EMA, Bollinger Bands, VWAP
// Input: array of candles [{open, high, low, close, volume}]

// ─── Helper: Extract closes ──────────────────────────────
const getCloses = (candles) => candles.map(c => parseFloat(c.CLOSE));
const getHighs  = (candles) => candles.map(c => parseFloat(c.HIGH));
const getLows   = (candles) => candles.map(c => parseFloat(c.LOW));
const getVolumes = (candles) => candles.map(c => parseFloat(c.VOLUME));

// ─── Simple Moving Average ───────────────────────────────
export const SMA = (values, period) => {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
};

// ─── Exponential Moving Average ─────────────────────────
export const EMA = (values, period) => {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = SMA(values.slice(0, period), period);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(2));
};

// ─── RSI ─────────────────────────────────────────────────
export const RSI = (values, period = 14) => {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
};

// ─── MACD ────────────────────────────────────────────────
export const MACD = (values, fast = 12, slow = 26, signal = 9) => {
  if (values.length < slow + signal) return null;

  const emaFast = EMA(values, fast);
  const emaSlow = EMA(values, slow);

  if (!emaFast || !emaSlow) return null;

  const macdLine = parseFloat((emaFast - emaSlow).toFixed(2));

  // Calculate signal line (EMA of MACD)
  const macdValues = [];
  for (let i = slow - 1; i < values.length; i++) {
    const slice = values.slice(0, i + 1);
    const f = EMA(slice, fast);
    const s = EMA(slice, slow);
    if (f && s) macdValues.push(f - s);
  }

  const signalLine = parseFloat(EMA(macdValues, signal).toFixed(2));
  const histogram  = parseFloat((macdLine - signalLine).toFixed(2));

  return {
    macd:      macdLine,
    signal:    signalLine,
    histogram,
    trend:     histogram > 0 ? 'BULLISH' : 'BEARISH',
  };
};

// ─── Bollinger Bands ─────────────────────────────────────
export const BollingerBands = (values, period = 20, stdDev = 2) => {
  if (values.length < period) return null;

  const slice = values.slice(-period);
  const middle = SMA(slice, period);
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper:  parseFloat((middle + stdDev * std).toFixed(2)),
    middle: parseFloat(middle.toFixed(2)),
    lower:  parseFloat((middle - stdDev * std).toFixed(2)),
    width:  parseFloat((stdDev * std * 2).toFixed(2)),
  };
};

// ─── VWAP (Basic cumulative — kept for backward compat) ──
export const VWAP = (candles) => {
  if (!candles.length) return null;

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const typicalPrice = (
      parseFloat(candle.HIGH) +
      parseFloat(candle.LOW) +
      parseFloat(candle.CLOSE)
    ) / 3;
    const volume = parseFloat(candle.VOLUME);
    cumulativeTPV += typicalPrice * volume;
    cumulativeVolume += volume;
  }

  if (cumulativeVolume === 0) return null;
  return parseFloat((cumulativeTPV / cumulativeVolume).toFixed(2));
};

// ─── Session-Anchored VWAP with ±1σ / ±2σ Bands ────────
// Resets at the start of the current trading session (9:15 AM IST).
// Returns VWAP value plus standard deviation bands for institutional
// mean-reversion and extreme-bounce zones.
export const VWAP_Bands = (candles) => {
  if (!candles || candles.length < 2) return null;

  // Detect the last day boundary — slice to current session candles only
  let sessionStart = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    const currDate = new Date(candles[i].BUCKET).toDateString();
    const prevDate = new Date(candles[i - 1].BUCKET).toDateString();
    if (currDate !== prevDate) {
      sessionStart = i;
      break;
    }
  }

  const sessionCandles = candles.slice(sessionStart);
  if (sessionCandles.length < 2) return null;

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;
  let cumulativeTPSqV = 0; // for variance calculation

  for (const c of sessionCandles) {
    const tp = (parseFloat(c.HIGH) + parseFloat(c.LOW) + parseFloat(c.CLOSE)) / 3;
    const vol = parseFloat(c.VOLUME) || 1; // guard zero-volume
    cumulativeTPV += tp * vol;
    cumulativeVolume += vol;
    cumulativeTPSqV += tp * tp * vol;
  }

  if (cumulativeVolume === 0) return null;

  const vwapVal = cumulativeTPV / cumulativeVolume;
  // Variance = E[TP²] - E[TP]² (volume-weighted)
  const variance = (cumulativeTPSqV / cumulativeVolume) - (vwapVal * vwapVal);
  const sigma = Math.sqrt(Math.max(0, variance));

  const currentPrice = parseFloat(sessionCandles[sessionCandles.length - 1].CLOSE);

  // Determine institutional bias
  let bias = 'AT_VWAP';
  if (currentPrice > vwapVal + 2 * sigma) bias = 'BAND2_UPPER_EXTREME';
  else if (currentPrice > vwapVal + sigma) bias = 'ABOVE_UPPER_BAND1';
  else if (currentPrice > vwapVal * 1.001) bias = 'ABOVE_VWAP';
  else if (currentPrice < vwapVal - 2 * sigma) bias = 'BAND2_LOWER_EXTREME';
  else if (currentPrice < vwapVal - sigma) bias = 'BELOW_LOWER_BAND1';
  else if (currentPrice < vwapVal * 0.999) bias = 'BELOW_VWAP';

  return {
    vwap: parseFloat(vwapVal.toFixed(2)),
    sigma: parseFloat(sigma.toFixed(2)),
    upper_1: parseFloat((vwapVal + sigma).toFixed(2)),
    lower_1: parseFloat((vwapVal - sigma).toFixed(2)),
    upper_2: parseFloat((vwapVal + 2 * sigma).toFixed(2)),
    lower_2: parseFloat((vwapVal - 2 * sigma).toFixed(2)),
    bias,
    session_candles_used: sessionCandles.length,
  };
};

// ─── Daily CPR (Central Pivot Range) + Camarilla Pivots + PDH/PDL ──
// Extracts Previous Day OHLC, computes Pivot, BC, TC, CPR Width %,
// Camarilla H3/H4/L3/L4, and detects PDH/PDL liquidity sweeps.
export const PivotLevels = (candles) => {
  if (!candles || candles.length < 10) return null;

  // Find previous completed trading day candles
  const lastCandle = candles[candles.length - 1];
  const lastDate = new Date(lastCandle.BUCKET).toDateString();

  // Collect candles by date
  const dateMap = {};
  for (const c of candles) {
    const d = new Date(c.BUCKET).toDateString();
    if (!dateMap[d]) dateMap[d] = [];
    dateMap[d].push(c);
  }

  const dates = Object.keys(dateMap).sort((a, b) => new Date(a) - new Date(b));
  if (dates.length < 2) return null;

  // Previous completed day is second-to-last date (or last if today has no data yet)
  const prevDayDate = dates[dates.length - 2];
  const prevDayCandles = dateMap[prevDayDate];

  if (!prevDayCandles || prevDayCandles.length === 0) return null;

  const PDH = Math.max(...prevDayCandles.map(c => parseFloat(c.HIGH)));
  const PDL = Math.min(...prevDayCandles.map(c => parseFloat(c.LOW)));
  const PDC = parseFloat(prevDayCandles[prevDayCandles.length - 1].CLOSE);
  const PDO = parseFloat(prevDayCandles[0].OPEN);

  // ── Central Pivot Range ──────────────────────────
  const P = (PDH + PDL + PDC) / 3;       // Pivot
  const BC = (PDH + PDL) / 2;             // Bottom Central
  const TC = 2 * P - BC;                  // Top Central
  const cprWidth = Math.abs(TC - BC);
  const cprWidthPct = (cprWidth / P) * 100;

  // CPR classification for Indian markets
  let cprType = 'NORMAL';
  if (cprWidthPct < 0.3) cprType = 'NARROW_CPR_TREND_DAY';
  else if (cprWidthPct > 0.8) cprType = 'WIDE_CPR_RANGE_DAY';

  // Is today's open above or below CPR?
  const todayCandles = dateMap[lastDate] || [];
  const todayOpen = todayCandles.length > 0 ? parseFloat(todayCandles[0].OPEN) : null;
  let cprPosition = 'INSIDE_CPR';
  if (todayOpen) {
    const cprTop = Math.max(TC, BC);
    const cprBot = Math.min(TC, BC);
    if (todayOpen > cprTop) cprPosition = 'ABOVE_CPR';
    else if (todayOpen < cprBot) cprPosition = 'BELOW_CPR';
  }

  // ── Camarilla Pivots ─────────────────────────────
  const range = PDH - PDL;
  const H4 = parseFloat((PDC + range * 1.1 / 2).toFixed(2));   // Breakout Long
  const H3 = parseFloat((PDC + range * 1.1 / 4).toFixed(2));   // Resistance / Short Fade
  const L3 = parseFloat((PDC - range * 1.1 / 4).toFixed(2));   // Support / Long Fade
  const L4 = parseFloat((PDC - range * 1.1 / 2).toFixed(2));   // Breakdown Short

  // ── PDH / PDL Liquidity Sweep Detection ──────────
  const currentPrice = parseFloat(lastCandle.CLOSE);
  const currentHigh = parseFloat(lastCandle.HIGH);
  const currentLow = parseFloat(lastCandle.LOW);
  const pdhSweepTolerance = range * 0.02; // 2% of prev day range

  let pdhSweep = 'NONE';
  if (currentHigh > PDH && currentPrice < PDH) {
    pdhSweep = 'BULL_TRAP'; // Swept PDH then closed below — liquidity grab
  } else if (currentHigh > PDH && currentPrice > PDH) {
    pdhSweep = 'PDH_BREAKOUT'; // Clean breakout above PDH
  }

  let pdlSweep = 'NONE';
  if (currentLow < PDL && currentPrice > PDL) {
    pdlSweep = 'BEAR_TRAP'; // Swept PDL then closed above — liquidity grab
  } else if (currentLow < PDL && currentPrice < PDL) {
    pdlSweep = 'PDL_BREAKDOWN'; // Clean breakdown below PDL
  }

  return {
    // Previous Day OHLC
    PDH: parseFloat(PDH.toFixed(2)),
    PDL: parseFloat(PDL.toFixed(2)),
    PDC: parseFloat(PDC.toFixed(2)),
    PDO: parseFloat(PDO.toFixed(2)),
    // Central Pivot Range
    pivot: parseFloat(P.toFixed(2)),
    TC: parseFloat(TC.toFixed(2)),
    BC: parseFloat(BC.toFixed(2)),
    cpr_width: parseFloat(cprWidth.toFixed(2)),
    cpr_width_pct: parseFloat(cprWidthPct.toFixed(3)),
    cpr_type: cprType,
    cpr_position: cprPosition,
    // Camarilla
    H4, H3, L3, L4,
    // Liquidity Sweeps
    pdh_sweep: pdhSweep,
    pdl_sweep: pdlSweep,
  };
};

// ─── MFI (Money Flow Index — 14 Period) ─────────────────
// Volume-weighted momentum: reveals smart-money accumulation/distribution
// before it appears on pure price charts. Superior to RSI for detecting
// institutional intent.
export const MFI = (candles, period = 14) => {
  if (!candles || candles.length < period + 1) return null;

  let positiveFlow = 0;
  let negativeFlow = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (parseFloat(candles[i].HIGH) + parseFloat(candles[i].LOW) + parseFloat(candles[i].CLOSE)) / 3;
    const prevTp = (parseFloat(candles[i - 1].HIGH) + parseFloat(candles[i - 1].LOW) + parseFloat(candles[i - 1].CLOSE)) / 3;
    const rawMoneyFlow = tp * (parseFloat(candles[i].VOLUME) || 1);

    if (tp > prevTp) positiveFlow += rawMoneyFlow;
    else if (tp < prevTp) negativeFlow += rawMoneyFlow;
  }

  if (negativeFlow === 0) return { value: 100, signal: 'OVERBOUGHT' };

  const moneyRatio = positiveFlow / negativeFlow;
  const mfi = parseFloat((100 - 100 / (1 + moneyRatio)).toFixed(2));

  let signal = 'NEUTRAL';
  if (mfi > 80) signal = 'OVERBOUGHT';
  else if (mfi < 20) signal = 'OVERSOLD';
  else if (mfi > 60) signal = 'ACCUMULATION';
  else if (mfi < 40) signal = 'DISTRIBUTION';

  return { value: mfi, signal };
};

// ─── MACD + MFI Divergence Engine ───────────────────────
// Detects swing pivots and checks for bullish/bearish divergences
// between price and MACD histogram or MFI. This catches 65-75%
// of trend exhaustion setups before the move actually reverses.
//
// A "swing high" requires `swingLookback` candles lower on each side.
// A "swing low" requires `swingLookback` candles higher on each side.
// Minimum price delta filters out noise pivots on flat markets.
export const detectDivergences = (candles, swingLookback = 3) => {
  if (!candles || candles.length < 30) return { divergences: [], summary: 'Not enough data' };

  const closes = getCloses(candles);
  const divergences = [];

  // ── Compute MACD histogram series ──────────────────
  const fast = 12, slow = 26, sig = 9;
  const macdHistSeries = [];
  for (let i = slow + sig - 1; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const f = EMA(slice, fast);
    const s = EMA(slice, slow);
    if (f !== null && s !== null) {
      const macdValues = [];
      for (let j = slow - 1; j <= i; j++) {
        const fs = EMA(closes.slice(0, j + 1), fast);
        const ss = EMA(closes.slice(0, j + 1), slow);
        if (fs !== null && ss !== null) macdValues.push(fs - ss);
      }
      const signal = macdValues.length >= sig ? EMA(macdValues, sig) : null;
      const hist = signal !== null ? f - s - signal : null;
      macdHistSeries.push({ idx: i, hist, price: closes[i] });
    }
  }

  // ── Compute MFI series ─────────────────────────────
  const mfiSeries = [];
  const mfiPeriod = 14;
  for (let i = mfiPeriod; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const mfiResult = MFI(slice, mfiPeriod);
    if (mfiResult) {
      mfiSeries.push({ idx: i, value: mfiResult.value, price: closes[i] });
    }
  }

  // ── Find Swing Highs and Lows ──────────────────────
  const findSwingPoints = (series, lookback) => {
    const swingHighs = [];
    const swingLows = [];

    for (let i = lookback; i < series.length - lookback; i++) {
      const price = series[i].price;
      let isHigh = true;
      let isLow = true;

      for (let j = 1; j <= lookback; j++) {
        if (series[i - j].price >= price) isHigh = false;
        if (series[i + j].price >= price) isHigh = false;
        if (series[i - j].price <= price) isLow = false;
        if (series[i + j].price <= price) isLow = false;
      }

      if (isHigh) swingHighs.push(series[i]);
      if (isLow) swingLows.push(series[i]);
    }

    return { swingHighs, swingLows };
  };

  // ── MACD Divergences ───────────────────────────────
  if (macdHistSeries.length > swingLookback * 2 + 2) {
    const { swingHighs, swingLows } = findSwingPoints(macdHistSeries, swingLookback);
    const currentPrice = closes[closes.length - 1];
    const minPriceDelta = currentPrice * 0.003; // 0.3% minimum price difference to qualify

    // Bearish Divergence: Price Higher High, MACD Histogram Lower High
    for (let i = 1; i < swingHighs.length; i++) {
      const prev = swingHighs[i - 1];
      const curr = swingHighs[i];
      if (curr.price > prev.price + minPriceDelta && curr.hist < prev.hist) {
        divergences.push({
          type: 'BEARISH_MACD_DIVERGENCE',
          signal: 'BEARISH',
          description: `Price made Higher High (₹${prev.price.toFixed(2)} → ₹${curr.price.toFixed(2)}) but MACD histogram made Lower High — institutional distribution`,
          candle_index: curr.idx,
          strength: Math.abs(curr.price - prev.price) > minPriceDelta * 3 ? 'STRONG' : 'MODERATE',
        });
      }
    }

    // Bullish Divergence: Price Lower Low, MACD Histogram Higher Low
    for (let i = 1; i < swingLows.length; i++) {
      const prev = swingLows[i - 1];
      const curr = swingLows[i];
      if (curr.price < prev.price - minPriceDelta && curr.hist > prev.hist) {
        divergences.push({
          type: 'BULLISH_MACD_DIVERGENCE',
          signal: 'BULLISH',
          description: `Price made Lower Low (₹${prev.price.toFixed(2)} → ₹${curr.price.toFixed(2)}) but MACD histogram made Higher Low — institutional accumulation`,
          candle_index: curr.idx,
          strength: Math.abs(curr.price - prev.price) > minPriceDelta * 3 ? 'STRONG' : 'MODERATE',
        });
      }
    }
  }

  // ── MFI Divergences ────────────────────────────────
  if (mfiSeries.length > swingLookback * 2 + 2) {
    const { swingHighs, swingLows } = findSwingPoints(mfiSeries, swingLookback);
    const currentPrice = closes[closes.length - 1];
    const minPriceDelta = currentPrice * 0.003;

    // Bearish MFI Divergence: Price Higher High, MFI Lower High
    for (let i = 1; i < swingHighs.length; i++) {
      const prev = swingHighs[i - 1];
      const curr = swingHighs[i];
      if (curr.price > prev.price + minPriceDelta && curr.value < prev.value) {
        divergences.push({
          type: 'BEARISH_MFI_DIVERGENCE',
          signal: 'BEARISH',
          description: `Price made Higher High but MFI (volume-weighted) made Lower High — smart money exiting`,
          candle_index: curr.idx,
          strength: Math.abs(curr.value - prev.value) > 10 ? 'STRONG' : 'MODERATE',
        });
      }
    }

    // Bullish MFI Divergence: Price Lower Low, MFI Higher Low
    for (let i = 1; i < swingLows.length; i++) {
      const prev = swingLows[i - 1];
      const curr = swingLows[i];
      if (curr.price < prev.price - minPriceDelta && curr.value > prev.value) {
        divergences.push({
          type: 'BULLISH_MFI_DIVERGENCE',
          signal: 'BULLISH',
          description: `Price made Lower Low but MFI (volume-weighted) made Higher Low — smart money accumulating`,
          candle_index: curr.idx,
          strength: Math.abs(curr.value - prev.value) > 10 ? 'STRONG' : 'MODERATE',
        });
      }
    }
  }

  // ── Summary ────────────────────────────────────────
  const bullDiv = divergences.filter(d => d.signal === 'BULLISH');
  const bearDiv = divergences.filter(d => d.signal === 'BEARISH');

  // Only consider recent divergences (last 30% of candles) for active signals
  const recentThreshold = Math.floor(candles.length * 0.7);
  const recentDivergences = divergences.filter(d => d.candle_index >= recentThreshold);
  const recentBull = recentDivergences.filter(d => d.signal === 'BULLISH').length;
  const recentBear = recentDivergences.filter(d => d.signal === 'BEARISH').length;

  let divergenceBias = 'NONE';
  if (recentBull > recentBear) divergenceBias = 'BULLISH_DIVERGENCE_ACTIVE';
  else if (recentBear > recentBull) divergenceBias = 'BEARISH_DIVERGENCE_ACTIVE';

  return {
    divergences: recentDivergences, // only return actionable recent divergences
    all_divergences_count: divergences.length,
    recent_bullish: recentBull,
    recent_bearish: recentBear,
    bias: divergenceBias,
    summary: recentDivergences.length > 0
      ? `${recentDivergences.length} active divergence(s) detected: ${recentBull} bullish, ${recentBear} bearish`
      : 'No active divergences detected',
  };
};

// ─── Support & Resistance (Legacy — kept for backward compat) ──
export const SupportResistance = (candles, lookback = 20) => {
  if (candles.length < lookback) return null;

  const slice = candles.slice(-lookback);
  const highs = getHighs(slice);
  const lows  = getLows(slice);

  const resistance = parseFloat(Math.max(...highs).toFixed(2));
  const support    = parseFloat(Math.min(...lows).toFixed(2));
  const current    = parseFloat(slice[slice.length - 1].CLOSE);
  const range      = parseFloat((resistance - support).toFixed(2));
  const position   = parseFloat(((current - support) / range * 100).toFixed(2));

  return {
    resistance,
    support,
    current,
    range,
    position_pct: position, // 0% = at support, 100% = at resistance
  };
};

// ─── Volume Analysis ─────────────────────────────────────
export const VolumeAnalysis = (candles, period = 20) => {
  if (candles.length < period) return null;

  const volumes = getVolumes(candles);
  const avgVolume = SMA(volumes, period);
  const currentVolume = volumes[volumes.length - 1];
  const volumeRatio = parseFloat((currentVolume / avgVolume).toFixed(2));

  return {
    current:    currentVolume,
    average:    parseFloat(avgVolume.toFixed(2)),
    ratio:      volumeRatio,
    surge:      volumeRatio > 1.5,   // 50% above average
    dry:        volumeRatio < 0.5,   // 50% below average
    trend:      volumeRatio > 1 ? 'HIGH' : 'LOW',
  };
};

// ─── ATR (Average True Range) ────────────────────────────
export const ATR = (candles, period = 14) => {
  if (!candles || candles.length < period + 1) return null;

  // Calculate True Range for each candle starting at index 1
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].HIGH);
    const low = parseFloat(candles[i].LOW);
    const prevClose = parseFloat(candles[i - 1].CLOSE);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);
  }

  if (trValues.length < period) return null;

  // Initial ATR is simple average of first `period` true ranges
  let currentATR = trValues.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

  // Subsequent ATRs use Wilder's exponential smoothing
  for (let i = period; i < trValues.length; i++) {
    currentATR = (currentATR * (period - 1) + trValues[i]) / period;
  }

  const currentPrice = parseFloat(candles[candles.length - 1].CLOSE);
  const atrVal = parseFloat(currentATR.toFixed(2));
  const atrPct = currentPrice > 0 ? parseFloat(((atrVal / currentPrice) * 100).toFixed(2)) : 0;

  // Volatility categorisation relative to candle timeframe
  const volatilityCategory = atrPct > 1.5 ? 'HIGH' : atrPct < 0.5 ? 'LOW' : 'NORMAL';

  return {
    value: atrVal,
    pct: atrPct,
    volatility_category: volatilityCategory,
    stop_distance: parseFloat((atrVal * 1.5).toFixed(2)),
    target_conservative: parseFloat((atrVal * 1.5).toFixed(2)),
    target_extended: parseFloat((atrVal * 2.5).toFixed(2)),
  };
};

// ─── ADX (Average Directional Index with +DI / -DI and Slope) ───
export const ADX = (candles, period = 14) => {
  if (!candles || candles.length < period + 2) return null;

  const trValues = [];
  const plusDMValues = [];
  const minusDMValues = [];

  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i].HIGH);
    const low = parseFloat(candles[i].LOW);
    const prevHigh = parseFloat(candles[i - 1].HIGH);
    const prevLow = parseFloat(candles[i - 1].LOW);
    const prevClose = parseFloat(candles[i - 1].CLOSE);

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trValues.push(tr);

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
    const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;

    plusDMValues.push(plusDM);
    minusDMValues.push(minusDM);
  }

  if (trValues.length < period) return null;

  // Initial sum of first `period` elements
  let smoothTR = trValues.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDMValues.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDMValues.slice(0, period).reduce((a, b) => a + b, 0);

  const dxSeries = [];

  const calcDX = (sTR, sPlus, sMinus) => {
    if (sTR <= 0) return { plusDI: 0, minusDI: 0, dx: 0 };
    const plusDI = (sPlus / sTR) * 100;
    const minusDI = (sMinus / sTR) * 100;
    const sumDI = plusDI + minusDI;
    const diffDI = Math.abs(plusDI - minusDI);
    const dx = sumDI > 0 ? (diffDI / sumDI) * 100 : 0;
    return { plusDI, minusDI, dx };
  };

  dxSeries.push(calcDX(smoothTR, smoothPlusDM, smoothMinusDM));

  // Wilder's smoothing for subsequent TR, +DM, -DM
  for (let i = period; i < trValues.length; i++) {
    smoothTR = smoothTR - (smoothTR / period) + trValues[i];
    smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDMValues[i];
    smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDMValues[i];

    dxSeries.push(calcDX(smoothTR, smoothPlusDM, smoothMinusDM));
  }

  if (dxSeries.length === 0) return null;

  // Calculate ADX from DX series using Wilder's smoothing
  const adxHistory = [];
  const adxPeriod = Math.min(period, dxSeries.length);
  let currentADX = dxSeries.slice(0, adxPeriod).reduce((sum, p) => sum + p.dx, 0) / adxPeriod;
  adxHistory.push(currentADX);

  for (let i = adxPeriod; i < dxSeries.length; i++) {
    currentADX = (currentADX * (period - 1) + dxSeries[i].dx) / period;
    adxHistory.push(currentADX);
  }

  const latestPoint = dxSeries[dxSeries.length - 1];
  const finalADX = parseFloat(currentADX.toFixed(2));
  const finalPlusDI = parseFloat(latestPoint.plusDI.toFixed(2));
  const finalMinusDI = parseFloat(latestPoint.minusDI.toFixed(2));

  // Determine ADX slope (last 3-4 readings)
  let adxSlope = 'FLAT';
  if (adxHistory.length >= 4) {
    const prevADX = adxHistory[adxHistory.length - 4];
    const diff = finalADX - prevADX;
    if (diff > 0.75) adxSlope = 'RISING';
    else if (diff < -0.75) adxSlope = 'FALLING';
  } else if (adxHistory.length >= 2) {
    const prevADX = adxHistory[adxHistory.length - 2];
    const diff = finalADX - prevADX;
    if (diff > 0.5) adxSlope = 'RISING';
    else if (diff < -0.5) adxSlope = 'FALLING';
  }

  // Trend strength & regime classification
  let strength = 'WEAK';
  if (finalADX >= 50) strength = 'EXTREME_TREND';
  else if (finalADX >= 25) strength = 'STRONG_TREND';
  else if (finalADX >= 20) strength = 'DEVELOPING_TRANSITIONAL';
  else strength = 'RANGING_CHOPPY';

  let regime = 'RANGING';
  if (finalADX > 25) {
    regime = finalPlusDI > finalMinusDI ? 'TRENDING_UP' : 'TRENDING_DOWN';
  } else if (finalADX < 20) {
    regime = 'RANGING';
  } else {
    regime = 'TRANSITIONAL';
  }

  return {
    value: finalADX,
    plus_di: finalPlusDI,
    minus_di: finalMinusDI,
    slope: adxSlope,
    strength,
    regime,
    is_trending: finalADX > 25,
    is_ranging: finalADX < 20,
    history: adxHistory.slice(-5).map(v => parseFloat(v.toFixed(2))),
  };
};

// ─── Bollinger Bands Squeeze ─────────────────────────────
export const BollingerBandsSqueeze = (candles, period = 20) => {
  const closes = getCloses(candles);
  if (closes.length < period) return null;

  const bb = BollingerBands(closes, period, 2);
  if (!bb || !bb.middle) return null;

  const currentBandwidth = parseFloat((((bb.upper - bb.lower) / bb.middle) * 100).toFixed(2));

  // Compute past bandwidths to detect contraction
  const pastBandwidths = [];
  const lookback = Math.min(closes.length - period + 1, 30);
  for (let i = 0; i < lookback; i++) {
    const subCloses = closes.slice(0, closes.length - i);
    const subBB = BollingerBands(subCloses, period, 2);
    if (subBB && subBB.middle) {
      pastBandwidths.push(((subBB.upper - subBB.lower) / subBB.middle) * 100);
    }
  }

  const avgBandwidth = pastBandwidths.length > 0
    ? pastBandwidths.reduce((a, b) => a + b, 0) / pastBandwidths.length
    : currentBandwidth;

  const minBandwidth = Math.min(...pastBandwidths);
  // Squeeze is active if bandwidth is within 15% of lowest bandwidth or < 2.5%
  const isSqueeze = (currentBandwidth <= minBandwidth * 1.15) || (currentBandwidth < 2.5);

  return {
    bandwidth: currentBandwidth,
    avg_bandwidth: parseFloat(avgBandwidth.toFixed(2)),
    is_squeeze: isSqueeze,
    status: isSqueeze ? 'SQUEEZE_ACTIVE' : 'EXPANDED',
  };
};

// ─── Indian Market Time-of-Day Filter (IST) ───────────────
export const getTimeOfDayRegime = (date = new Date()) => {
  const istString = date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false });
  const timePart = istString.split(', ')[1];
  const [hStr, mStr] = timePart.split(':');
  const hours = parseInt(hStr, 10);
  const minutes = parseInt(mStr, 10);
  const timeMinutes = hours * 60 + minutes;

  const T_9_15 = 9 * 60 + 15;
  const T_9_30 = 9 * 60 + 30;
  const T_11_30 = 11 * 60 + 30;
  const T_13_00 = 13 * 60;
  const T_14_00 = 14 * 60;
  const T_15_00 = 15 * 60;
  const T_15_30 = 15 * 60 + 30;

  if (timeMinutes < T_9_15 || timeMinutes > T_15_30) {
    return {
      window: 'MARKET_CLOSED',
      label: 'Market Closed',
      action: 'CAUTION_AFTER_HOURS',
      description: 'Outside regular NSE trading hours (9:15 AM - 3:30 PM IST). Signals are for pre/post-market planning.',
      block_signals: false,
    };
  }

  if (timeMinutes >= T_9_15 && timeMinutes < T_9_30) {
    return {
      window: 'CHAOTIC_OPEN',
      label: '9:15 - 9:30 AM (Opening Noise)',
      action: 'BLOCK_OR_EXTREME_CAUTION',
      description: 'Opening volatility and overnight order clearance. Most indicators are unreliable. Avoid fresh market orders.',
      block_signals: true,
    };
  }

  if (timeMinutes >= T_9_30 && timeMinutes < T_11_30) {
    return {
      window: 'MORNING_MOMENTUM',
      label: '9:30 - 11:30 AM (Prime Trend)',
      action: 'TRUST_TREND',
      description: 'Primary institutional trending window. Indicators are highly reliable.',
      block_signals: false,
    };
  }

  if (timeMinutes >= T_11_30 && timeMinutes < T_13_00) {
    return {
      window: 'MIDDAY_CONSOLIDATION',
      label: '11:30 AM - 1:00 PM (Midday Range)',
      action: 'FAVOR_RANGING',
      description: 'European market open anticipation. Often range-bound or consolidating.',
      block_signals: false,
    };
  }

  if (timeMinutes >= T_13_00 && timeMinutes < T_14_00) {
    return {
      window: 'LUNCH_DRIFT',
      label: '1:00 - 2:00 PM (Lunch Drift)',
      action: 'REDUCE_SIZE',
      description: 'Low liquidity and drift zone. Prone to fake breakouts. Reduce position sizing.',
      block_signals: false,
    };
  }

  if (timeMinutes >= T_14_00 && timeMinutes < T_15_00) {
    return {
      window: 'AFTERNOON_TREND',
      label: '2:00 - 3:00 PM (Afternoon Institutional)',
      action: 'TRUST_TREND',
      description: 'Institutional positioning resumes alongside European market trends.',
      block_signals: false,
    };
  }

  return {
    window: 'CLOSING_CHAOS',
    label: '3:00 - 3:30 PM (Closing & Expiry Chaos)',
    action: 'BLOCK_OR_SQUAREOFF',
    description: 'Intraday MIS square-offs, gamma spikes, and expiry chaos. Block new positions.',
    block_signals: true,
  };
};

// ─── Comprehensive Market Regime Detector ─────────────────
export const detectMarketRegime = (candles, indicators = {}, date = new Date()) => {
  const adx = indicators.adx || ADX(candles, 14);
  const pivots = indicators.pivot_levels || PivotLevels(candles);
  const atr = indicators.atr || ATR(candles, 14);
  const bbSqueeze = indicators.bollinger_squeeze || BollingerBandsSqueeze(candles, 20);
  const timeOfDay = getTimeOfDayRegime(date);

  const adxVal = adx?.value ?? 15;
  const isRising = adx?.slope === 'RISING';
  const isSqueeze = bbSqueeze?.is_squeeze || false;
  const isNarrowCPR = pivots?.cpr_type === 'NARROW_CPR';
  const isWideCPR = pivots?.cpr_type === 'WIDE_CPR';

  // 1. Primary Regime (3 Regimes + Transitional)
  let primaryRegime = 'RANGING';
  let trendDirection = 'SIDEWAYS';
  let guidance = '';

  if (adxVal > 25) {
    primaryRegime = 'TRENDING';
    trendDirection = (adx?.plus_di > adx?.minus_di) ? 'UPTREND' : 'DOWNTREND';
    guidance = `Strong ${trendDirection} detected (ADX ${adxVal} > 25). Weight trend-following systems (EMA/VWAP/MACD). DISREGARD RSI overbought/oversold reversal warnings — strong trends stay overbought.`;
  } else if (adxVal < 20 && isRising && (isSqueeze || isNarrowCPR)) {
    primaryRegime = 'BREAKOUT_IMMINENT';
    trendDirection = (adx?.plus_di > adx?.minus_di) ? 'UPWARD_BIAS' : 'DOWNWARD_BIAS';
    guidance = `Volatility compression detected (ADX ${adxVal} < 20 rising, ${isSqueeze ? 'Bollinger Squeeze active' : ''}${isNarrowCPR ? ', Narrow CPR' : ''}). Prepare for explosive directional expansion. Focus on Camarilla H4/L4 triggers.`;
  } else if (adxVal < 20) {
    primaryRegime = 'RANGING';
    trendDirection = 'SIDEWAYS';
    guidance = `Choppy / consolidating market (ADX ${adxVal} < 20). Weight boundary indicators (CPR/Camarilla H3/L3, BB edges, Option Walls). SUPPRESS breakout signals — high whipsaw risk.`;
  } else {
    primaryRegime = 'TRANSITIONAL';
    trendDirection = (adx?.plus_di > adx?.minus_di) ? 'MILD_UPTREND' : 'MILD_DOWNTREND';
    guidance = `Transitional regime (ADX ${adxVal} between 20-25). Trend is forming or fading. Exercise caution with reduced position sizing.`;
  }

  // 2. Dual Confirmation: ADX + CPR Width
  let cprConfirmation = 'NORMAL_CONDITIONS';
  if (adxVal > 25 && isNarrowCPR) {
    cprConfirmation = 'STRONG_TREND_DAY';
  } else if (adxVal < 20 && isWideCPR) {
    cprConfirmation = 'RANGE_DAY_CONFIRMED';
  } else if (adxVal > 25 && isWideCPR) {
    cprConfirmation = 'CONFLICTED_REGIME';
  } else if (adxVal < 20 && isNarrowCPR) {
    cprConfirmation = 'BREAKOUT_BUILDING';
  }

  // 3. Volatility Overlay: ADX Regime + ATR Volatility
  const atrCat = atr?.volatility_category || 'NORMAL';
  let atrVolatilityCross = 'STANDARD_EXECUTION';
  if (primaryRegime === 'TRENDING' && atrCat === 'HIGH') {
    atrVolatilityCross = 'FULL_POSITION_SIZE';
  } else if (primaryRegime === 'TRENDING' && atrCat === 'LOW') {
    atrVolatilityCross = 'REDUCE_SIZE_LOW_MOMENTUM';
  } else if (primaryRegime === 'RANGING' && atrCat === 'HIGH') {
    atrVolatilityCross = 'DANGEROUS_VOLATILE_CHOP';
  } else if (primaryRegime === 'RANGING' && atrCat === 'LOW') {
    atrVolatilityCross = 'SAFE_RANGE_TRADING';
  }

  // 4. Regime-Specific Weight Table
  let weights = {};
  if (primaryRegime === 'TRENDING') {
    weights = {
      ema_vwap: 0.25,
      macd: 0.20,
      camarilla_breakout: 0.15,
      cpr_camarilla_fade: 0.00,
      bollinger_edges: 0.00,
      mfi_divergences: 0.15,
      oi_walls: 0.10,
      volume: 0.15,
    };
  } else if (primaryRegime === 'RANGING') {
    weights = {
      ema_vwap: 0.05,
      macd: 0.05,
      camarilla_breakout: 0.00,
      cpr_camarilla_fade: 0.25,
      bollinger_edges: 0.20,
      mfi_divergences: 0.20,
      oi_walls: 0.20,
      volume: 0.05,
    };
  } else if (primaryRegime === 'BREAKOUT_IMMINENT') {
    weights = {
      ema_vwap: 0.10,
      macd: 0.15,
      camarilla_breakout: 0.30,
      cpr_camarilla_fade: 0.05,
      bollinger_edges: 0.20,
      mfi_divergences: 0.10,
      oi_walls: 0.10,
      volume: 0.00,
    };
  } else {
    // TRANSITIONAL: Blend between trending and ranging
    weights = {
      ema_vwap: 0.15,
      macd: 0.12,
      camarilla_breakout: 0.08,
      cpr_camarilla_fade: 0.15,
      bollinger_edges: 0.10,
      mfi_divergences: 0.18,
      oi_walls: 0.15,
      volume: 0.07,
    };
  }

  return {
    primary_regime: primaryRegime,
    trend_direction: trendDirection,
    adx: adx || null,
    cpr_dual_confirmation: cprConfirmation,
    atr_volatility_cross: atrVolatilityCross,
    time_of_day: timeOfDay,
    weights,
    guidance,
  };
};

// ─── Master: Calculate All Indicators ───────────────────
export const calculateIndicators = (candles) => {
  if (!candles || candles.length < 2) return null;

  const closes  = getCloses(candles);
  const current = parseFloat(candles[candles.length - 1].CLOSE);

  const ema9   = EMA(closes, 9);
  const ema21  = EMA(closes, 21);
  const ema50  = EMA(closes, 50);
  const ema200 = EMA(closes, 200);

  const rsi  = RSI(closes, 14);
  const macd = MACD(closes);
  const bb   = BollingerBands(closes);
  const vwap = VWAP(candles);
  const sr   = SupportResistance(candles);
  const vol  = VolumeAnalysis(candles);
  const atr  = ATR(candles, 14);

  // Phase 3: Institutional indicators
  const vwapBands    = VWAP_Bands(candles);
  const pivotLevels  = PivotLevels(candles);
  const mfi          = MFI(candles, 14);
  const divergences  = detectDivergences(candles, 3);

  // Phase 4: Market Regime Engine
  const adx          = ADX(candles, 14);
  const bbSqueeze    = BollingerBandsSqueeze(candles, 20);
  const marketRegime = detectMarketRegime(candles, {
    adx,
    pivot_levels: pivotLevels,
    atr,
    bollinger_squeeze: bbSqueeze,
  });

  // ─── Trend Direction ──────────────────────────────────
  let trend = 'SIDEWAYS';
  if (ema9 && ema21) {
    if (ema9 > ema21 && current > ema21) trend = 'UPTREND';
    else if (ema9 < ema21 && current < ema21) trend = 'DOWNTREND';
  }

  // ─── RSI Signal ───────────────────────────────────────
  let rsiSignal = 'NEUTRAL';
  if (rsi) {
    if (rsi > 70) rsiSignal = 'OVERBOUGHT';
    else if (rsi < 30) rsiSignal = 'OVERSOLD';
    else if (rsi > 55) rsiSignal = 'BULLISH';
    else if (rsi < 45) rsiSignal = 'BEARISH';
  }

  // ─── Price vs Session VWAP (upgraded) ─────────────────
  let vwapSignal = 'NEUTRAL';
  if (vwapBands) {
    vwapSignal = vwapBands.bias;
  } else if (vwap) {
    if (current > vwap * 1.002) vwapSignal = 'ABOVE_VWAP';
    else if (current < vwap * 0.998) vwapSignal = 'BELOW_VWAP';
  }

  // ─── Bollinger Signal ─────────────────────────────────
  let bbSignal = 'NEUTRAL';
  if (bb) {
    if (current >= bb.upper) bbSignal = 'OVERBOUGHT';
    else if (current <= bb.lower) bbSignal = 'OVERSOLD';
    else if (current > bb.middle) bbSignal = 'UPPER_HALF';
    else bbSignal = 'LOWER_HALF';
  }

  // ─── Institutional Support / Resistance (CPR + Camarilla) ──
  // Upgrade: if pivots available, use them as primary S/R
  let institutionalLevels = null;
  if (pivotLevels) {
    institutionalLevels = {
      primary_support: pivotLevels.L3,
      primary_resistance: pivotLevels.H3,
      breakout_long: pivotLevels.H4,
      breakdown_short: pivotLevels.L4,
      pdh: pivotLevels.PDH,
      pdl: pivotLevels.PDL,
      pivot: pivotLevels.pivot,
      cpr_type: pivotLevels.cpr_type,
    };
  }

  return {
    current_price: current,
    trend,
    ema: { ema9, ema21, ema50, ema200 },
    rsi: { value: rsi, signal: rsiSignal },
    macd,
    bollinger: { ...bb, signal: bbSignal },
    bollinger_squeeze: bbSqueeze,
    vwap: { value: vwapBands?.vwap || vwap, signal: vwapSignal },
    vwap_bands: vwapBands,
    pivot_levels: pivotLevels,
    mfi,
    divergences,
    adx,
    market_regime: marketRegime,
    institutional_levels: institutionalLevels,
    support_resistance: sr,
    volume: vol,
    atr,
  };
};