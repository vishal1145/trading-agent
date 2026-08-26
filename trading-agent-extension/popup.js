/**
 * Finvedas Trading Agent - Extension Popup Controller
 */

const API_BASE_URL = 'http://localhost:3000';

let selectedTimeframe = '1_hour';
let selectedLookbackDays = 30;

document.addEventListener('DOMContentLoaded', () => {
  initHealthCheck();
  autoDetectSymbol();
  setupEventListeners();
});

/**
 * Check if local trading agent backend is active on port 3000
 */
async function initHealthCheck() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');

  try {
    const res = await fetch(`${API_BASE_URL}/`, { method: 'GET' });
    if (res.ok) {
      if (dot) dot.className = 'status-dot online';
      if (text) text.innerText = 'Backend Online';
    } else {
      throw new Error('Non-200 response');
    }
  } catch (err) {
    if (dot) dot.className = 'status-dot offline';
    if (text) text.innerText = 'Backend Offline';
  }
}

/**
 * Message active tab content script to detect instrument symbol from screen
 */
function autoDetectSymbol() {
  const symbolInput = document.getElementById('symbolInput');
  const sourceTag = document.getElementById('sourceTag');

  // Check if extension context is valid
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    if (sourceTag) sourceTag.innerText = 'Default';
    return;
  }

  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError || !tabs || !tabs[0]) {
        if (sourceTag) sourceTag.innerText = 'Default';
        return;
      }

      const activeTabId = tabs[0].id;
      const tabStorageKey = `tab_symbol_${activeTabId}`;

      if (!chrome.storage || !chrome.storage.local) return;

      // Read ONLY from the ACTIVE tab's isolated storage
      chrome.storage.local.get(['targetSymbol', tabStorageKey], (result) => {
        if (chrome.runtime.lastError) return;

        if (result && result.targetSymbol) {
          symbolInput.value = result.targetSymbol;
          sourceTag.innerText = 'Saved Selection';
          chrome.storage.local.remove('targetSymbol');
          return;
        }

        const activeTabSymbol = result ? result[tabStorageKey] : null;
        if (activeTabSymbol && activeTabSymbol.symbol && activeTabSymbol.confidence !== 'Low') {
          symbolInput.value = activeTabSymbol.symbol;
          sourceTag.innerText = `${activeTabSymbol.source} (${activeTabSymbol.confidence})`;
          if (activeTabSymbol.screenLivePrice) {
            window.detectedScreenPrice = activeTabSymbol.screenLivePrice;
          }
          return;
        }

        // Query active tab content script fallback directly
        chrome.tabs.sendMessage(activeTabId, { action: 'DETECT_SYMBOL' }, (response) => {
          if (chrome.runtime.lastError || !response) {
            if (sourceTag) sourceTag.innerText = 'Default';
            return;
          }

          if (response.symbol) {
            symbolInput.value = response.symbol;
            sourceTag.innerText = `${response.source} (${response.confidence})`;
            if (response.screenLivePrice) {
              window.detectedScreenPrice = response.screenLivePrice;
            }
          }
        });
      });
    });
  } catch (err) {
    console.warn('Extension context invalidated or inactive:', err.message);
  }
}

/**
 * Bind click handlers for timeframe buttons, range buttons, re-scan button, and run analysis button
 */
function setupEventListeners() {
  const symbolInput = document.getElementById('symbolInput');
  const rescanBtn = document.getElementById('rescanBtn');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const tfBtns = document.querySelectorAll('.tf-btn');
  const rangeBtns = document.querySelectorAll('.range-btn');

  // Timeframe pills selection
  tfBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tfBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedTimeframe = btn.getAttribute('data-tf');
    });
  });

  // Lookback Range pills selection
  rangeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      rangeBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedLookbackDays = parseInt(btn.getAttribute('data-range'), 10) || 30;
    });
  });

  // Manual re-scan symbol button
  if (rescanBtn) {
    rescanBtn.addEventListener('click', () => {
      autoDetectSymbol();
    });
  }

  // Submit Analysis button
  analyzeBtn.addEventListener('click', () => {
    const symbol = symbolInput.value.trim();
    if (!symbol) return;
    executeAnalysis(symbol, selectedTimeframe, selectedLookbackDays);
  });
}

/**
 * Send POST request to local trading agent backend /analyze
 */
async function executeAnalysis(symbol, timeframe, lookbackDays) {
  showLoading(true);
  hideError();
  hideResultCard();

  updateLoadingProgress('Querying Finvedas Agents...', `Analyzing ${symbol} (${lookbackDays}d lookback, ${timeframe.replace('_', ' ')})...`);

  try {
    const res = await fetch(`${API_BASE_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol,
        timeframe,
        lookback_days: lookbackDays,
        screen_live_price: window.detectedScreenPrice || null
      }),
    });

    const data = await res.json();

    if (!res.ok || data.success === false) {
      if (data.not_found) {
        showError('Instrument Not Found', data.message || `Instrument '${symbol}' not in Snowflake database.`);
      } else {
        showError('Analysis Failed', data.error || 'Server error while generating analysis.');
      }
      return;
    }

    renderResults(data);

  } catch (err) {
    showError('Connection Error', `Failed to connect to trading agent backend at ${API_BASE_URL}. Please ensure 'npm run dev' is running.`);
  } finally {
    showLoading(false);
  }
}

/**
 * Render backend response into popup dashboard
 */
function renderResults(data) {
  const resultCard = document.getElementById('resultCard');
  const signalBadge = document.getElementById('signalBadge');
  const confidenceVal = document.getElementById('confidenceVal');
  const summaryText = document.getElementById('summaryText');

  const livePriceVal = document.getElementById('livePriceVal');
  const entryVal = document.getElementById('entryVal');
  const targetVal = document.getElementById('targetVal');
  const stopLossVal = document.getElementById('stopLossVal');

  const marketTag = document.getElementById('marketTag');
  const sentimentTag = document.getElementById('sentimentTag');
  const patternTag = document.getElementById('patternTag');

  const signal = data.signal || {};
  const agents = data.agents || {};

  // Extract signal values
  const rec = (signal.final_signal || signal.recommendation || signal.overall_signal || signal.direction || 'NEUTRAL').toUpperCase();
  const conf = signal.confidence !== undefined ? `${signal.confidence}%` : '70%';
  const summary = signal.action || signal.reasoning || signal.summary || signal.synthesis || 'Multi-agent signal synthesized successfully.';

  // Signal Badge Styling
  signalBadge.innerText = rec;
  if (rec.includes('BUY') || rec.includes('BULLISH')) {
    signalBadge.className = 'signal-badge bullish';
  } else if (rec.includes('SELL') || rec.includes('BEARISH')) {
    signalBadge.className = 'signal-badge bearish';
  } else {
    signalBadge.className = 'signal-badge neutral';
  }

  confidenceVal.innerText = conf;
  summaryText.innerText = summary;

  // Extract Prices cleanly
  const livePrice = data.current_price || agents.market?.currentPrice || agents.market?.indicators?.['1_hour']?.current_price;
  const rawEntry = signal.entry_price || livePrice;
  const rawTarget = signal.target_price || signal.target || signal.actionable_plan?.target_price;
  const rawStop = signal.stop_loss || signal.stop || signal.actionable_plan?.stop_loss;

  if (livePriceVal) livePriceVal.innerText = formatPrice(livePrice);
  if (entryVal) entryVal.innerText = formatPrice(rawEntry);
  if (targetVal) targetVal.innerText = formatPrice(rawTarget);
  if (stopLossVal) stopLossVal.innerText = formatPrice(rawStop);

  // Sub-Agent Details
  applyAgentTag(marketTag, agents.market?.overallSignal || agents.market?.analysis?.bias || 'NEUTRAL');
  applyAgentTag(sentimentTag, agents.sentiment?.sentimentSignal || agents.sentiment?.sentiment?.overall_sentiment || 'NEUTRAL');
  applyAgentTag(patternTag, agents.pattern?.patternBias || agents.pattern?.pattern_analysis?.pattern_bias || 'NEUTRAL');

  resultCard.classList.remove('hidden');
}

function formatPrice(val) {
  if (val === null || val === undefined || val === 'N/A' || isNaN(Number(val))) return 'N/A';
  const num = Number(val);
  return `₹ ${num.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function applyAgentTag(element, statusText) {
  const text = (statusText || 'NEUTRAL').toUpperCase();
  element.innerText = text;
  if (text.includes('BULLISH') || text.includes('BUY')) {
    element.className = 'agent-tag bullish';
  } else if (text.includes('BEARISH') || text.includes('SELL')) {
    element.className = 'agent-tag bearish';
  } else {
    element.className = 'agent-tag neutral';
  }
}

function updateLoadingProgress(step, subtext) {
  document.getElementById('loadingStep').innerText = step;
  document.getElementById('loadingSubtext').innerText = subtext;
}

function showLoading(show) {
  const panel = document.getElementById('loadingPanel');
  if (show) panel.classList.remove('hidden');
  else panel.classList.add('hidden');
}

function hideResultCard() {
  document.getElementById('resultCard').classList.add('hidden');
}

function showError(title, message) {
  const errorCard = document.getElementById('errorCard');
  document.getElementById('errorTitle').innerText = title;
  document.getElementById('errorMsg').innerText = message;
  errorCard.classList.remove('hidden');
}

function hideError() {
  document.getElementById('errorCard').classList.add('hidden');
}
