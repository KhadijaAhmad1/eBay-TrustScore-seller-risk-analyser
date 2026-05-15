/**
 * eBay TrustScore — Background Service Worker
 * Handles messaging between popup and content script
 */

importScripts('scoring-engine.js');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYSE_LISTING') {
    const report = computeTrustScore(message.data);
    sendResponse({ success: true, report });
  }

  if (message.type === 'GET_STORED_REPORT') {
    chrome.storage.local.get(['lastReport'], (result) => {
      sendResponse({ report: result.lastReport || null });
    });
    return true; // async
  }

  if (message.type === 'STORE_REPORT') {
    chrome.storage.local.set({ lastReport: message.report }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const isEbayListing = tab.url.includes('ebay.co.uk/itm/') || tab.url.includes('ebay.com/itm/');
    if (isEbayListing) {
      chrome.action.setBadgeText({ text: '!', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId });
    }
  }
});
