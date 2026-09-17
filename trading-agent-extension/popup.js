/**
 * Finvedas Trading Agent - Extension Popup Controller
 */

// let API_BASE_URL = 'https://api.tradingagent.chandankumal.in';
const FALLBACK_API_URL = 'http://localhost:3000';

let selectedTimeframe = '1_hour';
let selectedLookbackDays = 30;

document.addEventListener('DOMContentLoaded', () => {
  initHealthCheck();
  autoDetectSymbol();
  setupEventListeners();
});

/**
 * Check if trading agent backend is active, fallback to local if remote is down
 */
async function initHealthCheck() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');

  try {
    const res = await fetch(`${API_BASE_URL}/`, { method: 'GET' });
    if (res.ok) {
      if (dot) dot.className = 'status-dot online';
      if (text) text.innerText = 'Remote Backend Online';
      return;
    }
  } catch (err) {
    console.warn('Priority API unavailable, trying fallback...');
  }

  try {
    const res = await fetch(`${FALLBACK_API_URL}/`, { method: 'GET' });
    if (res.ok) {
      API_BASE_URL = FALLBACK_API_URL;
      if (dot) dot.className = 'status-dot online';
      if (text) text.innerText = 'Local Backend Online';
      return;
    }
    throw new Error('Local API also down');
  } catch (err) {
    API_BASE_URL = FALLBACK_API_URL;
    if (dot) dot.className = 'status-dot offline';
    if (text) text.innerText = 'Backend Offline';
  }
}

/**
 * Known UI garbage tokens that should never be treated as instrument symbols.
 * Mirrors the blocklist in content.js for cross-validation of cached values.
 */
const POPUP_GARBAGE_BLOCKLIST = new Set([
  'CTRL K', 'CTRL F', 'CTRL L', 'CTRL S', 'CTRL', 'CMD K', 'CMD',
  'SEARCH', 'SEARCH INSTRUMENTS', 'FIND', 'HOME', 'MENU', 'TAB',
  'SHARE', 'STOCK', 'PRICE', 'CHART', 'BUY', 'SELL', 'TODAY', 'LIVE',
  'NEWS', 'MARKET', 'WATCH', 'TRADE', 'LOGIN', 'LOGOUT', 'PROFILE',
]);

/**
 * Returns true if symbol looks like a real instrument (not a UI artifact).
 */
function isLiveSymbolValid(sym) {
  if (!sym || sym.length < 2 || sym.length > 40) return false;
  if (POPUP_GARBAGE_BLOCKLIST.has(sym.toUpperCase().trim())) return false;
  if (/^(CTRL|CMD|ALT|ESC|TAB|META)\b/i.test(sym)) return false;
  return true;
}

/**
 * Message active tab content script to detect instrument symbol from screen.
 * Strategy: ALWAYS do a live content-script scan first.
 * Only fall back to cached storage if the live scan is unavailable (e.g. restricted page).
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

      // ── STEP 1: Always try the live content-script scan first ─────────────
      chrome.tabs.sendMessage(activeTabId, { action: 'DETECT_SYMBOL' }, { frameId: 0 }, (liveResponse) => {
        // If the live scan succeeded and returned a valid (non-garbage) symbol, use it.
        if (
          !chrome.runtime.lastError &&
          liveResponse &&
          liveResponse.symbol &&
          liveResponse.confidence !== 'Low' &&
          isLiveSymbolValid(liveResponse.symbol)
        ) {
          symbolInput.value = liveResponse.symbol;
          if (sourceTag) sourceTag.innerText = `${liveResponse.source} (${liveResponse.confidence})`;
          if (liveResponse.screenLivePrice) {
            window.detectedScreenPrice = liveResponse.screenLivePrice;
          }
          // Update storage with the freshly validated symbol so future reads are correct
          if (chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ [tabStorageKey]: liveResponse });
          }
          return;
        }

        // ── STEP 2: Live scan unavailable or returned garbage — use cache ────
        if (!chrome.storage || !chrome.storage.local) return;
        chrome.storage.local.get(['targetSymbol', tabStorageKey], (result) => {
          if (chrome.runtime.lastError) return;

          // Priority override from context-menu selection
          if (result && result.targetSymbol && isLiveSymbolValid(result.targetSymbol)) {
            symbolInput.value = result.targetSymbol;
            if (sourceTag) sourceTag.innerText = 'Saved Selection';
            chrome.storage.local.remove('targetSymbol');
            return;
          }

          const cached = result ? result[tabStorageKey] : null;
          if (cached && cached.symbol && cached.confidence !== 'Low' && isLiveSymbolValid(cached.symbol)) {
            symbolInput.value = cached.symbol;
            if (sourceTag) sourceTag.innerText = `${cached.source} (${cached.confidence}) [cached]`;
            if (cached.screenLivePrice) {
              window.detectedScreenPrice = cached.screenLivePrice;
            }
            return;
          }

          // Nothing valid found anywhere — clear stale garbage from storage
          if (chrome.storage && chrome.storage.local) {
            chrome.storage.local.remove(tabStorageKey);
          }
          if (sourceTag) sourceTag.innerText = 'Not Detected';
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

  // Lookback chip buttons
  const lookbackPills = document.querySelectorAll('#lookbackPills .chip');
  lookbackPills.forEach(btn => {
    btn.addEventListener('click', () => {
      lookbackPills.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedLookbackDays = parseInt(btn.dataset.value, 10) || 30;
    });
  });

  // Candle Timeframe chip buttons
  const timeframePills = document.querySelectorAll('#timeframePills .chip');
  timeframePills.forEach(btn => {
    btn.addEventListener('click', () => {
      timeframePills.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedTimeframe = btn.dataset.value;
    });
  });

  // Manual re-scan symbol button
  if (rescanBtn) {
    rescanBtn.addEventListener('click', () => {
      autoDetectSymbol();
    });
  }

  // Submit Analysis button — toggles to Stop while running
  analyzeBtn.addEventListener('click', () => {
    if (analyzeBtn.dataset.running === 'true') {
      // Stop the running analysis (both browser fetch and backend job)
      if (window._analysisAbortController) {
        window._analysisAbortController.abort();
      }
      if (window._currentJobId) {
        fetch(`${API_BASE_URL}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: window._currentJobId }),
        }).catch(() => { });
      }
      return;
    }
    const symbol = symbolInput.value.trim();
    if (!symbol) return;
    executeAnalysis(symbol, selectedTimeframe, selectedLookbackDays);
  });
}

/**
 * Send POST request to local trading agent backend /analyze
 */
async function executeAnalysis(symbol, timeframe, lookbackDays) {
  const analyzeBtn = document.getElementById('analyzeBtn');

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  window._currentJobId = jobId;

  // Switch button to Stop state
  analyzeBtn.dataset.running = 'true';
  analyzeBtn.innerHTML = 'Stop Analysis';
  analyzeBtn.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
  analyzeBtn.style.boxShadow = '0 4px 15px rgba(239, 68, 68, 0.4)';

  const resetBtn = () => {
    analyzeBtn.dataset.running = 'false';
    analyzeBtn.innerHTML = 'Run Agent Analysis';
    analyzeBtn.style.background = '';
    analyzeBtn.style.boxShadow = '';
    window._analysisAbortController = null;
    window._currentJobId = null;
  };

  // Create abort controller for this request
  const controller = new AbortController();
  window._analysisAbortController = controller;

  showLoading(true);
  hideError();
  hideResultCard();

  // ── Start dynamic thinking animation ─────────────────────────────────
  startThinkingAnimation(symbol, timeframe, lookbackDays);

  // Re-detect live price fresh at analysis time for maximum accuracy
  let screenLivePrice = window.detectedScreenPrice || null;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
      const freshResponse = await new Promise((resolve) => {
        chrome.tabs.sendMessage(activeTab.id, { action: 'DETECT_SYMBOL' }, { frameId: 0 }, (resp) => {
          resolve(resp || {});
        });
      });
      if (freshResponse?.screenLivePrice) {
        screenLivePrice = freshResponse.screenLivePrice;
        window.detectedScreenPrice = screenLivePrice;
      }
    }
  } catch (_) { }

  try {
    const res = await fetch(`${API_BASE_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        symbol,
        timeframe,
        lookback_days: lookbackDays,
        screen_live_price: screenLivePrice
      }),
      signal: controller.signal
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
    if (err.name === 'AbortError') {
      hideError();
      hideResultCard();
    } else {
      showError('Connection Error', `Failed to connect to trading agent backend at ${API_BASE_URL}. Please ensure 'npm run dev' is running.`);
    }
  } finally {
    stopThinkingAnimation();
    showLoading(false);
    resetBtn();
  }
}

// ─── Thinking Animation Engine ──────────────────────────────────────────────────
let _thinkingIntervalId = null;

function startThinkingAnimation(symbol, timeframe, lookbackDays) {
  const tf = timeframe.replace('_', ' ');
  const sym = symbol.trim();

  // Contextual message pairs: [headline, subtext]
  const messages = [
    ['🧠 Thinking...', `Reviewing ${sym} across all timeframes`],
    ['📡 Fetching live market data...', `Connecting to Kite & Yahoo Finance for ${sym}`],
    [`📊 Loading ${lookbackDays}-day candle history...`, `Scanning 1m, 5m, 15m, 1hr candles for ${sym}`],
    ['💹 Calculating technical indicators...', 'RSI · MACD · Bollinger Bands · VWAP · EMA'],
    ['🔍 Running multi-timeframe analysis...', `Checking trend alignment across ${tf} candles`],
    ['📰 Analysing market sentiment...', 'PCR · Smart money flows · Fear & Greed index'],
    ['🕯 Detecting chart patterns...', 'Head & Shoulders · Flags · Wedges · Breakouts'],
    ["📅 Reviewing yesterday's market action...", `How did ${sym} behave in recent sessions?`],
    ['⚡ Checking support & resistance levels...', `Mapping key price zones for ${sym}`],
    ['📈 Measuring momentum & volume...', 'Volume spike detection · Institutional activity'],
    ['🤖 Querying Trading AI agents...', 'Market Analyst · Sentiment Agent · Pattern Agent'],
    ['🎯 Synthesising agent signals...', 'Weighing confluence across all 3 sub-agents'],
    ['🔮 Computing entry, target & stop-loss...', `Anchoring to live price of ${sym}`],
    ['⏱ Estimating hold duration...', 'Calculating optimal trade window for your timeframe'],
    ['📐 Calculating risk : reward ratio...', 'Profit potential vs. downside exposure'],
    ['✍️ Writing your trade plan...', `Almost done analysing ${sym}...`],
  ];

  let idx = 0;
  const stepEl = document.getElementById('loadingStep');
  const subEl = document.getElementById('loadingSubtext');

  const show = () => {
    if (!stepEl || !subEl) return;
    const [headline, sub] = messages[idx % messages.length];
    // Fade out → update → fade in
    stepEl.style.transition = 'opacity 0.3s ease';
    subEl.style.transition = 'opacity 0.3s ease';
    stepEl.style.opacity = '0';
    subEl.style.opacity = '0';
    setTimeout(() => {
      stepEl.innerText = headline;
      subEl.innerText = sub;
      stepEl.style.opacity = '1';
      subEl.style.opacity = '1';
    }, 300);
    idx++;
  };

  show(); // show immediately
  _thinkingIntervalId = setInterval(show, 2600);
}

function stopThinkingAnimation() {
  if (_thinkingIntervalId !== null) {
    clearInterval(_thinkingIntervalId);
    _thinkingIntervalId = null;
  }
  // Restore opacity in case it was mid-fade
  const stepEl = document.getElementById('loadingStep');
  const subEl = document.getElementById('loadingSubtext');
  if (stepEl) { stepEl.style.opacity = '1'; stepEl.style.transition = ''; }
  if (subEl) { subEl.style.opacity = '1'; subEl.style.transition = ''; }
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

  // ── Market Regime & Time Advisory ──────────────────────────────────
  const regime = signal.market_regime || agents.market?.market_regime || agents.market?.indicators?.['1_hour']?.market_regime || null;
  const timeFilter = signal.time_filter || regime?.time_of_day || null;

  const regimeBadge = document.getElementById('regimeBadge');
  const regimeBanner = document.getElementById('regimeBanner');
  const regimeTag = document.getElementById('regimeTag');
  const adxTag = document.getElementById('adxTag');
  const regimeAdvisory = document.getElementById('regimeAdvisory');

  if (regime) {
    if (regimeBadge) {
      regimeBadge.classList.remove('hidden');
      const prim = (regime.primary_regime || 'TRANSITIONAL').toUpperCase();
      regimeBadge.innerText = prim === 'BREAKOUT_IMMINENT' ? 'BREAKOUT ALERT' : prim;
      regimeBadge.className = `regime-badge ${regime.primary_regime.toLowerCase()}`;
    }

    if (regimeBanner) {
      regimeBanner.classList.remove('hidden');
      if (regimeTag) {
        regimeTag.innerText = `🧭 ${regime.primary_regime} (${regime.trend_direction})`;
      }
      if (adxTag && regime.adx) {
        adxTag.innerText = `ADX: ${regime.adx.value} (${regime.adx.slope})`;
      }

      if (regimeAdvisory) {
        let adv = regime.guidance || '';
        if (timeFilter) {
          const isWarning = timeFilter.block_signals;
          adv += ` • ${timeFilter.label}: ${timeFilter.action}`;
          if (isWarning) {
            regimeAdvisory.className = 'regime-advisory time-warning';
          } else {
            regimeAdvisory.className = 'regime-advisory';
          }
        }
        regimeAdvisory.innerText = adv;
      }
    }
  } else {
    if (regimeBadge) regimeBadge.classList.add('hidden');
    if (regimeBanner) regimeBanner.classList.add('hidden');
  }

  // Extract Prices cleanly
  const isHold = rec.includes('HOLD') || rec.includes('NEUTRAL') || rec.includes('WAIT');
  const livePrice = data.current_price || agents.market?.currentPrice || agents.market?.indicators?.['1_hour']?.current_price;
  const rawEntry = signal.entry_price || (isHold ? null : livePrice);
  const rawTarget = signal.target_price || signal.target || signal.actionable_plan?.target_price;
  const rawStop = signal.stop_loss || signal.stop || signal.actionable_plan?.stop_loss;

  if (livePriceVal) livePriceVal.innerText = formatPrice(livePrice);

  if (isHold) {
    if (entryVal) {
      entryVal.innerText = '—';
      entryVal.classList.add('hold-val');
      entryVal.title = 'No active entry for HOLD signal';
    }
    if (targetVal) {
      targetVal.innerText = '—';
      targetVal.classList.add('hold-val');
      targetVal.title = 'No active target for HOLD signal';
    }
    if (stopLossVal) {
      stopLossVal.innerText = '—';
      stopLossVal.classList.add('hold-val');
      stopLossVal.title = 'No stop loss needed while on sidelines';
    }
  } else {
    if (entryVal) {
      entryVal.classList.remove('hold-val');
      entryVal.innerText = formatPrice(rawEntry);
      entryVal.title = '';
    }
    if (targetVal) {
      targetVal.classList.remove('hold-val');
      targetVal.innerText = formatPrice(rawTarget);
      targetVal.title = '';
    }
    if (stopLossVal) {
      stopLossVal.classList.remove('hold-val');
      stopLossVal.innerText = formatPrice(rawStop);
      stopLossVal.title = '';
    }
  }

  // Sub-Agent Details
  applyAgentTag(marketTag, agents.market?.overallSignal || agents.market?.analysis?.bias || 'NEUTRAL');
  applyAgentTag(sentimentTag, agents.sentiment?.sentimentSignal || agents.sentiment?.sentiment?.overall_sentiment || 'NEUTRAL');
  applyAgentTag(patternTag, agents.pattern?.patternBias || agents.pattern?.pattern_analysis?.pattern_bias || 'NEUTRAL');

  // ── Hold Duration ────────────────────────────────────────────────────
  const holdUntilVal = document.getElementById('holdUntilVal');
  const holdMinsVal = document.getElementById('holdMinsVal');
  const holdText = signal.hold_until || signal.timeframe_to_play || null;
  const holdMins = signal.max_hold_duration_minutes || null;
  if (holdUntilVal) holdUntilVal.innerText = holdText || '—';
  if (holdMinsVal) {
    if (holdMins && holdMins > 0) {
      const h = Math.floor(holdMins / 60);
      const m = holdMins % 60;
      holdMinsVal.innerText = h > 0 ? `≈ ${h}h ${m > 0 ? m + 'm' : ''}`.trim() : `≈ ${m}m`;
    } else {
      holdMinsVal.innerText = '';
    }
  }

  // ── Profit Potential ─────────────────────────────────────────────────
  const profitPctVal = document.getElementById('profitPctVal');
  const profitAbsVal = document.getElementById('profitAbsVal');
  const profitPct = signal.profit_potential_pct;
  const profitAbs = signal.profit_abs;

  // ── Risk ─────────────────────────────────────────────────────────────
  const riskPctEl = document.getElementById('riskPctVal');
  const riskAbsEl = document.getElementById('riskAbsVal');
  const riskPct = signal.risk_pct;
  const riskAbs = signal.risk_abs;

  // ── Risk : Reward ────────────────────────────────────────────────────
  const rrRatioEl = document.getElementById('rrRatioVal');
  const rrQualityEl = document.getElementById('rrQualityVal');
  const rr = signal.risk_reward_computed || signal.risk_reward;

  if (isHold) {
    if (profitPctVal) {
      profitPctVal.innerText = '—';
      profitPctVal.style.color = 'var(--text-muted)';
    }
    if (profitAbsVal) {
      profitAbsVal.innerText = 'No active position';
    }
    if (riskPctEl) {
      riskPctEl.innerText = '—';
      riskPctEl.style.color = 'var(--text-muted)';
    }
    if (riskAbsEl) {
      riskAbsEl.innerText = 'Zero exposure';
    }
    if (rrRatioEl) {
      rrRatioEl.innerText = '—';
    }
    if (rrQualityEl) {
      rrQualityEl.innerText = 'Sidelines';
    }
  } else {
    if (profitPctVal) {
      profitPctVal.style.color = '';
      if (profitPct !== null && profitPct !== undefined && !isNaN(Number(profitPct))) {
        const sign = Number(profitPct) >= 0 ? '+' : '';
        profitPctVal.innerText = `${sign}${profitPct}%`;
      } else { profitPctVal.innerText = '—'; }
    }
    if (profitAbsVal) {
      if (profitAbs !== null && profitAbs !== undefined && !isNaN(Number(profitAbs))) {
        const sign = Number(profitAbs) >= 0 ? '+' : '';
        profitAbsVal.innerText = `${sign}₹${Math.abs(profitAbs).toLocaleString('en-IN', { maximumFractionDigits: 2 })} / share`;
      } else { profitAbsVal.innerText = ''; }
    }

    if (riskPctEl) {
      riskPctEl.style.color = '';
      riskPctEl.innerText = (riskPct !== null && riskPct !== undefined && !isNaN(Number(riskPct))) ? `-${riskPct}%` : '—';
    }
    if (riskAbsEl) {
      if (riskAbs !== null && riskAbs !== undefined && !isNaN(Number(riskAbs))) {
        riskAbsEl.innerText = `-₹${Number(riskAbs).toLocaleString('en-IN', { maximumFractionDigits: 2 })} / share`;
      } else { riskAbsEl.innerText = ''; }
    }

    if (rrRatioEl) {
      if (rr !== null && rr !== undefined && !isNaN(Number(rr))) {
        rrRatioEl.innerText = `1 : ${Number(rr).toFixed(2)}`;
      } else { rrRatioEl.innerText = '—'; }
    }
    if (rrQualityEl) {
      if (rr !== null && rr !== undefined && !isNaN(Number(rr))) {
        const rrNum = Number(rr);
        rrQualityEl.innerText = rrNum >= 2 ? '✅ Excellent' : rrNum >= 1.5 ? '👍 Good' : rrNum >= 1 ? '⚠ Marginal' : '❌ Poor';
      } else { rrQualityEl.innerText = ''; }
    }
  }

  // ── Institutional F&O Levels & ΔOI ──────────────────────────────────
  const inst = signal.institutional_levels || {};
  const foCard = document.getElementById('foLevelsCard');
  const deltaBadge = document.getElementById('foDeltaBadge');
  const putWallVal = document.getElementById('foPutWallVal');
  const callWallVal = document.getElementById('foCallWallVal');
  const maxPainVal = document.getElementById('foMaxPainVal');
  const defenseStrikeVal = document.getElementById('foDefenseStrikeVal');

  const hasFoData = inst.call_wall || inst.put_wall || inst.max_pain || inst.delta_oi || agents?.sentiment?.call_wall;
  if (foCard && hasFoData) {
    foCard.classList.remove('hidden');
    const pWall = inst.put_wall || agents?.sentiment?.put_wall || inst.confluence_support;
    const cWall = inst.call_wall || agents?.sentiment?.call_wall || inst.confluence_resistance;
    const mPain = inst.max_pain || agents?.sentiment?.max_pain;
    const doi = inst.delta_oi || agents?.sentiment?.delta_oi;

    if (putWallVal) putWallVal.innerText = formatPrice(pWall);
    if (callWallVal) callWallVal.innerText = formatPrice(cWall);
    if (maxPainVal) maxPainVal.innerText = formatPrice(mPain);

    const topDefense = doi?.fastestPutWriting?.strike || doi?.fastestCallWriting?.strike || doi?.topBuildups?.[0]?.strike;
    if (defenseStrikeVal) defenseStrikeVal.innerText = topDefense ? formatPrice(topDefense) : '—';

    if (deltaBadge) {
      const doiSig = doi?.signal || 'NEUTRAL';
      deltaBadge.innerText = doiSig.replace(/_/g, ' ');
      deltaBadge.className = `fo-delta-badge ${doiSig.toLowerCase()}`;
    }
  } else if (foCard) {
    foCard.classList.add('hidden');
  }

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

// --- Dynamic Widget Resizing ---
const resizeObserver = new ResizeObserver(() => {
  if (window.parent) {
    const height = document.body.scrollHeight;
    window.parent.postMessage({ action: 'RESIZE_WIDGET', height }, '*');
  }
});
resizeObserver.observe(document.body);
