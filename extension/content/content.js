/**
 * eBay TrustScore — Content Script v4
 *
 * Flow:
 *   1. Scrape listing page → feedback count, %, username, listing issues
 *   2. Fetch ebay.co.uk/usr/{username} → real account age + 4 star ratings
 *   3. Show preliminary score immediately, update with enriched data
 *
 * Principle: only penalise on CONFIRMED signals, neutral defaults otherwise.
 */

(function () {
  'use strict';

  // ── UTILITIES ─────────────────────────────────────────────────────────────

  function searchText(regex, root) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const m = node.textContent.match(regex);
      if (m) return m;
    }
    return null;
  }

  function trySelectors(selectors, root) {
    for (const sel of selectors) {
      try {
        const el = (root || document).querySelector(sel);
        if (el && el.textContent.trim()) return el;
      } catch (e) {}
    }
    return null;
  }

  function daysSince(dateStr) {
    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime()) && d.getFullYear() > 1990) {
        return Math.floor((Date.now() - d.getTime()) / 86400000);
      }
    } catch (e) {}
    return null;
  }

  // ── STEP 1: SCRAPE LISTING PAGE ───────────────────────────────────────────

  function scrapeListingPage() {
    const data = { listingIssues: [], _debug: {} };

    // Feedback count — CONFIRMED: (299) inside x-sellercard-atf__about-seller
    let feedbackCount = null;
    const aboutEls = document.querySelectorAll('[data-testid="x-sellercard-atf__about-seller"]');
    for (const el of aboutEls) {
      const m = el.textContent.match(/\((\d[\d,]+)\)/);
      if (m) { feedbackCount = parseInt(m[1].replace(/,/g, '')); break; }
    }
    if (feedbackCount === null) {
      const card = document.querySelector('[data-testid="x-sellercard-atf"]');
      if (card) {
        const m = card.textContent.match(/\((\d[\d,]+)\)/);
        if (m) feedbackCount = parseInt(m[1].replace(/,/g, ''));
      }
    }
    if (feedbackCount === null) {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try { const j = JSON.parse(s.textContent); const rc = j?.seller?.ratingCount || j?.aggregateRating?.ratingCount; if (rc) { feedbackCount = parseInt(rc); break; } } catch (e) {}
      }
    }
    data.feedbackCount = feedbackCount ?? 0;

    // Feedback % — CONFIRMED: "98.4% positive" in x-sellercard-atf__data-item
    let feedbackPercent = null;
    for (const el of document.querySelectorAll('[data-testid="x-sellercard-atf__data-item"]')) {
      const m = el.textContent.match(/([\d.]+)%\s*positive/i);
      if (m) { feedbackPercent = parseFloat(m[1]); break; }
    }
    if (feedbackPercent === null) {
      const m = searchText(/([\d.]+)%\s*positive/i);
      if (m) feedbackPercent = parseFloat(m[1]);
    }
    data.feedbackPercent = feedbackPercent;
    data._feedbackPercentConfirmed = feedbackPercent !== null;

    // Seller username — from href of seller card links
    let sellerUsername = null;
    for (const link of document.querySelectorAll('[data-testid="x-sellercard-atf"] a, [data-testid="x-sellercard-atf__about-seller"] a')) {
      const m = (link.href || '').match(/\/(?:sch|usr|str)\/([^/?&#]+)/);
      if (m && m[1] && m[1].length > 1 && !m[1].startsWith('ebay')) { sellerUsername = m[1]; break; }
    }
    if (!sellerUsername) {
      for (const link of document.querySelectorAll('a[href*="/sch/"][href*="/m.html"]')) {
        const m = link.href.match(/\/sch\/([^/?&#]+)\/m\.html/);
        if (m) { sellerUsername = m[1]; break; }
      }
    }
    data.sellerUsername = sellerUsername;

    // Title
    const titleEl = trySelectors(['.x-item-title__mainTitle .ux-textspans--BOLD', '.x-item-title__mainTitle .ux-textspans', '.x-item-title__mainTitle', 'h1']);
    data.title = titleEl ? titleEl.textContent.trim().slice(0, 120) : 'eBay Listing';

    // Price
    const priceEl = trySelectors(['.x-price-primary .ux-textspans--BOLD', '.x-price-primary .ux-textspans', '[data-testid="x-price-primary"] span', '[itemprop="price"]', '#prcIsum']);
    if (priceEl) {
      const m = (priceEl.getAttribute('content') || priceEl.textContent).replace(/,/g, '').match(/[\d]+\.?\d*/);
      data.currentPrice = m ? parseFloat(m[0]) : null;
    }
    data._priceConfirmed = false;
    data.priceVsMarket = 1.0;

    // Returns
    const bodyText = document.body.innerText.toLowerCase();
    if (['no returns', 'seller does not accept returns', 'no return accepted'].some(t => bodyText.includes(t))) {
      data.listingIssues.push('no_returns');
    }

    // Overseas seller
    const ukTerms = ['united kingdom', ' uk', 'england', 'scotland', 'wales', 'northern ireland', 'london', 'manchester', 'birmingham', 'leeds', 'bristol'];
    const locEl = trySelectors(['[data-testid="ux-labels-values--item-location"] span', '.ux-labels-values--item-location .ux-textspans']);
    let locText = locEl?.textContent?.toLowerCase() || '';
    if (!locText) { const m = searchText(/item\s+location\s*:?\s*([A-Za-z ,]{3,40})/i); if (m) locText = m[1].toLowerCase(); }
    if (locText.length > 2 && !ukTerms.some(t => locText.includes(t))) {
      data.listingIssues.push('overseas_seller');
      data.itemLocation = locText.trim().slice(0, 50);
    }

    // Quantity
    const qtyM = searchText(/(\d+)\s+available/i);
    if (qtyM && parseInt(qtyM[1]) > 50) data.listingIssues.push('high_quantity');

    // Business seller
    data.isBusiness = [...aboutEls].some(el => el.textContent.toLowerCase().includes('business'))
      || bodyText.includes('registered as a business seller');

    // Account age defaults — will be replaced by profile fetch
    data._accountAgeConfirmed = false;
    data.accountAgeDays = 730;
    data.memberSinceText = null;
    data.starRatings = null;

    console.log('[TrustScore v4] Listing scraped:', {
      feedbackCount: data.feedbackCount,
      feedbackPercent: data.feedbackPercent,
      sellerUsername: data.sellerUsername,
      isBusiness: data.isBusiness,
      listingIssues: data.listingIssues,
    });

    return data;
  }

  // ── STEP 2: FETCH SELLER PROFILE via background tab ──────────────────────
  // eBay profile pages are JS-rendered — fetch() only gets a blank shell.
  // Background service worker opens profile in a hidden tab, waits for JS to
  // render, scrapes the live DOM, then closes the tab automatically.

  async function fetchSellerProfile(username) {
    const empty = { accountAgeDays: null, memberSinceText: null, starRatings: null };
    if (!username) return empty;

    return new Promise((resolve) => {
      const profileUrl = `https://www.ebay.co.uk/usr/${username}`;
      console.log('[TrustScore v4] Requesting hidden-tab profile scrape:', profileUrl);

      chrome.runtime.sendMessage(
        { type: 'FETCH_PROFILE', username, url: profileUrl },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[TrustScore v4] Profile error:', chrome.runtime.lastError.message);
            return resolve(empty);
          }
          if (!response?.success) {
            console.warn('[TrustScore v4] Profile scrape failed:', response?.error);
            return resolve(empty);
          }
          const p = response.profileData;
          console.log('[TrustScore v4] Profile data received:', {
            memberSince: p.memberSinceText,
            accountAgeDays: p.accountAgeDays,
            stars: p.starRatings,
            debug: p.debug,
          });
          resolve({
            accountAgeDays:  p.accountAgeDays  ?? null,
            memberSinceText: p.memberSinceText ?? null,
            starRatings:     p.starRatings && Object.keys(p.starRatings).length > 0 ? p.starRatings : null,
          });
        }
      );
    });
  }
  // ── OVERLAY ───────────────────────────────────────────────────────────────

  function buildOverlayHTML(report, d) {
    const { score, riskLevel, riskLabel, riskColor, summary, flags, breakdown } = report;

    const breakdownLabels = {
      feedbackVolume:     'Seller Ratings',
      feedbackRate:       'Positive Rate',
      accountAge:         'Account Age',
      priceAnomaly:       'Price Analysis',
      listingQuality:     'Listing Quality',
      deliveryComplaints: 'Delivery Record',
    };

    const breakdownHTML = Object.entries(breakdown).map(([key, val]) => {
      // Price analysis excluded — skip row entirely
      if (val === null) return '';
      const pct = Math.round((val.score / val.max) * 100);
      const color = pct >= 75 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
      const est = val.confirmed === false ? ' <span style="opacity:.5;font-size:9px" title="Estimated — awaiting profile data">~</span>' : '';
      return `<div class="ts-bar-row">
        <span class="ts-bar-label">${breakdownLabels[key] || key}${est}</span>
        <div class="ts-bar-track"><div class="ts-bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="ts-bar-pts">${val.score}/${val.max}</span>
      </div>`;
    }).join('');

    const flagsHTML = flags.map(f =>
      `<div class="ts-flag ts-flag--${f.type}">
        <span class="ts-flag-icon">${f.type === 'danger' ? '⚠' : f.type === 'warning' ? '●' : 'ℹ'}</span>
        <span>${f.message}</span>
      </div>`
    ).join('');

    // Data summary line
    const fcStr = d.feedbackCount > 0 ? `${d.feedbackCount.toLocaleString()} seller ratings` : 'Ratings not found';
    const fpStr = d.feedbackPercent ? `${d.feedbackPercent.toFixed(1)}% positive` : '—';
    const ageStr = d._accountAgeConfirmed && d.memberSinceText
      ? `Member since ${d.memberSinceText}`
      : d._accountAgeConfirmed
        ? `${Math.round(d.accountAgeDays / 365)}yr account`
        : 'Account age pending…';

    // Star ratings
    const sr = d.starRatings;
    const starLabels = { itemAsDescribed: 'Item as Described', communication: 'Communication', dispatchTime: 'Dispatch Time', postage: 'Postage' };
    const starHTML = sr && Object.keys(sr).length > 0 ? `
      <div class="ts-stars">
        <div class="ts-stars-title">Detailed Seller Ratings</div>
        ${Object.entries(starLabels).filter(([k]) => sr[k] != null).map(([k, label]) => `
          <div class="ts-star-row">
            <span class="ts-star-label">${label}</span>
            <span class="ts-star-val" style="color:${sr[k] >= 4.8 ? '#10b981' : sr[k] >= 4.5 ? '#f59e0b' : '#ef4444'}">${sr[k].toFixed(1)} ★</span>
          </div>`).join('')}
      </div>` : '';

    const dangerCount = flags.filter(f => f.type === 'danger').length;
    const warnCount   = flags.filter(f => f.type === 'warning').length;

    return `
      <div class="ts-card ts-risk--${riskLevel}">
        <div class="ts-header">
          <div class="ts-brand"><span class="ts-logo">🛡</span><span class="ts-title">TrustScore</span></div>
          <div class="ts-score-badge" style="background:${riskColor}">
            <span class="ts-score-num">${score}</span><span class="ts-score-100">/100</span>
          </div>
        </div>

        <div class="ts-data-line">${fcStr} · ${fpStr} · ${ageStr}</div>

        <div class="ts-risk-bar"><div class="ts-risk-fill" style="width:${score}%;background:${riskColor}"></div></div>

        <div class="ts-risk-label" style="color:${riskColor}">
          ${riskLevel === 'low' ? '✓' : riskLevel === 'medium' ? '⚡' : '⚠'} ${riskLabel}
          ${dangerCount > 0 ? `<span class="ts-badge ts-badge--danger">${dangerCount} critical</span>` : ''}
          ${warnCount   > 0 ? `<span class="ts-badge ts-badge--warn">${warnCount} warnings</span>` : ''}
        </div>

        <p class="ts-summary">${summary}</p>
        <div class="ts-breakdown">${breakdownHTML}</div>
        ${starHTML}

        ${flags.length > 0 ? `<button class="ts-toggle">▼ Show details</button><div class="ts-flags">${flagsHTML}</div>` : ''}

        <div class="ts-footer">Powered by eBay TrustScore · <a href="https://github.com/meeral/ebay-trustscore" target="_blank">Open source</a></div>
      </div>`;
  }

  function injectOverlay(report, sellerData) {
    const existing = document.getElementById('ebay-trustscore-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ebay-trustscore-overlay';
    overlay.innerHTML = buildOverlayHTML(report, sellerData);

    const insertTargets = ['.x-bin-price', '.x-price-primary', '[data-testid="x-price-primary"]', '#prcIsum', '.vim.d-vi-VR-finalPrice', '#right-content', '#RightSummaryPanel'];
    let inserted = false;
    for (const sel of insertTargets) {
      const target = document.querySelector(sel);
      if (target?.parentNode) { target.parentNode.insertBefore(overlay, target.nextSibling); inserted = true; break; }
    }
    if (!inserted) (document.querySelector('main, #mainContent') || document.body).prepend(overlay);

    requestAnimationFrame(() => overlay.classList.add('ts-visible'));
    overlay.querySelector('.ts-toggle')?.addEventListener('click', () => {
      const d = overlay.querySelector('.ts-flags');
      const open = d.classList.toggle('ts-open');
      overlay.querySelector('.ts-toggle').textContent = open ? '▲ Hide details' : '▼ Show details';
    });
  }

  function scoreAndInject(sellerData) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'ANALYSE_LISTING', data: sellerData }, (response) => {
        if (response?.success) {
          injectOverlay(response.report, sellerData);
          resolve(response.report);
        } else resolve(null);
      });
    });
  }

  // ── MAIN ─────────────────────────────────────────────────────────────────

  async function init() {
    if (!window.location.href.includes('/itm/')) return;

    await new Promise(r => setTimeout(r, 1500));

    // Phase 1: immediate score from listing page
    const sellerData = scrapeListingPage();
    await scoreAndInject(sellerData);

    // Phase 2: enrich with real profile data, re-score
    if (sellerData.sellerUsername) {
      const profile = await fetchSellerProfile(sellerData.sellerUsername);

      if (profile.accountAgeDays !== null) {
        sellerData.accountAgeDays    = profile.accountAgeDays;
        sellerData._accountAgeConfirmed = true;
        sellerData.memberSinceText   = profile.memberSinceText;
      }
      if (profile.starRatings) sellerData.starRatings = profile.starRatings;

      const finalReport = await scoreAndInject(sellerData);
      if (finalReport) {
        chrome.runtime.sendMessage({ type: 'STORE_REPORT', report: { ...finalReport, sellerData } });
      }
    } else {
      chrome.runtime.sendMessage({ type: 'STORE_REPORT', report: { sellerData } });
      console.warn('[TrustScore v4] Could not extract seller username — profile fetch skipped');
    }
  }

  init();

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; setTimeout(init, 2500); }
  }).observe(document, { subtree: true, childList: true });

})();
