import YahooFinance from 'yahoo-finance2';

const yahoo = new YahooFinance();

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

/**
 * Helper to fetch NSE JSON data with session cookies handling
 */
const fetchNSE = async (url) => {
  try {
    // Step 1: Hit NSE homepage to set session cookie
    const homeRes = await fetch('https://www.nseindia.com', { headers: NSE_HEADERS });
    const cookies = homeRes.headers.get('set-cookie');

    // Step 2: Fetch target URL with cookie
    const res = await fetch(url, {
      headers: {
        ...NSE_HEADERS,
        'Accept': 'application/json, text/plain, */*',
        'Cookie': cookies || '',
        'Referer': 'https://www.nseindia.com/option-chain',
      },
    });

    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`⚠️ NSE fetch failed for ${url}:`, err.message);
    return null;
  }
};

/**
 * Fetch Free NSE Option Chain & Calculate PCR, Call Wall, Put Wall, Max Pain, ΔOI
 * Call Wall = Strike with maximum Call OI → major resistance ceiling
 * Put Wall  = Strike with maximum Put OI → major support floor
 * Max Pain  = Strike where option sellers lose least (market gravitates here)
 * ΔOI      = Change in Open Interest → reveals Short Covering, Long Liquidation, Fresh Buildup
 */
/**
 * Pure parser for NSE Option Chain JSON data.
 * Computes:
 * - Call Wall, Put Wall, Max Pain
 * - ΔOI Signals (Short Covering, Long Liquidation, Fresh Long Buildup, Fresh Short Buildup)
 * - Top 5 strikes with highest OI buildup (institutional defense hotspots)
 * - Velocity: Fastest Call & Put writing strikes
 * - Zone PCR: Ceiling PCR (above spot) & Floor PCR (below spot)
 */
export const parseNSEOptionChain = (data, symbol = 'NIFTY', priceChange = null) => {
  if (!data || !data.filtered || !data.filtered.data) return null;

  const cleanSym = (symbol || 'NIFTY').toUpperCase().trim();
  // Get underlying spot price from NSE response
  const spotPrice = Number(data.records?.underlyingValue || data.filtered?.CE?.totOI || 0);

  let totalCallVol = 0;
  let totalPutVol = 0;
  let totalCallOI = 0;
  let totalPutOI = 0;

  // ΔOI accumulators
  let totalCallDeltaOI = 0;
  let totalPutDeltaOI = 0;

  // Per-zone OI (above vs below spot) for PCR by strike zone
  let callOI_aboveSpot = 0;
  let putOI_aboveSpot = 0;
  let callOI_belowSpot = 0;
  let putOI_belowSpot = 0;

  // Track per-strike OI for Call Wall, Put Wall, Max Pain
  let maxCallOI = 0;
  let maxPutOI = 0;
  let callWallStrike = null;
  let putWallStrike = null;
  const strikeOIMap = {}; // { strike: { callOI, putOI } }

  // ΔOI per-strike tracking for top movers and buildup velocity
  const strikeDeltas = []; // [ { strike, callOI, putOI, callDelta, putDelta, callVol, putVol } ]

  for (const item of data.filtered.data) {
    const strike = Number(item.strikePrice);
    if (!strikeOIMap[strike]) strikeOIMap[strike] = { callOI: 0, putOI: 0 };

    let callDelta = 0, putDelta = 0;
    let callOI = 0, putOI = 0;
    let callVol = 0, putVol = 0;

    if (item.CE) {
      callOI = Number(item.CE.openInterest || 0);
      callDelta = Number(item.CE.changeinOpenInterest || 0);
      callVol = Number(item.CE.totalTradedVolume || item.CE.totTrdQty || 0);
      totalCallVol += callVol;
      totalCallOI += callOI;
      totalCallDeltaOI += callDelta;
      strikeOIMap[strike].callOI = callOI;

      if (callOI > maxCallOI) {
        maxCallOI = callOI;
        callWallStrike = strike;
      }

      // Zone-based OI
      if (spotPrice > 0) {
        if (strike >= spotPrice) callOI_aboveSpot += callOI;
        else callOI_belowSpot += callOI;
      }
    }
    if (item.PE) {
      putOI = Number(item.PE.openInterest || 0);
      putDelta = Number(item.PE.changeinOpenInterest || 0);
      putVol = Number(item.PE.totalTradedVolume || item.PE.totTrdQty || 0);
      totalPutVol += putVol;
      totalPutOI += putOI;
      totalPutDeltaOI += putDelta;
      strikeOIMap[strike].putOI = putOI;

      if (putOI > maxPutOI) {
        maxPutOI = putOI;
        putWallStrike = strike;
      }

      // Zone-based OI
      if (spotPrice > 0) {
        if (strike >= spotPrice) putOI_aboveSpot += putOI;
        else putOI_belowSpot += putOI;
      }
    }

    strikeDeltas.push({ strike, callOI, putOI, callDelta, putDelta, callVol, putVol });
  }

  // ── Max Pain Calculation ─────────────────────────
  let maxPainStrike = null;
  let minPain = Infinity;
  const strikes = Object.keys(strikeOIMap).map(Number).sort((a, b) => a - b);

  for (const candidateStrike of strikes) {
    let totalPain = 0;
    for (const s of strikes) {
      const oiData = strikeOIMap[s];
      if (s < candidateStrike) {
        totalPain += (candidateStrike - s) * oiData.callOI;
      }
      if (s > candidateStrike) {
        totalPain += (s - candidateStrike) * oiData.putOI;
      }
    }
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = candidateStrike;
    }
  }

  // ── ΔOI Analysis ─────────────────────────────────

  // 1. Top 5 strikes with biggest OI buildup (absolute ΔOI)
  //    Sorted by total absolute change — these are the strikes institutions are defending
  const topOIBuildups = [...strikeDeltas]
    .map(s => ({ ...s, totalAbsDelta: Math.abs(s.callDelta) + Math.abs(s.putDelta) }))
    .filter(s => s.totalAbsDelta > 0)
    .sort((a, b) => b.totalAbsDelta - a.totalAbsDelta)
    .slice(0, 5)
    .map(s => ({
      strike: s.strike,
      call_delta: s.callDelta,
      put_delta: s.putDelta,
      call_oi: s.callOI,
      put_oi: s.putOI,
      activity: s.callDelta > 0 && s.putDelta > 0 ? 'FRESH_BUILDUP_BOTH'
        : s.callDelta > 0 ? 'CALL_WRITING' // Resistance building
        : s.putDelta > 0 ? 'PUT_WRITING'   // Support building
        : s.callDelta < 0 ? 'CALL_UNWINDING'
        : 'PUT_UNWINDING',
    }));

  // 2. ΔOI Signal Classification
  //    Standard 4-Quadrant F&O Interpretation:
  //    - Price Rising + Call OI ↓ + Put OI ↑ = Short Covering (Strong Bullish)
  //    - Price Rising + Call OI ↑ + Put OI ↓ = Fresh Long Buildup (Moderate Bullish)
  //    - Price Falling + Call OI ↑ + Put OI ↓ = Long Liquidation (Strong Bearish)
  //    - Price Falling + Call OI ↓ + Put OI ↑ = Fresh Short Buildup (Moderate Bearish)
  let deltaOISignal = 'NEUTRAL';
  let deltaOIDescription = '';

  const isPriceRising = priceChange !== null ? priceChange > 0 : null;
  const isPriceFalling = priceChange !== null ? priceChange < 0 : null;

  if (totalCallDeltaOI < 0 && totalPutDeltaOI > 0) {
    if (isPriceFalling) {
      deltaOISignal = 'FRESH_SHORT_BUILDUP';
      deltaOIDescription = `Price falling + Call OI dropped (${totalCallDeltaOI.toLocaleString()}) + Put OI added (${totalPutDeltaOI.toLocaleString()}) → Put buying / Short buildup = MODERATE BEARISH`;
    } else {
      deltaOISignal = 'SHORT_COVERING';
      deltaOIDescription = `Call OI dropped by ${Math.abs(totalCallDeltaOI).toLocaleString()} + Put OI added ${totalPutDeltaOI.toLocaleString()} → Shorts closing + Puts building = STRONG BULLISH`;
    }
  } else if (totalCallDeltaOI > 0 && totalPutDeltaOI < 0) {
    if (isPriceRising) {
      deltaOISignal = 'FRESH_LONG_BUILDUP';
      deltaOIDescription = `Price rising + Call OI added (+${totalCallDeltaOI.toLocaleString()}) + Put OI dropped (${totalPutDeltaOI.toLocaleString()}) → Fresh longs expanding = MODERATE BULLISH`;
    } else {
      deltaOISignal = 'LONG_LIQUIDATION';
      deltaOIDescription = `Call OI added ${totalCallDeltaOI.toLocaleString()} + Put OI dropped by ${Math.abs(totalPutDeltaOI).toLocaleString()} → Fresh Call writing + Put unwinding = STRONG BEARISH`;
    }
  } else if (totalCallDeltaOI > 0 && totalPutDeltaOI > 0) {
    // Both adding — check which is stronger
    if (totalPutDeltaOI > totalCallDeltaOI * 1.3) {
      deltaOISignal = 'FRESH_PUT_BUILDUP';
      deltaOIDescription = `Put OI buildup (+${totalPutDeltaOI.toLocaleString()}) outpacing Call OI (+${totalCallDeltaOI.toLocaleString()}) → Institutions building support floor = MODERATE BULLISH`;
    } else if (totalCallDeltaOI > totalPutDeltaOI * 1.3) {
      deltaOISignal = 'FRESH_CALL_WRITING';
      deltaOIDescription = `Call OI buildup (+${totalCallDeltaOI.toLocaleString()}) outpacing Put OI (+${totalPutDeltaOI.toLocaleString()}) → Institutions capping upside = MODERATE BEARISH`;
    } else {
      deltaOISignal = 'RANGE_BOUND';
      deltaOIDescription = `Both Call OI (+${totalCallDeltaOI.toLocaleString()}) and Put OI (+${totalPutDeltaOI.toLocaleString()}) building = Straddle/Strangle territory → SIDEWAYS RANGE`;
    }
  } else if (totalCallDeltaOI < 0 && totalPutDeltaOI < 0) {
    deltaOISignal = 'EXPIRY_UNWINDING';
    deltaOIDescription = `Both Call OI (${totalCallDeltaOI.toLocaleString()}) and Put OI (${totalPutDeltaOI.toLocaleString()}) declining = Positions closing ahead of expiry`;
  }

  // 3. OI PCR by Strike Zone (above/below spot)
  //    Ceiling PCR = Put OI above spot / Call OI above spot → measures ceiling pressure
  //    Floor PCR = Put OI below spot / Call OI below spot → measures floor support
  const ceilingPCR = callOI_aboveSpot > 0 ? Number((putOI_aboveSpot / callOI_aboveSpot).toFixed(2)) : null;
  const floorPCR = callOI_belowSpot > 0 ? Number((putOI_belowSpot / callOI_belowSpot).toFixed(2)) : null;

  let zonePCRSignal = 'NEUTRAL';
  if (ceilingPCR !== null && floorPCR !== null) {
    if (floorPCR > 1.5 && ceilingPCR < 0.8) {
      zonePCRSignal = 'STRONG_SUPPORT_FLOOR'; // Heavy put writing below, light call writing above
    } else if (ceilingPCR > 1.5 && floorPCR < 0.8) {
      zonePCRSignal = 'STRONG_RESISTANCE_CEILING'; // Heavy put writing above (unusual), heavy call below
    } else if (floorPCR > 1.0) {
      zonePCRSignal = 'SUPPORT_ACTIVE';
    } else if (ceilingPCR < 0.5) {
      zonePCRSignal = 'HEAVY_CALL_CEILING';
    }
  }

  // 4. Identify the strike with fastest OI buildup (velocity indicator)
  //    This is where institutions are MOST aggressively defending RIGHT NOW
  const fastestCallWriting = [...strikeDeltas]
    .filter(s => s.callDelta > 0)
    .sort((a, b) => b.callDelta - a.callDelta)[0] || null;

  const fastestPutWriting = [...strikeDeltas]
    .filter(s => s.putDelta > 0)
    .sort((a, b) => b.putDelta - a.putDelta)[0] || null;

  const pcrVolume = totalCallVol > 0 ? Number((totalPutVol / totalCallVol).toFixed(2)) : null;
  const pcrOI = totalCallOI > 0 ? Number((totalPutOI / totalCallOI).toFixed(2)) : null;

  return {
    symbol: cleanSym,
    spotPrice: spotPrice || null,
    totalCallVolume: totalCallVol,
    totalPutVolume: totalPutVol,
    totalCallOI,
    totalPutOI,
    pcrVolume,
    pcrOI,
    pcrSignal: (pcrOI || pcrVolume || 1) > 1.2 ? 'BULLISH' : (pcrOI || pcrVolume || 1) < 0.7 ? 'BEARISH' : 'NEUTRAL',
    // Institutional Defense Walls
    callWall: callWallStrike,
    callWallOI: maxCallOI,
    putWall: putWallStrike,
    putWallOI: maxPutOI,
    maxPain: maxPainStrike,
    // ΔOI (Change in Open Interest)
    deltaOI: {
      totalCallDelta: totalCallDeltaOI,
      totalPutDelta: totalPutDeltaOI,
      signal: deltaOISignal,
      description: deltaOIDescription,
      // Top 5 strikes with highest OI change — institutional defense hotspots
      topBuildups: topOIBuildups,
      // Fastest individual strike buildup — where institutions are defending NOW
      fastestCallWriting: fastestCallWriting ? {
        strike: fastestCallWriting.strike,
        delta: fastestCallWriting.callDelta,
        oi: fastestCallWriting.callOI,
      } : null,
      fastestPutWriting: fastestPutWriting ? {
        strike: fastestPutWriting.strike,
        delta: fastestPutWriting.putDelta,
        oi: fastestPutWriting.putOI,
      } : null,
    },
    // OI PCR by Strike Zone
    zonePCR: {
      ceilingPCR,   // PCR for strikes above spot (measures resistance pressure)
      floorPCR,     // PCR for strikes below spot (measures support strength)
      signal: zonePCRSignal,
    },
  };
};

/**
 * Fetch Free NSE Option Chain & Calculate PCR, Call Wall, Put Wall, Max Pain, ΔOI
 * Call Wall = Strike with maximum Call OI → major resistance ceiling
 * Put Wall  = Strike with maximum Put OI → major support floor
 * Max Pain  = Strike where option sellers lose least (market gravitates here)
 * ΔOI      = Change in Open Interest → reveals Short Covering, Long Liquidation, Fresh Buildup
 */
export const getNSEOptionsPCR = async (symbol = 'NIFTY', priceChange = null) => {
  try {
    let cleanSym = symbol.toUpperCase().trim()
      .replace(/\s+(LTD|LIMITED|CORP|INC)$/gi, '')
      .replace(/[\s\-]/g, '');

    if (cleanSym === 'NIFTY50' || cleanSym === 'NIFTY 50') cleanSym = 'NIFTY';
    if (cleanSym === 'NIFTYBANK' || cleanSym === 'BANKNIFTY') cleanSym = 'BANKNIFTY';

    const isIndex = cleanSym === 'NIFTY' || cleanSym === 'BANKNIFTY' || cleanSym === 'FINNIFTY';
    const endpoint = isIndex
      ? `https://www.nseindia.com/api/option-chain-indices?symbol=${cleanSym}`
      : `https://www.nseindia.com/api/option-chain-equities?symbol=${cleanSym}`;

    const data = await fetchNSE(endpoint);
    if (!data || !data.filtered || !data.filtered.data) return null;

    const parsed = parseNSEOptionChain(data, cleanSym, priceChange);
    if (!parsed) return null;

    console.log(`✅ Loaded NSE Option Chain for ${cleanSym} (PCR OI: ${parsed.pcrOI} | Call Wall: ${parsed.callWall} | Put Wall: ${parsed.putWall} | Max Pain: ${parsed.maxPain} | ΔOI Signal: ${parsed.deltaOI?.signal})`);

    return parsed;
  } catch (err) {
    console.warn(`⚠️ Free NSE PCR fetch failed for ${symbol}:`, err.message);
    return null;
  }
};

/**
 * Fetch FII / DII Institutional Activity Data from NSE
 */
export const getFIIDIIData = async () => {
  try {
    const data = await fetchNSE('https://www.nseindia.com/api/fiidiiTradeReact');
    if (!data || !Array.isArray(data)) return null;

    // Latest FII / DII summary
    const fii = data.find(d => d.category && d.category.includes('FII')) || {};
    const dii = data.find(d => d.category && d.category.includes('DII')) || {};

    const fiiNet = Number(fii.netValue || 0);
    const diiNet = Number(dii.netValue || 0);

    console.log(`✅ Loaded FII/DII Institutional Activity (FII Net: ₹${fiiNet} Cr, DII Net: ₹${diiNet} Cr)`);

    return {
      date: fii.date || new Date().toISOString().split('T')[0],
      fiiNet,
      diiNet,
      smartMoneyBias: (fiiNet + diiNet) > 0 ? 'BULLISH' : (fiiNet + diiNet) < 0 ? 'BEARISH' : 'NEUTRAL',
      summary: `FII Net: ₹${fiiNet} Cr, DII Net: ₹${diiNet} Cr`,
    };
  } catch (err) {
    console.warn('⚠️ Free FII/DII fetch failed:', err.message);
    return null;
  }
};

/**
 * Fetch India VIX (Volatilty Index) via Yahoo Finance or NSE
 */
export const getIndiaVIX = async () => {
  try {
    const quote = await yahoo.quote('^INDIAVIX').catch(() => null);
    if (quote && quote.regularMarketPrice) {
      const vix = Number(quote.regularMarketPrice);
      const change = Number(quote.regularMarketChangePercent || 0);
      const mood = vix > 20 ? 'HIGH_FEAR' : vix < 13 ? 'GREED_COMPLACENCY' : 'NEUTRAL_NORMAL';
      console.log(`✅ Loaded India VIX: ${vix} (${change.toFixed(2)}%, Mood: ${mood})`);
      return { vix, change, mood };
    }
  } catch (err) {
    console.warn('⚠️ India VIX fetch failed:', err.message);
  }
  return { vix: 15.0, change: 0, mood: 'NEUTRAL_NORMAL' };
};
