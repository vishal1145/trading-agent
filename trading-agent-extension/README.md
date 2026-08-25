# Finvedas Trading Agent - Chrome Extension 🚀

Auto-detect stock and market instrument symbols straight from your screen (TradingView, Zerodha Kite, Groww, Yahoo Finance, Google Finance, or text selection) and generate multi-agent AI analysis powered by your local Snowflake + LLM trading backend.

---

## 📁 File Structure

```
trading-agent-extension/
├── manifest.json       # Extension configuration (Manifest V3)
├── content.js          # Screen & DOM instrument scraper
├── background.js       # Background service worker & context menu
├── popup.html          # Glassmorphic extension popup UI
├── styles.css          # Extension design system & styling
└── popup.js            # Frontend logic & API communication with local backend
```

---

## 🛠️ Setup & Installation Instructions

### Step 1: Ensure Your Trading Agent Backend is Running
Make sure your backend Node server is running on `http://localhost:3000`:
```bash
npm run dev
```

### Step 2: Load Extension into Google Chrome
1. Open Google Chrome and navigate to: `chrome://extensions/`
2. Turn ON **Developer mode** (toggle switch at the top-right corner).
3. Click the **Load unpacked** button at the top-left.
4. Select the directory:
   `/home/rakesh/Desktop/trading-agent/trading-agent-extension`
5. The **Finvedas Trading Agent AI** extension will now appear in your extension toolbar!

---

## 💡 How to Use

1. **Auto Screen Detection**: Open any chart or trading website (e.g. TradingView, Zerodha Kite, Groww, Yahoo Finance). Click the Finvedas extension icon — it will automatically detect the instrument on screen!
2. **Text Highlight**: Highlight any text/ticker on a webpage, right-click, and select **"Analyze with Finvedas AI Agent"**.
3. **Manual Input / Override**: You can also manually type or change the symbol in the input field.
4. **Select Timeframe**: Choose between `15m`, `1 Hour`, `Daily`, or `Weekly`.
5. **Run Analysis**: Click **⚡ Run Multi-Agent Analysis** to trigger parallel sub-agent analysis (Market Analyst, Sentiment, Pattern) and Supervisor decision.
