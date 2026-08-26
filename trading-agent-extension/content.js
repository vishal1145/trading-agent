/**
 * Finvedas Trading Agent - Content Script
 * Extracts stock / market instrument symbols from popular trading websites or screen context.
 */

// Listener for messages from popup or background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'DETECT_SYMBOL') {
    const symbolInfo = detectInstrumentSymbol();
    symbolInfo.screenLivePrice = detectOnScreenPrice();
    sendResponse(symbolInfo);
  } else if (request.action === 'TOGGLE_FLOATING_WIDGET') {
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
    // 1. Check Groww / TradingView / Zerodha price headers
    const priceEls = document.querySelectorAll('h1 + div, [class*="price"], [class*="Price"], [class*="lrg-text"], [class*="legend-source-value"]');
    for (const el of priceEls) {
      const text = el.innerText || '';
      const match = text.match(/₹?\s*([0-9,]{1,8}\.[0-9]{2})/);
      if (match && match[1]) {
        const p = parseFloat(match[1].replace(/,/g, ''));
        if (p > 5) return p;
      }
    }
    // 2. Search document title e.g. "Muthoot Finance Share Price ₹3,209.00 - Groww"
    const titleMatch = document.title ? document.title.match(/₹?\s*([0-9,]{1,8}\.[0-9]{2})/) : null;
    if (titleMatch && titleMatch[1]) {
      const p = parseFloat(titleMatch[1].replace(/,/g, ''));
      if (p > 5) return p;
    }
    // 3. Search top body text for currency symbol match
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
  if (selectedText && selectedText.length >= 2 && selectedText.length <= 15) {
    const cleaned = cleanSymbol(selectedText);
    if (cleaned) {
      return { symbol: cleaned, source: 'Selected Text', confidence: 'High' };
    }
  }

  // 2. Universal Chart Legend & TradingView Detection (Runs on ANY domain / iframe)
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
      if (cleaned && cleaned.length >= 2 && cleaned.length <= 25) {
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
  if (document.getElementById('finvedas-floating-wrapper')) return;

  // Create Wrapper Container
  const wrapper = document.createElement('div');
  wrapper.id = 'finvedas-floating-wrapper';
  wrapper.style.cssText = `
    position: fixed;
    top: 80px;
    right: 20px;
    width: 380px;
    height: 600px;
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
      <span style="color: #6366f1; font-weight: 800; font-size: 14px;">⚡</span>
      <span style="font-size: 13px; font-weight: 700; color: #f8fafc; letter-spacing: -0.2px;">Finvedas AI Agent</span>
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
  badge.innerHTML = `<span>⚡</span><span>Finvedas AI</span>`;
  document.body.appendChild(badge);

  // Restore Saved Position & Opacity
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['finvedas_pos_top', 'finvedas_pos_left', 'finvedas_minimized', 'finvedas_opacity'], (res) => {
      if (res.finvedas_pos_top && res.finvedas_pos_left) {
        wrapper.style.top = res.finvedas_pos_top;
        wrapper.style.left = res.finvedas_pos_left;
        wrapper.style.right = 'auto';
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
  let offsetX = 0;
  let offsetY = 0;

  dragBar.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
    isDragging = true;
    offsetX = e.clientX - wrapper.getBoundingClientRect().left;
    offsetY = e.clientY - wrapper.getBoundingClientRect().top;
    dragBar.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const newLeft = `${e.clientX - offsetX}px`;
    const newTop = `${e.clientY - offsetY}px`;
    wrapper.style.left = newLeft;
    wrapper.style.top = newTop;
    wrapper.style.right = 'auto';
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
  badge.addEventListener('click', () => {
    wrapper.style.display = 'flex';
    badge.style.display = 'none';
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ finvedas_minimized: false });
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
      chrome.runtime.sendMessage({ action: 'UPDATE_TAB_SYMBOL', symbolInfo }).catch(() => {});
    }
  } catch (e) {}
}

setInterval(autoScanAndStore, 1500);
autoScanAndStore();



