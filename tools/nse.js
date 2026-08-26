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
 * Fetch Free NSE Option Chain & Calculate PCR (Put/Call Ratio)
 */
export const getNSEOptionsPCR = async (symbol = 'NIFTY') => {
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

    let totalCallVol = 0;
    let totalPutVol = 0;
    let totalCallOI = 0;
    let totalPutOI = 0;

    for (const item of data.filtered.data) {
      if (item.CE) {
        totalCallVol += Number(item.CE.totTrdQty || 0);
        totalCallOI += Number(item.CE.openInterest || 0);
      }
      if (item.PE) {
        totalPutVol += Number(item.PE.totTrdQty || 0);
        totalPutOI += Number(item.PE.openInterest || 0);
      }
    }

    const pcrVolume = totalCallVol > 0 ? Number((totalPutVol / totalCallVol).toFixed(2)) : null;
    const pcrOI = totalCallOI > 0 ? Number((totalPutOI / totalCallOI).toFixed(2)) : null;

    console.log(`✅ Loaded NSE Option Chain for ${cleanSym} (PCR Vol: ${pcrVolume}, PCR OI: ${pcrOI})`);

    return {
      symbol: cleanSym,
      totalCallVolume: totalCallVol,
      totalPutVolume: totalPutVol,
      totalCallOI,
      totalPutOI,
      pcrVolume,
      pcrOI,
      pcrSignal: (pcrOI || pcrVolume || 1) > 1.2 ? 'BULLISH' : (pcrOI || pcrVolume || 1) < 0.7 ? 'BEARISH' : 'NEUTRAL',
    };
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
