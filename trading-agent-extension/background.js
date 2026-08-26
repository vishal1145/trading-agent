/**
 * Finvedas Trading Agent - Service Worker (Background Script)
 */

// Handle extension action icon click -> Toggle floating widget on active page
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_FLOATING_WIDGET' }).catch((err) => {
      console.warn('Could not send message to tab:', err.message);
    });
  }
});

// Initialize extension and context menu on install
chrome.runtime.onInstalled.addListener(() => {
  console.log('Finvedas Trading Agent Extension Installed.');

  // Create context menu for highlighted text on any webpage
  chrome.contextMenus.create({
    id: 'analyze-selection',
    title: '📊 Analyze "%s" with Finvedas AI Agent',
    contexts: ['selection']
  });
});

// Handle context menu click
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'analyze-selection' && info.selectionText) {
    const symbol = info.selectionText.trim().toUpperCase();
    chrome.storage.local.set({ targetSymbol: symbol }, () => {
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { action: 'TOGGLE_FLOATING_WIDGET', open: true }).catch((err) => {
          console.warn('Could not send message to tab:', err.message);
        });
      }
    });
  }
});

// Handle tab-isolated symbol updates from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'UPDATE_TAB_SYMBOL' && sender.tab && sender.tab.id) {
    const tabId = sender.tab.id;
    chrome.storage.local.set({ [`tab_symbol_${tabId}`]: message.symbolInfo });
  }
});

