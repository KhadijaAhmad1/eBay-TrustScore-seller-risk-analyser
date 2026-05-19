/**
 * eBay TrustScore — Background Service Worker v2
 *
 * Handles:
 * - ANALYSE_LISTING  → score seller data
 * - GET_STORED_REPORT / STORE_REPORT → report cache
 * - FETCH_PROFILE → opens seller profile in hidden tab, scrapes after JS renders, closes tab
 */

importScripts('scoring-engine.js');

// ── MESSAGE ROUTER ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'ANALYSE_LISTING') {
    const report = computeTrustScore(message.data);
    sendResponse({ success: true, report });
    return false;
  }

  if (message.type === 'GET_STORED_REPORT') {
    chrome.storage.local.get(['lastReport'], (result) => {
      sendResponse({ report: result.lastReport || null });
    });
    return true;
  }

  if (message.type === 'STORE_REPORT') {
    chrome.storage.local.set({ lastReport: message.report }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'FETCH_PROFILE') {
    // Open profile page in a hidden (minimised) tab, scrape after render, close it
    fetchProfileViaTab(message.username, message.url)
      .then(profileData => sendResponse({ success: true, profileData }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  return true;
});

// ── BADGE MANAGEMENT ──────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const isListing = tab.url.includes('ebay.co.uk/itm/') || tab.url.includes('ebay.com/itm/');
    if (isListing) {
      chrome.action.setBadgeText({ text: '!', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId });
    }
  }
});

// ── PROFILE FETCH VIA HIDDEN TAB ──────────────────────────────────────────────
async function fetchProfileViaTab(username, profileUrl) {
  return new Promise((resolve, reject) => {
    let profileTabId = null;
    const timeout = setTimeout(() => {
      // Clean up tab if it's still open
      if (profileTabId !== null) {
        chrome.tabs.remove(profileTabId).catch(() => {});
      }
      reject(new Error('Profile fetch timed out after 15s'));
    }, 15000);

    // Open profile page in background (not active, not in a window)
    chrome.tabs.create({
      url: profileUrl,
      active: false,        // don't switch to it
      pinned: false,
    }, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        return reject(new Error(chrome.runtime.lastError.message));
      }

      profileTabId = tab.id;

      // Wait for the tab to fully load (JS rendered)
      const onUpdated = (tabId, changeInfo) => {
        if (tabId !== profileTabId) return;
        if (changeInfo.status !== 'complete') return;

        chrome.tabs.onUpdated.removeListener(onUpdated);

        // Give eBay's JS 2 extra seconds to inject dynamic content
        setTimeout(() => {
          chrome.scripting.executeScript({
            target: { tabId: profileTabId },
            func: scrapeProfilePage,
            args: [username],
          }, (results) => {
            // Always close the tab
            chrome.tabs.remove(profileTabId).catch(() => {});
            clearTimeout(timeout);

            if (chrome.runtime.lastError) {
              return reject(new Error(chrome.runtime.lastError.message));
            }

            const result = results?.[0]?.result;
            if (result) {
              console.log('[TrustScore BG] Profile scraped:', result);
              resolve(result);
            } else {
              reject(new Error('No result from profile scrape'));
            }
          });
        }, 2000);
      };

      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

// ── PROFILE PAGE SCRAPER (runs inside the profile tab) ───────────────────────
// This function is serialised and injected into the rendered profile page
// so it has full access to the JS-rendered DOM
function scrapeProfilePage(username) {
  const result = {
    username,
    accountAgeDays: null,
    memberSinceText: null,
    starRatings: {},
    debug: {},
  };

  try {
    const bodyText = document.body.innerText || '';
    result.debug.bodyLength = bodyText.length;
    result.debug.pageTitle = document.title;

    // ── Member since ───────────────────────────────────────────────────────
    // Try data-testid elements first (eBay's structured markup)
    const allEls = [...document.querySelectorAll('[data-testid], span, div, p, li')];

    // Look for element whose text contains a year and "member" or "since"
    const memberPatterns = [
      /member\s+since[:\s]+([A-Za-z0-9 ,\-\/]+\d{4})/i,
      /registered[:\s]+([A-Za-z0-9 ,\-\/]+\d{4})/i,
    ];

    let memberRaw = null;

    // First: search all text nodes
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const txt = node.textContent.trim();
      if (txt.length < 5 || txt.length > 100) continue;
      for (const pattern of memberPatterns) {
        const m = txt.match(pattern);
        if (m) { memberRaw = m[1].trim(); break; }
      }
      if (memberRaw) break;
    }

    // Second: search full body text (catches multi-node text)
    if (!memberRaw) {
      for (const pattern of memberPatterns) {
        const m = bodyText.match(pattern);
        if (m) { memberRaw = m[1].trim(); break; }
      }
    }

    // Third: look for date-like strings near "member" keyword
    if (!memberRaw) {
      const memberIdx = bodyText.toLowerCase().indexOf('member');
      if (memberIdx !== -1) {
        const nearby = bodyText.slice(memberIdx, memberIdx + 60);
        result.debug.memberNearby = nearby;
        const dateMatch = nearby.match(/(\d{1,2}[\s\-\/]\w+[\s\-\/]\d{4}|\w+\s+\d{4}|\d{4})/);
        if (dateMatch) memberRaw = dateMatch[1];
      }
    }

    if (memberRaw) {
      result.memberSinceText = memberRaw;
      result.debug.memberSinceRaw = memberRaw;

      // Parse to days
      try {
        const parsed = new Date(memberRaw);
        if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1990) {
          result.accountAgeDays = Math.floor((Date.now() - parsed.getTime()) / 86400000);
        }
      } catch (e) {}

      // If standard parse failed, try extracting year only
      if (!result.accountAgeDays) {
        const yearMatch = memberRaw.match(/(\d{4})/);
        if (yearMatch) {
          const year = parseInt(yearMatch[1]);
          if (year > 1990 && year <= new Date().getFullYear()) {
            // Estimate: assume Jan 1 of that year
            result.accountAgeDays = Math.floor((Date.now() - new Date(`${year}-01-01`).getTime()) / 86400000);
            result.debug.yearOnlyEstimate = true;
          }
        }
      }
    }

    // ── Detailed star ratings ──────────────────────────────────────────────
    const starPatterns = {
      itemAsDescribed: /item\s+as\s+described[^\d]*([\d.]+)/i,
      communication:   /communication[^\d]*([\d.]+)/i,
      dispatchTime:    /dispatch\s+time[^\d]*([\d.]+)/i,
      postage:         /postage[^\d]*([\d.]+)/i,
    };

    for (const [key, regex] of Object.entries(starPatterns)) {
      const m = bodyText.match(regex);
      if (m) {
        const val = parseFloat(m[1]);
        if (val >= 1.0 && val <= 5.0) result.starRatings[key] = val;
      }
    }

    // ── Sample body text for debugging ────────────────────────────────────
    // Grab first 500 chars that contain letters (skip nav/script noise)
    const lines = bodyText.split('\n').filter(l => l.trim().length > 10 && /[a-zA-Z]{3}/.test(l));
    result.debug.bodySample = lines.slice(0, 15).join(' | ').slice(0, 400);

  } catch (err) {
    result.debug.error = err.message;
  }

  return result;
}
