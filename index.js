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

// ─── Main Analysis Endpoint ─────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const rawSymbol = req.body.symbol || 'NIFTY 50';
    const timeframe = req.body.timeframe || '1_hour';
    const lookbackDays = req.body.lookback_days || 30;
    const screenLivePrice = req.body.screen_live_price || req.body.screenLivePrice || null;
    const symbol = normalizeSymbol(rawSymbol);

    console.log(`\n🔍 Analyzing ${symbol} (raw: "${rawSymbol}") on ${timeframe} timeframe (${lookbackDays}d lookback)...`);

    // Step 1: Run Market Analyst first to fetch live candles (Zerodha / Yahoo Finance)
    console.log('📊 Running agents...');
    const marketAnalysis = await marketAnalyst(symbol, timeframe, lookbackDays, screenLivePrice);

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

    // Run Sentiment & Pattern agents using live candles
    const [sentiment, patterns] = await Promise.all([
      sentimentAgent(symbol),
      patternAgent(symbol, timeframe, marketAnalysis?.candles),
    ]);

    console.log('✅ All agents done. Sending to supervisor...');

    // Step 2: Supervisor (Claude) makes final decision
    const finalSignal = await supervisor({
      symbol,
      timeframe,
      lookbackDays,
      marketAnalysis,
      sentiment,
      patterns,
    });

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
    console.error('❌ Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
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