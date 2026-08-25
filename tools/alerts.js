import dotenv from 'dotenv';

dotenv.config();

// ─── Telegram Alert ──────────────────────────────────────
const sendTelegramAlert = async (message) => {
  try {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.log('⚠️ Telegram not configured — skipping alert');
      return false;
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    const response = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text:       message,
        parse_mode: 'HTML',
      }),
    });

    const data = await response.json();

    if (data.ok) {
      console.log('✅ Telegram alert sent!');
      return true;
    } else {
      console.error('❌ Telegram error:', data.description);
      return false;
    }

  } catch (error) {
    console.error('❌ Telegram alert failed:', error.message);
    return false;
  }
};

// ─── Format Alert Message ────────────────────────────────
const formatAlertMessage = ({
  symbol,
  signal,
  direction,
  confidence,
  entry,
  target,
  stopLoss,
  action,
  reasoning,
}) => {
  const emoji = signal === 'BUY'  ? '🟢' :
                signal === 'SELL' ? '🔴' : '🟡';

  const dirEmoji = direction === 'BULLISH' ? '📈' :
                   direction === 'BEARISH' ? '📉' : '➡️';

  const confidenceBar = '█'.repeat(Math.floor(confidence / 10)) +
                        '░'.repeat(10 - Math.floor(confidence / 10));

  return `
${emoji} <b>FINVEDAS AI SIGNAL</b> ${emoji}

📌 <b>Symbol:</b> ${symbol}
${dirEmoji} <b>Signal:</b> ${signal} (${direction})
🎯 <b>Confidence:</b> ${confidence}%
[${confidenceBar}]

💰 <b>Entry:</b>     ₹${entry || 'Market'}
🎯 <b>Target:</b>    ₹${target || 'N/A'}
🛑 <b>Stop Loss:</b> ₹${stopLoss || 'N/A'}

⚡ <b>Action:</b>
${action}

🧠 <b>Reasoning:</b>
${reasoning}

⏰ <b>Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST

⚠️ <i>AI analysis only. Not financial advice. Trade at your own risk.</i>

🤖 <i>Powered by Finvedas AI</i>
  `.trim();
};

// ─── Format Summary Message ──────────────────────────────
const formatSummaryMessage = (signals) => {
  const buySignals  = signals.filter(s => s.final_signal === 'BUY');
  const sellSignals = signals.filter(s => s.final_signal === 'SELL');
  const holdSignals = signals.filter(s => s.final_signal === 'HOLD');

  let message = `
📊 <b>FINVEDAS AI - MARKET SUMMARY</b>

⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST

🟢 <b>BUY Signals (${buySignals.length}):</b>
${buySignals.map(s => `  • ${s.symbol} — ${s.confidence}% confidence`).join('\n') || '  None'}

🔴 <b>SELL Signals (${sellSignals.length}):</b>
${sellSignals.map(s => `  • ${s.symbol} — ${s.confidence}% confidence`).join('\n') || '  None'}

🟡 <b>HOLD (${holdSignals.length}):</b>
${holdSignals.map(s => `  • ${s.symbol}`).join('\n') || '  None'}

📈 <b>Market Bias:</b> ${
    buySignals.length > sellSignals.length ? '🟢 BULLISH' :
    sellSignals.length > buySignals.length ? '🔴 BEARISH' :
    '🟡 NEUTRAL'
  }

⚠️ <i>AI analysis only. Not financial advice.</i>
🤖 <i>Powered by Finvedas AI</i>
  `.trim();

  return message;
};

// ─── Main Send Alert Function ────────────────────────────
export const sendAlert = async ({
  symbol,
  signal,
  direction,
  confidence,
  entry,
  target,
  stopLoss,
  action,
  reasoning,
}) => {
  try {
    console.log(`📱 Sending alert for ${symbol} — ${signal}...`);

    const message = formatAlertMessage({
      symbol,
      signal,
      direction,
      confidence,
      entry,
      target,
      stopLoss,
      action,
      reasoning,
    });

    await sendTelegramAlert(message);

  } catch (error) {
    console.error('❌ Alert error:', error.message);
  }
};

// ─── Send Market Summary ─────────────────────────────────
export const sendMarketSummary = async (signals) => {
  try {
    console.log('📊 Sending market summary...');
    const message = formatSummaryMessage(signals);
    await sendTelegramAlert(message);
  } catch (error) {
    console.error('❌ Summary alert error:', error.message);
  }
};

// ─── Send Custom Message ─────────────────────────────────
export const sendCustomAlert = async (message) => {
  try {
    await sendTelegramAlert(message);
  } catch (error) {
    console.error('❌ Custom alert error:', error.message);
  }
};

// ─── Send Error Alert ────────────────────────────────────
export const sendErrorAlert = async (error, context = '') => {
  try {
    const message = `
⚠️ <b>FINVEDAS AI - ERROR ALERT</b>

❌ <b>Error:</b> ${error.message || error}
📍 <b>Context:</b> ${context}
⏰ <b>Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST

🔧 <i>Check server logs for details</i>
    `.trim();

    await sendTelegramAlert(message);
  } catch (err) {
    console.error('❌ Error alert failed:', err.message);
  }
};