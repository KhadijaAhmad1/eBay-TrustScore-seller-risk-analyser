/**
 * eBay TrustScore — Background Service Worker v3
 *
 * Key design change: profile fetch is driven by chrome.tabs.onUpdated
 * (which keeps the service worker alive), NOT by a message from content script
 * (which arrives after the SW may have gone to sleep).
 *
 * Flow:
 *  1. Listing tab completes → SW wakes via onUpdated → injects content script
 *  2. Content script scrapes listing → sends LISTING_SCRAPED with username
 *  3. SW receives message (still awake) → opens hidden profile tab
 *  4. Profile tab completes → SW wakes again via onUpdated → injects scraper
 *  5. SW gets profile data → stores enriched report → tells listing tab to update overlay
 */

importScripts('scoring-engine.js');

// Track which listing tabs are awaiting profile enrichment
// { listingTabId → { sellerData, profileTabId } }
const pendingProfiles = {};

// ── MESSAGE ROUTER ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Step 1 score: content script sends full seller data for immediate scoring
  if (message.type === 'ANALYSE_LISTING') {
    const report = computeTrustScore(message.data);
    sendResponse({ success: true, report });
    return false;
  }

  // Content script tells us it has scraped the listing and found a username
  if (message.type === 'LISTING_SCRAPED') {
    const { sellerData, listingTabId } = message;
    console.log('[TrustScore SW] Listing scraped, username:', sellerData.sellerUsername);

    if (!sellerData.sellerUsername) {
      sendResponse({ success: false, reason: 'no username' });
      return false;
    }

    // Open hidden profile tab — SW stays awake because it owns this operation
    const profileUrl = `https://www.ebay.co.uk/usr/${sellerData.sellerUsername}`;

    chrome.tabs.create({ url: profileUrl, active: false }, (profileTab) => {
      if (chrome.runtime.lastError) {
        console.warn('[TrustScore SW] Could not open profile tab:', chrome.runtime.lastError.message);
        return;
      }
      console.log('[TrustScore SW] Profile tab opened:', profileTab.id, profileUrl);
      // Store state so onUpdated knows what to do when this tab loads
      pendingProfiles[profileTab.id] = {
        listingTabId: listingTabId || sender.tab?.id,
        sellerData,
        profileUrl,
      };
    });

    sendResponse({ success: true });
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

  return true;
});

// ── TAB LIFECYCLE ─────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  const isListing = tab.url.includes('ebay.co.uk/itm/') || tab.url.includes('ebay.com/itm/');

  // Badge management for listing tabs
  if (isListing) {
    chrome.action.setBadgeText({ text: '!', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId });
  }

  // Profile tab finished loading — scrape it
  if (pendingProfiles[tabId]) {
    const { listingTabId, sellerData } = pendingProfiles[tabId];
    console.log('[TrustScore SW] Profile tab loaded, scraping in 2s...', tabId);

    // Wait 2s for eBay's JS to render the profile content
    setTimeout(() => {
      chrome.scripting.executeScript(
        { target: { tabId }, func: scrapeProfileDOM },
        (results) => {
          // Always close the profile tab
          chrome.tabs.remove(tabId).catch(() => {});
          delete pendingProfiles[tabId];

          if (chrome.runtime.lastError) {
            console.warn('[TrustScore SW] Script injection failed:', chrome.runtime.lastError.message);
            return;
          }

          const profileData = results?.[0]?.result;
          if (!profileData) {
            console.warn('[TrustScore SW] No data returned from profile scrape');
            return;
          }

          console.log('[TrustScore SW] Profile scraped:', {
            memberSince: profileData.memberSinceText,
            accountAgeDays: profileData.accountAgeDays,
            stars: profileData.starRatings,
            bodySample: profileData.debug?.bodySample?.slice(0, 100),
          });

          // Merge profile data into seller data
          if (profileData.accountAgeDays) {
            sellerData.accountAgeDays = profileData.accountAgeDays;
            sellerData._accountAgeConfirmed = true;
            sellerData.memberSinceText = profileData.memberSinceText;
          }
          if (profileData.starRatings && Object.keys(profileData.starRatings).length > 0) {
            sellerData.starRatings = profileData.starRatings;
          }

          // Re-score with enriched data
          const enrichedReport = computeTrustScore(sellerData);

          // Store enriched report
          chrome.storage.local.set({
            lastReport: { ...enrichedReport, sellerData }
          });

          // Tell the listing tab to update its overlay
          if (listingTabId) {
            chrome.tabs.sendMessage(listingTabId, {
              type: 'UPDATE_OVERLAY',
              report: enrichedReport,
              sellerData,
            }).catch(() => {
              console.log('[TrustScore SW] Could not message listing tab — may have navigated away');
            });
          }
        }
      );
    }, 2000);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Clean up if profile tab was closed manually
  if (pendingProfiles[tabId]) {
    console.log('[TrustScore SW] Profile tab closed manually, cleaning up');
    delete pendingProfiles[tabId];
  }
});

// ── PROFILE PAGE SCRAPER (injected into live profile tab DOM) ─────────────────
function scrapeProfileDOM() {
  const result = {
    accountAgeDays: null,
    memberSinceText: null,
    starRatings: {},
    debug: {},
  };

  try {
    const bodyText = document.body.innerText || '';
    result.debug.bodyLength = bodyText.length;
    result.debug.pageTitle  = document.title;

    // Sample body for debugging
    const lines = bodyText.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 8 && /[a-zA-Z]{2}/.test(l));
    result.debug.bodySample = lines.slice(0, 20).join(' | ').slice(0, 600);

    // ── Member since ────────────────────────────────────────────────────────
    const patterns = [
      /member\s+since[:\s]+(\d{1,2}[\s\-]\w+[\s\-]\d{4})/i,   // 14 Jan 2018
      /member\s+since[:\s]+(\w+\s+\d{1,2},?\s+\d{4})/i,        // January 14, 2018
      /member\s+since[:\s]+(\d{4}-\d{2}-\d{2})/i,              // 2018-01-14
      /member\s+since[:\s]+(\w+\s+\d{4})/i,                    // January 2018
      /member\s+since[:\s]+(\w+-\d{2}-\d{2})/i,                // Jan-14-18
      /registered[:\s]+(\d{1,2}[\s\-]\w+[\s\-]\d{4})/i,
    ];

    let memberRaw = null;

    // Walk all text nodes
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const txt = node.textContent.trim();
      if (txt.length < 4 || txt.length > 120) continue;
      for (const p of patterns) {
        const m = txt.match(p);
        if (m) { memberRaw = m[1].trim(); break; }
      }
      if (memberRaw) break;
    }

    // Fallback: search full body text
    if (!memberRaw) {
      for (const p of patterns) {
        const m = bodyText.match(p);
        if (m) { memberRaw = m[1].trim(); break; }
      }
    }

    // Fallback: find "member" keyword then grab nearby date
    if (!memberRaw) {
      const idx = bodyText.toLowerCase().indexOf('member');
      if (idx !== -1) {
        const nearby = bodyText.slice(idx, idx + 80);
        result.debug.memberNearby = nearby;
        const dm = nearby.match(/(\d{1,2}[\s\-\/]\w+[\s\-\/]\d{4}|\w+\s+\d{4}|\d{4})/);
        if (dm) memberRaw = dm[1];
      }
    }

    result.debug.memberSinceRaw = memberRaw;

    if (memberRaw) {
      result.memberSinceText = memberRaw;
      const parsed = new Date(memberRaw);
      if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1990) {
        result.accountAgeDays = Math.floor((Date.now() - parsed.getTime()) / 86400000);
      } else {
        // Year-only fallback
        const ym = memberRaw.match(/(\d{4})/);
        if (ym) {
          const yr = parseInt(ym[1]);
          if (yr > 1990 && yr <= new Date().getFullYear()) {
            result.accountAgeDays = Math.floor((Date.now() - new Date(`${yr}-06-01`).getTime()) / 86400000);
            result.debug.yearOnlyFallback = true;
          }
        }
      }
    }

    // ── Star ratings ────────────────────────────────────────────────────────
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

  } catch (err) {
    result.debug.error = err.message;
  }

  return result;
}
