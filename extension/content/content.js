/**
 * eBay TrustScore — Content Script v2.1
 * Multi-strategy scraper with "innocent until proven guilty" principle:
 * only penalises on CONFIRMED signals, neutral defaults otherwise.
 */

(function () {
  'use strict';

  function searchPageText(regex) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const match = node.textContent.match(regex);
      if (match) return match;
    }
    return null;
  }

  function trySelectors(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) return el;
      } catch (e) {}
    }
    return null;
  }

  function scrapeListingData() {
    const data = { listingIssues: [], _debug: {} };

    // ── 1. FEEDBACK COUNT ─────────────────────────────────────────────────
    let feedbackCount = null;

    const sellerSection = document.querySelector(
      '[data-testid="str-title-section"], .str-seller-card, .x-sellercard-atf, [class*="seller-card"]'
    );
    if (sellerSection) {
      const boldEls = sellerSection.querySelectorAll('span, strong, b');
      for (const el of boldEls) {
        const txt = el.textContent.trim().replace(/,/g, '');
        const num = parseInt(txt);
        if (!isNaN(num) && num > 0 && num < 10000000 && txt === String(num)) {
          feedbackCount = num;
          data._debug.feedbackSource = 'sellerSection bold';
          break;
        }
      }
    }

    if (feedbackCount === null) {
      const match = searchPageText(/(\d[\d,]*)\s+feedback/i);
      if (match) { feedbackCount = parseInt(match[1].replace(/,/g, '')); data._debug.feedbackSource = 'pageText "X feedback"'; }
    }

    if (feedbackCount === null) {
      const links = document.querySelectorAll('a[href*="feedback"], a[href*="fdbk"]');
      for (const link of links) {
        const match = link.textContent.match(/(\d[\d,]+)/);
        if (match) { feedbackCount = parseInt(match[1].replace(/,/g, '')); data._debug.feedbackSource = 'feedback link'; break; }
      }
    }

    if (feedbackCount === null) {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const json = JSON.parse(s.textContent);
          const rc = json?.seller?.ratingCount || json?.aggregateRating?.ratingCount;
          if (rc) { feedbackCount = parseInt(rc); data._debug.feedbackSource = 'JSON-LD'; break; }
        } catch (e) {}
      }
    }

    data.feedbackCount = feedbackCount ?? 0;
    data._debug.feedbackCount = data.feedbackCount;

    // ── 2. FEEDBACK PERCENTAGE ────────────────────────────────────────────
    let feedbackPercent = null;

    const pctMatch = searchPageText(/([\d.]+)%\s*positive/i);
    if (pctMatch) { feedbackPercent = parseFloat(pctMatch[1]); data._debug.pctSource = '"X% positive"'; }

    if (feedbackPercent === null) {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const json = JSON.parse(s.textContent);
          const rv = json?.seller?.ratingValue || json?.aggregateRating?.ratingValue;
          if (rv) { const v = parseFloat(rv); feedbackPercent = v <= 5 ? (v/5)*100 : v; data._debug.pctSource = 'JSON-LD'; break; }
        } catch (e) {}
      }
    }

    // Note: we intentionally do NOT search for any random 90-100% number on the
    // page — that produced false positives. Only confirmed "X% positive" text is used.
    data.feedbackPercent = feedbackPercent ?? null;
    data._feedbackPercentConfirmed = feedbackPercent !== null;
    data._debug.feedbackPercent = data.feedbackPercent;

    // ── 3. ITEM TITLE ─────────────────────────────────────────────────────
    const titleEl = trySelectors([
      'h1.x-item-title__mainTitle span', 'h1[class*="title"] span',
      '.x-item-title__mainTitle', 'h1.it-ttl', '#itemTitle', 'h1',
    ]);
    data.title = titleEl ? titleEl.textContent.trim().slice(0, 120) : 'eBay Listing';

    // ── 4. PRICE ─────────────────────────────────────────────────────────
    const priceEl = trySelectors([
      '.x-price-primary .ux-textspans--BOLD',
      '[data-testid="x-price-primary"] span',
      '.notranslate[itemprop="price"]',
      '#prcIsum', '[itemprop="price"]', '.display-price',
    ]);
    if (priceEl) {
      const raw = priceEl.getAttribute('content') || priceEl.textContent;
      const match = raw.replace(/,/g, '').match(/[\d]+\.?\d*/);
      data.currentPrice = match ? parseFloat(match[0]) : null;
    }
    if (!data.currentPrice) {
      const pm = searchPageText(/[£$]([\d,]+\.?\d*)/);
      if (pm) data.currentPrice = parseFloat(pm[1].replace(/,/g, ''));
    }
    // Price vs market NOT simulated — stays unconfirmed, neutral score
    data._priceConfirmed = false;
    data.priceVsMarket = 1.0;

    // ── 5. RETURNS POLICY ─────────────────────────────────────────────────
    const bodyText = document.body.innerText.toLowerCase();
    const noReturnPhrases = ['no returns', 'seller does not accept returns'];
    if (noReturnPhrases.some(t => bodyText.includes(t))) {
      data.listingIssues.push('no_returns');
    }

    // ── 6. ITEM LOCATION / OVERSEAS ───────────────────────────────────────
    const ukTerms = ['united kingdom', ' uk ', 'england', 'scotland', 'wales',
      'northern ireland', 'london', 'manchester', 'birmingham', 'leeds', 'bristol'];
    const locationEl = trySelectors([
      '[data-testid="ux-labels-values--item-location"]',
      '[class*="item-location"]',
    ]);
    let locationText = '';
    if (locationEl) {
      locationText = locationEl.textContent.toLowerCase();
    } else {
      const locMatch = searchPageText(/item\s+location\s*:?\s*([^\n]{3,50})/i);
      if (locMatch) locationText = locMatch[1].toLowerCase();
    }
    if (locationText && !ukTerms.some(t => locationText.includes(t))) {
      data.listingIssues.push('overseas_seller');
      data.itemLocation = locationText.trim().slice(0, 40);
    }

    // ── 7. IMAGE COUNT ────────────────────────────────────────────────────
    // REMOVED — eBay lazy-loads images so count at injection time is always 0-1.
    // This was causing false "stock photo" flags on all listings.

    // ── 8. QUANTITY ───────────────────────────────────────────────────────
    const qtyMatch = searchPageText(/(\d+)\s+available/i);
    if (qtyMatch && parseInt(qtyMatch[1]) > 50) {
      data.listingIssues.push('high_quantity');
    }

    // ── 9. ACCOUNT AGE ────────────────────────────────────────────────────
    // Only confirmed if "member since" text is found on page. Never guessed.
    data._accountAgeConfirmed = false;
    data.accountAgeDays = 730;

    const memberMatch = searchPageText(/member\s+since[:\s]+(\w+[-\s]\w+[-\s]\d{4}|\d{4})/i);
    if (memberMatch) {
      try {
        const memberDate = new Date(memberMatch[1]);
        if (!isNaN(memberDate.getTime())) {
          data.accountAgeDays = Math.floor((Date.now() - memberDate.getTime()) / 86400000);
          data._accountAgeConfirmed = true;
          data._debug.accountAgeSource = memberMatch[1];
        }
      } catch (e) {}
    }

    // ── 10. DELIVERY RATE ─────────────────────────────────────────────────
    // Not scraped — scoring engine derives from feedback% if it's confirmed low.
    data.deliveryComplaintRate = 0;

    data._debug.finalData = {
      feedbackCount: data.feedbackCount,
      feedbackPercent: data.feedbackPercent,
      feedbackPercentConfirmed: data._feedbackPercentConfirmed,
      accountAgeDays: data.accountAgeDays,
      accountAgeConfirmed: data._accountAgeConfirmed,
      priceConfirmed: data._priceConfirmed,
      listingIssues: data.listingIssues,
      title: data.title,
    };

    console.log('[TrustScore] Scraped data:', data._debug);
    return data;
  }

  // ── OVERLAY: Inject TrustScore widget ────────────────────────────────────
  function injectOverlay(report, sellerData) {
    const existing = document.getElementById('ebay-trustscore-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ebay-trustscore-overlay';
    overlay.innerHTML = buildOverlayHTML(report, sellerData);

    // Try multiple insert points
    const insertTargets = [
      '.x-bin-price',
      '.x-price-primary',
      '[data-testid="x-price-primary"]',
      '#prcIsum',
      '.display-price',
      '.vim.d-vi-VR-finalPrice',
      '#right-content .x-shipping-details',
      '#right-content',
      '#RightSummaryPanel',
    ];

    let inserted = false;
    for (const selector of insertTargets) {
      const target = document.querySelector(selector);
      if (target && target.parentNode) {
        target.parentNode.insertBefore(overlay, target.nextSibling);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      const main = document.querySelector('main, #mainContent, #vi-main-img-fs');
      if (main) main.prepend(overlay);
      else document.body.prepend(overlay);
    }

    requestAnimationFrame(() => overlay.classList.add('ts-visible'));

    overlay.querySelector('.ts-toggle')?.addEventListener('click', () => {
      const details = overlay.querySelector('.ts-flags');
      const isOpen = details.classList.toggle('ts-open');
      overlay.querySelector('.ts-toggle').textContent = isOpen ? '▲ Hide details' : '▼ Show details';
    });
  }

  function buildOverlayHTML(report, sellerData) {
    const { score, riskLevel, riskLabel, riskColor, summary, flags, breakdown } = report;

    const flagsHTML = flags.map(f => `
      <div class="ts-flag ts-flag--${f.type}">
        <span class="ts-flag-icon">${f.type === 'danger' ? '⚠' : f.type === 'warning' ? '●' : 'ℹ'}</span>
        <span>${f.message}</span>
      </div>
    `).join('');

    const breakdownHTML = Object.entries(breakdown).map(([key, val]) => {
      const labels = {
        feedbackVolume: 'Feedback Volume',
        feedbackRate: 'Positive Rate',
        accountAge: 'Account Age',
        priceAnomaly: 'Price Analysis',
        listingQuality: 'Listing Quality',
        deliveryComplaints: 'Delivery Record'
      };
      const pct = Math.round((val.score / val.max) * 100);
      return `
        <div class="ts-bar-row">
          <span class="ts-bar-label">${labels[key] || key}</span>
          <div class="ts-bar-track">
            <div class="ts-bar-fill" style="width:${pct}%;background:${pct >= 75 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444'}"></div>
          </div>
          <span class="ts-bar-pts">${val.score}/${val.max}</span>
        </div>`;
    }).join('');

    const dangerCount = flags.filter(f => f.type === 'danger').length;
    const warnCount = flags.filter(f => f.type === 'warning').length;

    // Show what was actually scraped
    const scraped = sellerData?._debug?.finalData;
    const dataLine = scraped
      ? `${scraped.feedbackCount.toLocaleString()} reviews · ${scraped.feedbackPercent.toFixed(1)}% positive · ${scraped.accountAgeDays}d old account`
      : '';

    return `
      <div class="ts-card ts-risk--${riskLevel}">
        <div class="ts-header">
          <div class="ts-brand">
            <span class="ts-logo">🛡</span>
            <span class="ts-title">TrustScore</span>
            ${dataLine ? `<span class="ts-data-line">${dataLine}</span>` : ''}
          </div>
          <div class="ts-score-badge" style="background:${riskColor}">
            <span class="ts-score-num">${score}</span>
            <span class="ts-score-100">/100</span>
          </div>
        </div>

        <div class="ts-risk-bar">
          <div class="ts-risk-fill" style="width:${score}%;background:${riskColor}"></div>
        </div>

        <div class="ts-risk-label" style="color:${riskColor}">
          ${riskLevel === 'low' ? '✓' : riskLevel === 'medium' ? '⚡' : '⚠'} ${riskLabel}
          ${dangerCount > 0 ? `<span class="ts-badge ts-badge--danger">${dangerCount} critical</span>` : ''}
          ${warnCount > 0 ? `<span class="ts-badge ts-badge--warn">${warnCount} warnings</span>` : ''}
        </div>

        <p class="ts-summary">${summary}</p>
        <div class="ts-breakdown">${breakdownHTML}</div>

        ${flags.length > 0 ? `
          <button class="ts-toggle">▼ Show details</button>
          <div class="ts-flags">${flagsHTML}</div>
        ` : ''}

        <div class="ts-footer">
          Powered by eBay TrustScore · <a href="https://github.com/meeral/ebay-trustscore" target="_blank">Open source</a>
        </div>
      </div>`;
  }

  // ── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    if (!window.location.href.includes('/itm/')) return;

    // Wait for page to settle before scraping
    setTimeout(() => {
      const sellerData = scrapeListingData();

      chrome.runtime.sendMessage(
        { type: 'ANALYSE_LISTING', data: sellerData },
        (response) => {
          if (response?.success) {
            injectOverlay(response.report, sellerData);
            chrome.runtime.sendMessage({
              type: 'STORE_REPORT',
              report: { ...response.report, sellerData }
            });
          }
        }
      );
    }, 1500); // wait 1.5s for dynamic content to load
  }

  init();

  // Re-run on eBay SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(init, 2500);
    }
  }).observe(document, { subtree: true, childList: true });

})();
