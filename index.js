import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { marketAnalyst } from './agents/marketAnalyst.js';
import { sentimentAgent } from './agents/sentimentAgent.js';
import { patternAgent } from './agents/patternAgent.js';
import { supervisor } from './agents/supervisor.js';

import { getAvailableInstruments, normalizeSymbol } from './tools/snowflake.js';

dotenv.config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['*'] }));
app.use(express.json());

// Log every incoming HTTP request immediately to terminal
app.use((req, res, next) => {
  console.log(`\n📡 [${new Date().toLocaleTimeString('en-IN')}] Incoming ${req.method} request to ${req.url}`);
  if (req.method === 'POST') {
    console.log(`   Payload:`, JSON.stringify(req.body));
  }
  next();
});

// ─── Health Check ───────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Trading Agent Running 🚀' });
});

// ─── Get Instruments List ──────────────────────────────
app.get('/instruments', async (req, res) => {
  try {
    const list = await getAvailableInstruments();
    res.json({ success: true, instruments: list });
  } catch (err) {
    res.json({ success: false, instruments: ['NIFTY 50', 'BANKNIFTY', 'RELIANCE', 'TCS', 'INFY'] });
  }
});

// ─── Active Job Registry for Backend Cancellation ────────
const activeJobs = new Map();

// ─── Cancel Endpoint ─────────────────────────────────────
app.post('/cancel', (req, res) => {
  const jobId = req.body?.jobId;
  if (jobId && activeJobs.has(jobId)) {
    console.log(`🛑 Received explicit cancellation for job '${jobId}'. Aborting backend analysis pipeline...`);
    const controller = activeJobs.get(jobId);
    controller.abort();
    activeJobs.delete(jobId);
    return res.json({ success: true, message: `Job '${jobId}' cancelled successfully.` });
  }
  res.json({ success: true, message: 'Job not active or already completed.' });
});

// ─── Main Analysis Endpoint ─────────────────────────────
app.post('/analyze', async (req, res) => {
  const jobId = req.body.jobId || null;
  const jobController = new AbortController();
  const signal = jobController.signal;

  if (jobId) {
    activeJobs.set(jobId, jobController);
  }

  // Handle client connection disconnect (only if client genuinely aborted socket)
  res.on('close', () => {
    if (!res.writableEnded && req.aborted && !signal.aborted) {
      console.log(`🛑 Client aborted connection socket${jobId ? ` for job '${jobId}'` : ''}. Aborting backend execution...`);
      jobController.abort();
      if (jobId) activeJobs.delete(jobId);
    }
  });

  try {
    const rawSymbol = req.body.symbol || 'NIFTY 50';
    const timeframe = req.body.timeframe || '1_hour';
    const lookbackDays = req.body.lookback_days || 30;
    const screenLivePrice = req.body.screen_live_price || req.body.screenLivePrice || null;
    const symbol = normalizeSymbol(rawSymbol);

    console.log(`\n🔍 Analyzing ${symbol} (raw: "${rawSymbol}") on ${timeframe} timeframe (${lookbackDays}d lookback)${jobId ? ` [Job: ${jobId}]` : ''}...`);

    if (signal.aborted) throw new Error('Analysis aborted by user.');

    // Step 1: Run ALL 3 Sub-Agents concurrently in parallel for maximum speed ⚡
    console.log('⚡ Running Market, Sentiment, and Pattern Agents in PARALLEL...');
    const [marketAnalysis, sentiment, patterns] = await Promise.all([
      marketAnalyst(symbol, timeframe, lookbackDays, screenLivePrice, signal),
      sentimentAgent(symbol, signal),
      patternAgent(symbol, timeframe, null, signal),
    ]);

    if (signal.aborted) throw new Error('Analysis aborted by user.');

    // Fast-fail if instrument does not exist or has no candle data
    if (marketAnalysis?.error) {
      console.log(`⚠️ Instrument '${symbol}' analysis failed: ${marketAnalysis.error}`);
      return res.json({
        success: false,
        not_found: true,
        symbol,
        error: `Instrument '${symbol}' data could not be retrieved.`,
        message: `Hey! Data for '${symbol}' could not be retrieved. Please search for a valid instrument (e.g., NIFTY 50, PC JEWELLER, LT FOODS, RELIANCE, TCS).`,
      });
    }

    if (signal.aborted) throw new Error('Analysis aborted by user.');

    console.log('✅ All agents done. Sending to supervisor...');

    // Step 2: Supervisor (Claude) makes final decision
    const finalSignal = await supervisor({
      symbol,
      timeframe,
      lookbackDays,
      marketAnalysis,
      sentiment,
      patterns,
      abortSignal: signal,
    });

    if (signal.aborted) throw new Error('Analysis aborted by user.');

    // Step 3: Return result with complete sub-agent outputs for rich UI display
    res.json({
      success: true,
      symbol,
      timeframe,
      current_price: marketAnalysis?.currentPrice || null,
      lookback_days: lookbackDays,
      timestamp: new Date().toISOString(),
      signal: finalSignal,
      agents: {
        market: marketAnalysis,
        sentiment: sentiment,
        pattern: patterns,
      }
    });

  } catch (error) {
    if (signal.aborted || error.message?.includes('aborted')) {
      console.log(`🛑 Job ${jobId || 'execution'} gracefully aborted.`);
      if (!res.headersSent) {
        res.status(499).json({ success: false, error: 'Client closed request / analysis aborted.' });
      }
    } else {
      console.error('❌ Error:', error.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: error.message });
      }
    }
  } finally {
    if (jobId) activeJobs.delete(jobId);
  }
});

// ─── Quick Signal Endpoint ───────────────────────────────
app.get('/signal/:symbol', async (req, res) => {
  try {
    const symbol = decodeURIComponent(req.params.symbol);
    console.log(`\n⚡ Quick signal for ${symbol}...`);

    const marketAnalysis = await marketAnalyst(symbol, '1_hour');
    const finalSignal = await supervisor({
      symbol,
      timeframe: '1_hour',
      marketAnalysis,
      sentiment: null,
      patterns: null,
    });

    res.json({
      success: true,
      symbol,
      timestamp: new Date().toISOString(),
      signal: finalSignal,
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Start Server ────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║     🤖 Trading Agent Started          ║
  ║     Port: ${PORT}                        ║
  ║     Status: Running                   ║
  ╚═══════════════════════════════════════╝
  `);
});

// Keep Node.js event loop active to prevent premature process exit on Node v26
setInterval(() => { }, 1000 * 60 * 60);

export default app;