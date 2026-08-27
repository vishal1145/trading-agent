/**
 * Finvedas Trading Agent - Content Script
 * Extracts stock / market instrument symbols from popular trading websites or screen context.
 */

// ── Orphan cleanup ─────────────────────────────────────────────────────────
// If a previous content-script context (from before a refresh / extension reload)
// left behind widget DOM nodes, remove them now so we start clean.
(function cleanupOrphanedWidgets() {
  const stale = document.getElementById('finvedas-floating-wrapper');
  if (stale) stale.remove();
  const staleBadge = document.getElementById('finvedas-floating-badge');
  if (staleBadge) staleBadge.remove();
  // Release any stale lock so the new context can initialize freely
  window.__finvedasWidgetLock = false;
})();

// Listener for messages from popup or background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'DETECT_SYMBOL') {
    const symbolInfo = detectInstrumentSymbol();
    symbolInfo.screenLivePrice = detectOnScreenPrice();
    sendResponse(symbolInfo);
  } else if (request.action === 'TOGGLE_FLOATING_WIDGET') {
    // Only the top-level frame should host the floating widget.
    // Guard against edge cases where content.js runs in an iframe (e.g. same-origin iframes).
    if (window !== window.top) { sendResponse({ success: false }); return; }
    let wrapper = document.getElementById('finvedas-floating-wrapper');
    if (!wrapper) {
      initFloatingWidget();
      wrapper = document.getElementById('finvedas-floating-wrapper');
    }
    const badge = document.getElementById('finvedas-floating-badge');
    if (request.open || !wrapper || wrapper.style.display === 'none') {
      if (wrapper) wrapper.style.display = 'flex';
      if (badge) badge.style.display = 'none';
      if (chrome.storage && chrome.storage.local) chrome.storage.local.set({ finvedas_widget_open: true });
    } else {
      if (wrapper) wrapper.style.display = 'none';
      if (badge) badge.style.display = 'none';
      if (chrome.storage && chrome.storage.local) chrome.storage.local.set({ finvedas_widget_open: false });
    }
    sendResponse({ success: true });
  }
});

function detectOnScreenPrice() {
  try {
    // 1. Future Funding: directly query the LTP span by its Tailwind class (most reliable)
    const ltpSpans = document.querySelectorAll('[class*="font-mono"]');
    for (const span of ltpSpans) {
      const spanText = span.innerText || span.textContent || '';
      if (spanText.includes('LTP')) {
        const directMatch = spanText.match(/LTP\s*:\s*₹?\s*([0-9,]{1,8}\.[0-9]{2})/i);
        if (directMatch && directMatch[1]) {
          const p = parseFloat(directMatch[1].replace(/,/g, ''));
          if (p > 5) return p;
        }
      }
    }

    // 2. Check explicit "LTP" text tags (general body scan)
    const headerText = document.body ? document.body.innerText : '';
    const ltpMatch = headerText.match(/LTP\s*:\s*₹?\s*([0-9,]{1,8}\.[0-9]{2})/i);
    if (ltpMatch && ltpMatch[1]) {
      const p = parseFloat(ltpMatch[1].replace(/,/g, ''));
      if (p > 5) return p;
    }

    // 2. Check Groww / TradingView / Zerodha price headers
    const priceEls = document.querySelectorAll('h1 + div, [class*="price"], [class*="Price"], [class*="lrg-text"], [class*="legend-source-value"]');
    for (const el of priceEls) {
      const text = el.innerText || '';
      const match = text.match(/₹?\s*([0-9,]{1,8}\.[0-9]{2})/);
      if (match && match[1]) {
        const p = parseFloat(match[1].replace(/,/g, ''));
        if (p > 5) return p;
      }
    }
    // 3. Search document title e.g. "Muthoot Finance Share Price ₹3,209.00 - Groww"
    const titleMatch = document.title ? document.title.match(/₹?\s*([0-9,]{1,8}\.[0-9]{2})/) : null;
    if (titleMatch && titleMatch[1]) {
      const p = parseFloat(titleMatch[1].replace(/,/g, ''));
      if (p > 5) return p;
    }
    // 4. Search top body text for currency symbol match
    const bodyText = document.body ? document.body.innerText.substring(0, 2000) : '';
    const bodyMatch = bodyText.match(/₹\s*([0-9,]{1,8}\.[0-9]{2})/);
    if (bodyMatch && bodyMatch[1]) {
      const p = parseFloat(bodyMatch[1].replace(/,/g, ''));
      if (p > 5) return p;
    }
  } catch (e) {
    console.warn('Price detection error:', e);
  }
  return null;
}

function detectInstrumentSymbol() {
  const url = window.location.href;
  const hostname = window.location.hostname;

  // 1. Check selected text on screen first
  const selectedText = window.getSelection().toString().trim();
  if (selectedText && selectedText.length >= 2 && selectedText.length <= 40) {
    const cleaned = cleanSymbol(selectedText);
    if (cleaned && isValidSymbol(cleaned)) {
      return { symbol: cleaned, source: 'Selected Text', confidence: 'High' };
    }
  }

  // 2. Future Funding specific detection (multi-strategy, based on actual DOM structure)
  if (hostname.includes('futurefunding.in')) {

    // ── Strategy A: Active watchlist item → full instrument name (MOST RELIABLE) ────
    // The selected watchlist row has inline style containing "surface-hover".
    // The row's title attribute holds the full name e.g. "MARUTI SUZUKI INDIA".
    // A child button has aria-label="View chart for MARUTI" (short ticker — used as fallback).
    // Priority: full name (title) > short ticker (aria-label)
    try {
      const activeRows = document.querySelectorAll('[style*="surface-hover"]');
      for (const row of activeRows) {
        // PRIMARY: full instrument name from the row's title attribute
        const titleAttr = row.getAttribute('title') || '';
        if (titleAttr.length >= 2 && titleAttr.length <= 60) {
          const cleaned = cleanSymbol(titleAttr);
          if (cleaned && isValidSymbol(cleaned)) {
            return { symbol: cleaned, source: 'Active Watchlist', confidence: 'High' };
          }
        }
        // FALLBACK: short ticker from the chart-view button's aria-label
        const chartBtn = row.querySelector('[aria-label*="View chart for"]');
        if (chartBtn) {
          const ariaLabel = chartBtn.getAttribute('aria-label') || '';
          const m = ariaLabel.match(/View chart for\s+(.+)/i);
          if (m && m[1]) {
            const cleaned = cleanSymbol(m[1].trim());
            if (cleaned && isValidSymbol(cleaned)) {
              return { symbol: cleaned, source: 'Active Watchlist Ticker', confidence: 'High' };
            }
          }
        }
      }
    } catch (_) { }

    // ── Strategy B: Order Entry "Symbol" label (right panel) ──────────────────────
    // The order panel has: <label>Symbol</label> + sibling <span>PUNJAB NATIONAL BANK</span>
    // This also reflects the currently active instrument.
    try {
      const labels = document.querySelectorAll('label');
      for (const lbl of labels) {
        if ((lbl.innerText || lbl.textContent || '').trim().toUpperCase() === 'SYMBOL') {
          const parent = lbl.parentElement;
          if (parent) {
            const span = parent.querySelector('span');
            const raw = span ? (span.innerText || span.textContent || '').trim() : '';
            if (raw.length >= 2 && raw.length <= 60) {
              const cleaned = cleanSymbol(raw);
              if (cleaned && isValidSymbol(cleaned)) {
                return { symbol: cleaned, source: 'Order Entry Symbol', confidence: 'High' };
              }
            }
          }
        }
      }
    } catch (_) { }

    // ── Strategy C: Same-origin iframe live location hash ─────────────────────────
    // iframe.contentWindow.location.hash reflects the CURRENT live state of the TV widget
    // (may update when TradingView internally navigates to a new symbol).
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          if (iframe.contentWindow && iframe.contentWindow.location) {
            const liveHash = iframe.contentWindow.location.hash.replace('#', '');
            const liveParams = new URLSearchParams(liveHash);
            const liveSym = liveParams.get('symbol') || liveParams.get('ticker');
            if (liveSym) {
              const parsed = extractTickerFromExchange(liveSym);
              if (parsed && isValidSymbol(parsed)) {
                return { symbol: parsed, source: 'TV iframe Live', confidence: 'High' };
              }
            }
          }
        } catch (_) { /* cross-origin iframe — skip */ }
      }
    } catch (_) { }

    // ── Strategy D: iframe src hash (initial-load fallback) ───────────────────────
    // The iframe src at load time contains #symbol=PNB in the hash fragment.
    // This is static after load but correctly reflects the initial chart symbol.
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        const src = iframe.src || '';
        if (!src) continue;
        try {
          const iframeUrl = new URL(src);
          const hashStr = iframeUrl.hash.replace('#', '');
          const hashParams = new URLSearchParams(hashStr);
          const hashSym = hashParams.get('symbol') || hashParams.get('ticker');
          if (hashSym) {
            const parsed = extractTickerFromExchange(hashSym);
            if (parsed && isValidSymbol(parsed)) {
              return { symbol: parsed, source: 'TV iframe Hash', confidence: 'High' };
            }
          }
        } catch (_) { }
      }
    } catch (_) { }
  }

  // 2. Universal Chart Legend & TradingView Detection (Runs on ANY domain / iframe)
  const tvDesc = document.querySelector('[class*="legend-source-description"]') || document.querySelector('[class*="legendDescription"]');
  if (tvDesc && tvDesc.innerText && tvDesc.innerText.trim().length > 2) {
    const parsed = extractTickerFromExchange(tvDesc.innerText);
    if (parsed && parsed.length >= 2) return { symbol: parsed, source: 'Chart Legend', confidence: 'High' };
  }

  const tvHeader = document.querySelector('[class*="legend-source-title"]') ||
    document.querySelector('#header-toolbar-symbol-search') ||
    document.querySelector('[data-name="legend-source-title"]') ||
    document.querySelector('[class*="legend-"] [class*="title-"]') ||
    document.querySelector('[class*="legendTitle"]');
  if (tvHeader && tvHeader.innerText) {
    const parsed = extractTickerFromExchange(tvHeader.innerText);
    if (parsed && parsed.length >= 2) return { symbol: parsed, source: 'Chart Legend', confidence: 'High' };
  }

  // Scan active UI tab buttons, header titles, active instrument items on custom trading portals
  const activeEls = document.querySelectorAll('[class*="active"] [class*="symbol"], [class*="active"] [class*="name"], [class*="tab"][class*="active"], [class*="symbol-name"], [class*="instrument-name"]');
  for (const el of activeEls) {
    if (el.innerText) {
      const cleaned = cleanSymbol(el.innerText);
      if (cleaned && isValidSymbol(cleaned) && cleaned.length <= 40) {
        return { symbol: cleaned, source: 'Active Symbol Tab', confidence: 'High' };
      }
    }
  }

  // Scan URL parameter e.g. symbol=NSE:RELIANCE or symbol=BSE:TATAMOTORS
  const urlParams = new URLSearchParams(window.location.search);
  const urlSymbol = urlParams.get('symbol');
  if (urlSymbol) {
    const parsed = extractTickerFromExchange(urlSymbol);
    if (parsed) return { symbol: parsed, source: 'URL Symbol', confidence: 'High' };
  }

  // Scan visible text on page for "SYMBOL · TIMEFRAME · EXCHANGE" (e.g. STATE BANK OF INDIA · 15 · NSE)
  const bodyText = document.body ? document.body.innerText : '';
  const chartLegendMatch = bodyText.match(/([A-Z0-9\s]{2,30})\s*·\s*(\d+[mhd]?|day|week)\s*·\s*(NSE|BSE|MCX|NASDAQ|NYSE)/i);
  if (chartLegendMatch && chartLegendMatch[1]) {
    const cleaned = cleanSymbol(chartLegendMatch[1]);
    if (cleaned && cleaned.length >= 2) return { symbol: cleaned, source: 'Chart Legend Pattern', confidence: 'High' };
  }

  // 3. Zerodha Kite Detection
  if (hostname.includes('kite.zerodha.com')) {
    const kiteSymbol = document.querySelector('.instrument-name') ||
      document.querySelector('.tradingsymbol') ||
      document.querySelector('.nice-name');
    if (kiteSymbol && kiteSymbol.innerText) {
      const cleaned = cleanSymbol(kiteSymbol.innerText);
      if (cleaned) return { symbol: cleaned, source: 'Zerodha Kite', confidence: 'High' };
    }
  }

  // 4. Groww Detection
  if (hostname.includes('groww.in')) {
    // Check ticker code element e.g. "LTFOODS · NSE"
    const bodyText = document.body ? document.body.innerText : '';
    const tickerMatch = bodyText.match(/([A-Z0-9]{3,15})\s*·\s*(NSE|BSE)/i);
    if (tickerMatch && tickerMatch[1]) {
      return { symbol: tickerMatch[1].toUpperCase(), source: 'Groww Ticker Tag', confidence: 'High' };
    }

    // Check Groww URL path e.g. groww.in/stocks/lt-foods-ltd or groww.in/stocks/bajaj-hindusthan-sugar-ltd
    const growwUrlMatch = url.match(/\/stocks\/([a-z0-9\-]+)/i);
    if (growwUrlMatch && growwUrlMatch[1]) {
      let rawSlug = growwUrlMatch[1].replace(/-ltd$/i, '').replace(/-ltd-/i, '-');
      const cleanedSlug = cleanSymbol(rawSlug.replace(/-/g, ' '));
      if (cleanedSlug) return { symbol: cleanedSlug, source: 'Groww URL', confidence: 'High' };
    }

    const growwHeader = document.querySelector('h1') || document.querySelector('.us-title');
    if (growwHeader && growwHeader.innerText) {
      const cleaned = cleanSymbol(growwHeader.innerText);
      if (cleaned) return { symbol: cleaned, source: 'Groww Page', confidence: 'High' };
    }
  }

  // 5. Yahoo Finance Detection
  if (hostname.includes('finance.yahoo.com')) {
    // e.g. /quote/RELIANCE.NS
    const match = url.match(/\/quote\/([A-Za-z0-9%_\-\.]+)/);
    if (match && match[1]) {
      const raw = match[1].split('.')[0];
      const cleaned = cleanSymbol(raw);
      if (cleaned) return { symbol: cleaned, source: 'Yahoo Finance URL', confidence: 'High' };
    }
    const yahooTitle = document.querySelector('h1[class*="yf-"]');
    if (yahooTitle && yahooTitle.innerText) {
      const cleaned = cleanSymbol(yahooTitle.innerText);
      if (cleaned) return { symbol: cleaned, source: 'Yahoo Finance Title', confidence: 'Medium' };
    }
  }

  // 6. Google Finance Detection
  if (hostname.includes('google.com/finance')) {
    const match = url.match(/\/quote\/([A-Za-z0-9_\-\.]+):([A-Za-z0-9_\-\.]+)/);
    if (match && match[1]) {
      const cleaned = cleanSymbol(match[1]);
      if (cleaned) return { symbol: cleaned, source: 'Google Finance URL', confidence: 'High' };
    }
    const gTitle = document.querySelector('h1') || document.querySelector('.appbar-snippet-primary-title');
    if (gTitle && gTitle.innerText) {
      const cleaned = cleanSymbol(gTitle.innerText);
      if (cleaned) return { symbol: cleaned, source: 'Google Finance Header', confidence: 'Medium' };
    }
  }

  // 7. Moneycontrol Detection
  if (hostname.includes('moneycontrol.com')) {
    const mcHeader = document.querySelector('#stockname') || document.querySelector('.comp_name');
    if (mcHeader && mcHeader.innerText) {
      const cleaned = cleanSymbol(mcHeader.innerText);
      if (cleaned) return { symbol: cleaned, source: 'Moneycontrol Header', confidence: 'Medium' };
    }
  }

  // 8. General Document Title Fallback Regex Matching
  const title = document.title;
  const popularIndexMatch = title.match(/(NIFTY\s*50|BANKNIFTY|FINNIFTY|MIDCPNIFTY|SENSEX)/i);
  if (popularIndexMatch) {
    return { symbol: popularIndexMatch[1].toUpperCase(), source: 'Page Title Index Match', confidence: 'Medium' };
  }

  // Stock ticker pattern search in page title (e.g. "RELIANCE Share Price", "TCS Stock Chart")
  const stockMatch = title.match(/\b([A-Z]{3,12})\b/);
  if (stockMatch) {
    const potential = stockMatch[1].toUpperCase();
    const blacklist = ['SHARE', 'STOCK', 'PRICE', 'CHART', 'BUY', 'SELL', 'HOME', 'TODAY', 'LIVE', 'NEWS'];
    if (!blacklist.includes(potential)) {
      return { symbol: potential, source: 'Page Title Parsing', confidence: 'Low' };
    }
  }

  // Default fallback
  return { symbol: 'NIFTY 50', source: 'Default Fallback', confidence: 'Low' };
}

/**
 * UI garbage terms that must NEVER be treated as instrument symbols.
 * These come from keyboard shortcuts, search placeholders, navigation labels,
 * and other non-financial DOM text that the regex detectors can accidentally match.
 */
const UI_GARBAGE_BLOCKLIST = new Set([
  // Keyboard shortcut labels (the primary offender)
  'CTRL', 'CTRL K', 'CTRL F', 'CTRL L', 'CTRL S', 'CTRL Z', 'CTRL C', 'CTRL V',
  'CMD', 'CMD K', 'CMD F', 'ALT', 'ESC', 'TAB', 'META',
  // Search / navigation UI labels
  'SEARCH', 'SEARCH INSTRUMENTS', 'SEARCH STOCKS', 'FIND', 'TYPE TO SEARCH',
  'HOME', 'BACK', 'NEXT', 'PREV', 'CLOSE', 'OPEN', 'MENU', 'MORE', 'LESS',
  // Generic page text
  'SHARE', 'STOCK', 'PRICE', 'CHART', 'BUY', 'SELL', 'TODAY', 'LIVE', 'NEWS',
  'MARKET', 'WATCH', 'TRADE', 'LOGIN', 'SIGNUP', 'LOGOUT', 'PROFILE', 'SETTINGS',
  'INDICES', 'WATCHLIST', 'PORTFOLIO', 'ORDERS', 'POSITIONS', 'FUNDS',
  'PENDING', 'CANCELLED', 'CLOSED', 'OPTION', 'CHAIN', 'EQUITY', 'REALIZED',
  'UNREALIZED', 'PERFORMANCE', 'PROFITABLE', 'OPEN POSITIONS',
  // Single non-meaningful letters / tokens that slip through
  'K', 'M', 'B', 'S', 'A', 'E', 'I', 'O', 'U',
  // Broker / platform brand names that are not tradable instruments
  'NSE', 'BSE', 'MCX', 'NASDAQ', 'NYSE', 'NIFTY', 'SENSEX',
]);

/**
 * Returns true if the cleaned text is a plausible instrument name,
 * i.e. it is NOT a UI garbage term and meets basic length requirements.
 */
function isValidSymbol(cleaned) {
  if (!cleaned || cleaned.length < 2 || cleaned.length > 40) return false;
  // Reject if it exactly matches a blocklisted UI term
  if (UI_GARBAGE_BLOCKLIST.has(cleaned)) return false;
  // Reject if it starts with "CTRL", "CMD", "ALT" (catches "CTRL K", "CMD L", etc.)
  if (/^(CTRL|CMD|ALT|ESC|TAB|META)\b/i.test(cleaned)) return false;
  // Must contain at least one letter (reject pure numbers / symbols)
  if (!/[A-Za-z]/.test(cleaned)) return false;
  return true;
}

/**
 * Clean & normalize extracted raw text into ticker format
 */
function cleanSymbol(text) {
  if (!text) return '';
  // Remove exchange prefix like NSE: or BSE: or NASDAQ:
  let cleaned = text.replace(/^(NSE|BSE|NASDAQ|NYSE|MCX):/i, '').trim();
  // Remove extra words like "Ltd", "Limited", "Share Price", "Inc", etc.
  cleaned = cleaned.replace(/\s+(Ltd\.?|Limited|Share Price|Inc\.?|Corp\.?|Corporation).*$/i, '');
  // Clean special characters except space or hyphen
  cleaned = cleaned.replace(/[^A-Za-z0-9\s\-]/g, '').trim();
  // Upper case
  cleaned = cleaned.toUpperCase();
  // Return empty string if this is a known UI garbage term
  if (!isValidSymbol(cleaned)) return '';
  return cleaned;
}

function extractTickerFromExchange(raw) {
  if (!raw) return '';
  let text = raw.trim();

  // Handle "STATE BANK OF INDIA · 15 · NSE" or "SBIN · 15m · NSE"
  if (text.includes('·') || text.includes('•')) {
    const parts = text.split(/[·•]/);
    text = parts[0].trim();
  }

  // Handle "NSE:SBIN" or "BSE:TATAMOTORS"
  if (text.includes(':')) {
    const parts = text.split(':');
    text = parts.length > 1 ? parts[1] : parts[0];
  }

  return cleanSymbol(text);
}

// ─── Floating & Draggable Widget Injection ────────────────
function initFloatingWidget() {
  // Guard 1: DOM check — widget already in page
  if (document.getElementById('finvedas-floating-wrapper')) return;
  // Guard 2: window-level mutex — prevents race condition when two script
  // contexts (old + new after extension reload) both pass Guard 1 simultaneously
  if (window.__finvedasWidgetLock) return;
  window.__finvedasWidgetLock = true;

  // Create Wrapper Container
  const wrapper = document.createElement('div');
  wrapper.id = 'finvedas-floating-wrapper';
  wrapper.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    width: 380px;
    height: 380px;
    min-width: 300px;
    min-height: 320px;
    z-index: 9999999;
    border-radius: 14px;
    background: #0f172a;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: system-ui, -apple-system, sans-serif;
    transition: transform 0.15s ease, opacity 0.15s ease;
  `;

  // Header Drag Bar
  const dragBar = document.createElement('div');
  dragBar.id = 'finvedas-drag-bar';
  dragBar.style.cssText = `
    padding: 8px 12px;
    background: linear-gradient(135deg, #1e293b, #0f172a);
    color: #ffffff;
    font-weight: 600;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: move;
    user-select: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  `;
  dragBar.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px;">
      <span style="font-size: 13px; font-weight: 700; color: #f8fafc; letter-spacing: -0.2px;">Trading Agent</span>
    </div>
    <div style="display: flex; gap: 6px; align-items: center;">
      <input type="range" id="finvedas-opacity-slider" min="0.2" max="1" step="0.05" value="1" title="Adjust Transparency" style="width: 110px; height: 4px; margin-right: 8px; cursor: pointer; accent-color: #6366f1;">
      <button id="finvedas-min-btn" title="Minimize" style="background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.1); color: #cbd5e1; cursor: pointer; font-size: 13px; width: 26px; height: 26px; border-radius: 6px; display: flex; align-items: center; justify-content: center; line-height: 1; outline: none;">─</button>
      <button id="finvedas-close-btn" title="Close" style="background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.1); color: #cbd5e1; cursor: pointer; font-size: 13px; width: 26px; height: 26px; border-radius: 6px; display: flex; align-items: center; justify-content: center; line-height: 1; outline: none;">✕</button>
    </div>
  `;

  // Iframe for Extension UI
  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('popup.html');
  iframe.style.cssText = `
    width: 100%;
    height: calc(100% - 40px);
    border: none;
    background: transparent;
  `;

  // Invisible edge overlay strips for resizing
  const EDGE = 6; // px thick
  const edges = [
    { id: 'r', style: `right:0;top:${EDGE}px;width:${EDGE}px;height:calc(100% - ${EDGE * 2}px);cursor:e-resize;`, dir: { r: true } },
    { id: 'b', style: `bottom:0;left:${EDGE}px;width:calc(100% - ${EDGE * 2}px);height:${EDGE}px;cursor:s-resize;`, dir: { b: true } },
    { id: 'se', style: `right:0;bottom:0;width:${EDGE * 2}px;height:${EDGE * 2}px;cursor:se-resize;`, dir: { r: true, b: true } },
    { id: 'sw', style: `left:0;bottom:0;width:${EDGE * 2}px;height:${EDGE * 2}px;cursor:sw-resize;`, dir: { l: true, b: true } },
    { id: 'l', style: `left:0;top:${EDGE}px;width:${EDGE}px;height:calc(100% - ${EDGE * 2}px);cursor:w-resize;`, dir: { l: true } },
  ];

  const edgeEls = edges.map(({ id, style, dir }) => {
    const el = document.createElement('div');
    el.dataset.resizeDir = JSON.stringify(dir);
    el.style.cssText = `position:absolute;${style}z-index:10000000;`;
    wrapper.appendChild(el);
    return el;
  });

  wrapper.appendChild(dragBar);
  wrapper.appendChild(iframe);
  document.body.appendChild(wrapper);

  // Trigger Badge Button (Shown when minimized)
  const badge = document.createElement('div');
  badge.id = 'finvedas-floating-badge';
  badge.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 9999999;
    padding: 10px 16px;
    background: linear-gradient(135deg, #6366f1, #4f46e5);
    color: white;
    font-weight: 600;
    font-size: 13px;
    border-radius: 30px;
    box-shadow: 0 8px 24px rgba(99, 102, 241, 0.4);
    cursor: pointer;
    display: none;
    align-items: center;
    gap: 8px;
    font-family: system-ui, -apple-system, sans-serif;
  `;
  badge.innerHTML = `<span>Trading Agent</span>`;
  document.body.appendChild(badge);

  // Restore Saved Position & Opacity
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['finvedas_pos_top', 'finvedas_pos_left', 'finvedas_minimized', 'finvedas_opacity', 'finvedas_width', 'finvedas_height', 'finvedas_badge_top', 'finvedas_badge_left'], (res) => {
      if (res.finvedas_pos_top && res.finvedas_pos_left) {
        wrapper.style.top = res.finvedas_pos_top;
        wrapper.style.left = res.finvedas_pos_left;
        wrapper.style.right = 'auto';
      }
      if (res.finvedas_width) wrapper.style.width = res.finvedas_width;
      if (res.finvedas_height) wrapper.style.height = res.finvedas_height;
      if (res.finvedas_badge_top && res.finvedas_badge_left) {
        badge.style.top = res.finvedas_badge_top;
        badge.style.left = res.finvedas_badge_left;
        badge.style.right = 'auto';
        badge.style.bottom = 'auto';
      }
      if (res.finvedas_minimized) {
        wrapper.style.display = 'none';
        badge.style.display = 'flex';
      }
      if (res.finvedas_opacity) {
        wrapper.style.opacity = res.finvedas_opacity;
        const opacitySlider = document.getElementById('finvedas-opacity-slider');
        if (opacitySlider) opacitySlider.value = res.finvedas_opacity;
      }
    });
  }

  // Opacity Slider Logic
  const opacitySlider = document.getElementById('finvedas-opacity-slider');
  if (opacitySlider) {
    opacitySlider.addEventListener('input', (e) => {
      wrapper.style.opacity = e.target.value;
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ finvedas_opacity: e.target.value });
      }
    });
    // Prevent drag when interacting with slider
    opacitySlider.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  // Drag Logic
  let isDragging = false;
  let isResizing = false;
  let isBadgeDragging = false;
  let wasBadgeDragged = false;
  let badgeOffsetX = 0;
  let badgeOffsetY = 0;
  let badgeStartX = 0;
  let badgeStartY = 0;
  let resizeDir = {};
  let offsetX = 0;
  let offsetY = 0;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;
  let resizeStartLeft = 0;

  dragBar.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
    isDragging = true;
    offsetX = e.clientX - wrapper.getBoundingClientRect().left;
    offsetY = e.clientY - wrapper.getBoundingClientRect().top;
    dragBar.style.cursor = 'grabbing';
  });

  // Edge strip resize logic
  edgeEls.forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isResizing = true;
      resizeDir = JSON.parse(el.dataset.resizeDir);
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      resizeStartW = wrapper.offsetWidth;
      resizeStartH = wrapper.offsetHeight;
      resizeStartLeft = wrapper.getBoundingClientRect().left;
      iframe.style.pointerEvents = 'none';
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      wrapper.style.left = `${e.clientX - offsetX}px`;
      wrapper.style.top = `${e.clientY - offsetY}px`;
      wrapper.style.right = 'auto';
    }
    if (isResizing) {
      const dx = e.clientX - resizeStartX;
      const dy = e.clientY - resizeStartY;
      if (resizeDir.r) {
        wrapper.style.width = `${Math.max(300, resizeStartW + dx)}px`;
      }
      if (resizeDir.l) {
        const newW = Math.max(300, resizeStartW - dx);
        wrapper.style.width = `${newW}px`;
        wrapper.style.left = `${resizeStartLeft + (resizeStartW - newW)}px`;
        wrapper.style.right = 'auto';
      }
      if (resizeDir.b) {
        wrapper.style.height = `${Math.max(320, resizeStartH + dy)}px`;
      }
    }
    if (isBadgeDragging) {
      const dx = Math.abs(e.clientX - badgeStartX);
      const dy = Math.abs(e.clientY - badgeStartY);
      if (dx > 4 || dy > 4) {
        wasBadgeDragged = true;
      }
      badge.style.left = `${e.clientX - badgeOffsetX}px`;
      badge.style.top = `${e.clientY - badgeOffsetY}px`;
      badge.style.right = 'auto';
      badge.style.bottom = 'auto';
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      dragBar.style.cursor = 'move';
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          finvedas_pos_top: wrapper.style.top,
          finvedas_pos_left: wrapper.style.left
        });
      }
    }
    if (isResizing) {
      isResizing = false;
      resizeDir = {};
      iframe.style.pointerEvents = '';
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          finvedas_width: wrapper.style.width,
          finvedas_height: wrapper.style.height
        });
      }
    }
    if (isBadgeDragging) {
      isBadgeDragging = false;
      if (wasBadgeDragged) {
        if (chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({
            finvedas_badge_top: badge.style.top,
            finvedas_badge_left: badge.style.left
          });
        }
      }
    }
  });

  // Minimize Handler
  document.getElementById('finvedas-min-btn').addEventListener('click', () => {
    wrapper.style.display = 'none';
    badge.style.display = 'flex';
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ finvedas_minimized: true });
    }
  });

  // Close Handler
  document.getElementById('finvedas-close-btn').addEventListener('click', () => {
    wrapper.style.display = 'none';
    badge.style.display = 'flex';
  });

  // Badge Click Handler (Restore)
  badge.addEventListener('mousedown', (e) => {
    isBadgeDragging = true;
    wasBadgeDragged = false;
    badgeStartX = e.clientX;
    badgeStartY = e.clientY;
    const rect = badge.getBoundingClientRect();
    badgeOffsetX = e.clientX - rect.left;
    badgeOffsetY = e.clientY - rect.top;
  });

  badge.addEventListener('click', (e) => {
    if (wasBadgeDragged) {
      e.preventDefault();
      e.stopPropagation();
      wasBadgeDragged = false;
      return;
    }
    wrapper.style.display = 'flex';
    badge.style.display = 'none';
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ finvedas_minimized: false });
    }
  });

  // Dynamic Resize Handler
  window.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'RESIZE_WIDGET') {
      const targetHeight = event.data.height + 40; // 40px for dragBar
      const maxHeight = window.innerHeight - 40; // Keep within window bounds
      const newHeight = Math.min(targetHeight, Math.max(380, maxHeight));
      wrapper.style.height = `${newHeight}px`;
    }
  });
}

// Automatically background-scan current frame and sync high-confidence symbol to storage
function autoScanAndStore() {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
    const symbolInfo = detectInstrumentSymbol();
    if (symbolInfo && symbolInfo.confidence !== 'Low') {
      symbolInfo.screenLivePrice = detectOnScreenPrice();
      chrome.runtime.sendMessage({ action: 'UPDATE_TAB_SYMBOL', symbolInfo }).catch(() => { });
    }
  } catch (e) { }
}

// Only run auto-scan in the main page frame, NOT in child iframes (e.g. TradingView)
if (window === window.top) {
  setInterval(autoScanAndStore, 1500);
  autoScanAndStore();
}

/**
 * DEBUG HELPER — run window.finvedasDebug() in the browser console
 * on trial.futurefunding.in to reveal iframes, DOM elements, and detection result.
 */
window.finvedasDebug = function () {
  console.group('%c[Finvedas Debug]', 'color:#6366f1;font-weight:bold');

  // 1. Show all iframes and their src
  const iframes = document.querySelectorAll('iframe');
  console.log(`Iframes found: ${iframes.length}`);
  iframes.forEach((f, i) => console.log(`  iframe[${i}] src:`, f.src || f.getAttribute('src') || '(empty)'));

  // 2. Show current detection result
  const result = detectInstrumentSymbol();
  console.log('Detection result:', result);

  // 3. Show body text first 500 chars
  console.log('Body text (first 500):', document.body ? document.body.innerText.substring(0, 500) : '(none)');

  // 4. Show page title
  console.log('Page title:', document.title);

  // 5. Show all elements with "symbol" or "ticker" in class
  const symEls = document.querySelectorAll('[class*="symbol"],[class*="ticker"],[class*="instrument"]');
  console.log(`Elements with symbol/ticker/instrument class: ${symEls.length}`);
  symEls.forEach((el, i) => {
    if (i < 20) console.log(`  [${i}] class="${el.className}" text="${(el.innerText || '').substring(0, 60)}"`);
  });

  console.groupEnd();
  return result;
};




