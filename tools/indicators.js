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

// ─── VWAP ────────────────────────────────────────────────
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

// ─── Support & Resistance ────────────────────────────────
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

  // ─── Price vs VWAP ────────────────────────────────────
  let vwapSignal = 'NEUTRAL';
  if (vwap) {
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

  return {
    current_price: current,
    trend,
    ema: { ema9, ema21, ema50, ema200 },
    rsi: { value: rsi, signal: rsiSignal },
    macd,
    bollinger: { ...bb, signal: bbSignal },
    vwap: { value: vwap, signal: vwapSignal },
    support_resistance: sr,
    volume: vol,
  };
};