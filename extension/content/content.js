/**
 * eBay TrustScore — Content Script v2
 * Multi-strategy scraper: tries many selectors + full-page text search as fallback
 * Works across eBay UK and eBay US listing pages
 */

(function () {
  'use strict';

  // ── UTILITY: search all text nodes on page for a regex ───────────────────
  function searchPageText(regex) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const match = node.textContent.match(regex);
      if (match) return match;
    }
    return null;
  }

  // ── UTILITY: try a list of selectors, return first match ─────────────────
  function trySelectors(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) return el;
      } catch (e) { /* invalid selector, skip */ }
    }
    return null;
  }

  // ── UTILITY: find element whose text matches a regex ─────────────────────
  function findByText(tag, regex) {
    const els = document.querySelectorAll(tag);
    for (const el of els) {
      if (regex.test(el.textContent)) return el;
    }
    return null;
  }

  // ── SCRAPER ───────────────────────────────────────────────────────────────
  function scrapeListingData() {
    const data = { listingIssues: [], _debug: {} };

    // ── 1. FEEDBACK COUNT ─────────────────────────────────────────────────
    // Strategy A: data-testid attributes (eBay's current structure)
    let feedbackCount = null;

    const feedbackSelectors = [
      '[data-testid="str-title"] + [data-testid="str-rating"]',
      '.str-seller-card__feedback-cnt',
      '.mbg-l .mbg-cnt',
      '.ux-seller-section .ux-textspans--BOLD',
      '[class*="feedback"] [class*="count"]',
      '[class*="feedback-count"]',
      '.str-seller-card a span',
    ];

    // Try all eBay seller info sections
    const sellerSection = document.querySelector(
      '[data-testid="str-title-section"], .str-seller-card, .x-sellercard-atf, [class*="seller-card"]'
    );

    if (sellerSection) {
      // Look for a bold number inside the seller section
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

    // Strategy B: look for "X feedback" pattern anywhere on page
    if (feedbackCount === null) {
      const match = searchPageText(/(\d[\d,]*)\s+feedback/i);
      if (match) {
        feedbackCount = parseInt(match[1].replace(/,/g, ''));
        data._debug.feedbackSource = 'pageText "X feedback"';
      }
    }

    // Strategy C: look for "seller's other items" link with feedback count
    if (feedbackCount === null) {
      const links = document.querySelectorAll('a[href*="feedback"], a[href*="fdbk"]');
      for (const link of links) {
        const match = link.textContent.match(/(\d[\d,]+)/);
        if (match) {
          feedbackCount = parseInt(match[1].replace(/,/g, ''));
          data._debug.feedbackSource = 'feedback link';
          break;
        }
      }
    }

    // Strategy D: structured data in script tags
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

    // Strategy A: look for "X% positive feedback" pattern
    const pctMatch = searchPageText(/([\d.]+)%\s*positive/i);
    if (pctMatch) {
      feedbackPercent = parseFloat(pctMatch[1]);
      data._debug.pctSource = 'pageText "X% positive"';
    }

    // Strategy B: any percentage near "feedback" text
    if (feedbackPercent === null) {
      const allText = document.body.innerText;
      const matches = [...allText.matchAll(/([\d.]+)%/g)];
      for (const m of matches) {
        const val = parseFloat(m[1]);
        if (val >= 90 && val <= 100) {
          feedbackPercent = val;
          data._debug.pctSource = 'body text percentage 90-100';
          break;
        }
      }
    }

    // Strategy C: JSON-LD ratingValue
    if (feedbackPercent === null) {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const json = JSON.parse(s.textContent);
          const rv = json?.seller?.ratingValue || json?.aggregateRating?.ratingValue;
          if (rv) {
            const v = parseFloat(rv);
            feedbackPercent = v <= 5 ? (v / 5) * 100 : v;
            data._debug.pctSource = 'JSON-LD ratingValue';
            break;
          }
        } catch (e) {}
      }
    }

    data.feedbackPercent = feedbackPercent ?? 99.0;
    data._debug.feedbackPercent = data.feedbackPercent;

    // ── 3. ITEM TITLE ─────────────────────────────────────────────────────
    const titleEl = trySelectors([
      'h1.x-item-title__mainTitle span',
      'h1[class*="title"] span',
      '.x-item-title__mainTitle',
      'h1.it-ttl',
      '#itemTitle',
      'h1',
    ]);
    data.title = titleEl ? titleEl.textContent.trim().slice(0, 120) : 'eBay Listing';

    // ── 4. ITEM PRICE ─────────────────────────────────────────────────────
    const priceEl = trySelectors([
      '.x-price-primary [class*="price"] .ux-textspans',
      '.x-price-primary .ux-textspans--BOLD',
      '[data-testid="x-price-primary"] span',
      '.notranslate[itemprop="price"]',
      '#prcIsum',
      '[itemprop="price"]',
      '.display-price',
    ]);

    if (priceEl) {
      const raw = priceEl.getAttribute('content') || priceEl.textContent;
      const match = raw.replace(/,/g, '').match(/[\d]+\.?\d*/);
      data.currentPrice = match ? parseFloat(match[0]) : null;
    }

    // Fallback: look for £ or $ price in page text
    if (!data.currentPrice) {
      const priceMatch = searchPageText(/[£$]([\d,]+\.?\d*)/);
      if (priceMatch) data.currentPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
    }

    // Simulate price vs market (±15% randomised per listing based on price)
    // In production this would call eBay sold listings API
    if (data.currentPrice) {
      const seed = (data.currentPrice * 1000) % 100;
      data.priceVsMarket = 0.85 + (seed / 100) * 0.6; // 0.85–1.45 range
    } else {
      data.priceVsMarket = 1.0;
    }

    // ── 5. RETURNS POLICY ─────────────────────────────────────────────────
    const returnsTexts = ['no returns', 'seller does not accept returns', 'no return'];
    const bodyText = document.body.innerText.toLowerCase();
    const hasNoReturns = returnsTexts.some(t => bodyText.includes(t));

    // Also check specific elements
    const returnsEl = trySelectors([
      '[data-testid="ux-labels-values--returns"]',
      '[class*="returns"] [class*="value"]',
      '.ux-labels-values__values--returns',
    ]);

    if (hasNoReturns || (returnsEl && returnsEl.textContent.toLowerCase().includes('no return'))) {
      data.listingIssues.push('no_returns');
    }

    // ── 6. ITEM LOCATION / OVERSEAS ───────────────────────────────────────
    const ukTerms = ['united kingdom', 'uk', 'england', 'scotland', 'wales', 'northern ireland',
      'london', 'manchester', 'birmingham', 'leeds', 'glasgow', 'bristol'];

    // Look for location label
    const locationEl = trySelectors([
      '[data-testid="ux-labels-values--item-location"]',
      '[class*="item-location"]',
      '.ux-labels-values__values--item-location',
    ]);

    let locationText = '';
    if (locationEl) {
      locationText = locationEl.textContent.toLowerCase();
    } else {
      // Search page for location patterns
      const locMatch = searchPageText(/item location\s*:?\s*([^\n]+)/i);
      if (locMatch) locationText = locMatch[1].toLowerCase();
    }

    if (locationText && !ukTerms.some(t => locationText.includes(t))) {
      data.listingIssues.push('overseas_seller');
      data.itemLocation = locationText.trim();
    }

    // ── 7. IMAGE COUNT ────────────────────────────────────────────────────
    const imageSelectors = [
      '.ux-image-carousel-item img',
      '[class*="image-carousel"] img',
      '[class*="pic-col"] img',
      '.img-gallery img',
      '[data-testid*="image"] img',
    ];

    let imageCount = 0;
    for (const sel of imageSelectors) {
      const imgs = document.querySelectorAll(sel);
      if (imgs.length > 0) { imageCount = imgs.length; break; }
    }

    // Also count thumbnail images
    if (imageCount === 0) {
      const thumbs = document.querySelectorAll('[class*="thumb"] img, [class*="thumbnail"] img');
      imageCount = thumbs.length;
    }

    if (imageCount <= 1) {
      data.listingIssues.push('stock_photo_only');
    }

    // ── 8. QUANTITY ───────────────────────────────────────────────────────
    const qtyMatch = searchPageText(/(\d+)\s+available/i) || searchPageText(/(\d+)\s+sold/i);
    if (qtyMatch && parseInt(qtyMatch[1]) > 50) {
      data.listingIssues.push('high_quantity');
    }

    // ── 9. DESCRIPTION LENGTH ─────────────────────────────────────────────
    const descFrame = document.querySelector('#desc_ifr, iframe[id*="desc"]');
    if (descFrame) {
      try {
        const descText = descFrame.contentDocument?.body?.innerText || '';
        if (descText.trim().length < 80) data.listingIssues.push('vague_description');
      } catch (e) {}
    }

    // ── 10. ACCOUNT AGE ───────────────────────────────────────────────────
    // eBay shows "member since" on seller profile - we approximate from feedback volume
    // In production: fetch seller profile page
    // Heuristic: very low feedback + low% suggests new account
    let accountAgeDays = 730; // default 2 years

    if (data.feedbackCount < 5 && data.feedbackPercent < 95) {
      accountAgeDays = 30;
    } else if (data.feedbackCount < 20) {
      accountAgeDays = 90;
    } else if (data.feedbackCount < 100) {
      accountAgeDays = 365;
    } else if (data.feedbackCount >= 1000) {
      accountAgeDays = 1825; // 5 years
    }

    // Check if "member since" text exists on page
    const memberMatch = searchPageText(/member\s+since[:\s]+(\w+\s+\w+\s+\d{4}|\d{4})/i);
    if (memberMatch) {
      try {
        const memberDate = new Date(memberMatch[1]);
        if (!isNaN(memberDate)) {
          accountAgeDays = Math.floor((Date.now() - memberDate.getTime()) / (1000 * 60 * 60 * 24));
          data._debug.accountAgeSource = 'member since text';
        }
      } catch (e) {}
    }

    data.accountAgeDays = Math.max(1, accountAgeDays);

    // ── 11. DELIVERY COMPLAINT RATE ───────────────────────────────────────
    // Derive from feedback score: lower % → higher complaint estimate
    // In production: scrape eBay's detailed seller ratings
    let deliveryComplaintRate = 0.5;
    if (data.feedbackPercent < 95) deliveryComplaintRate = 6.0;
    else if (data.feedbackPercent < 97) deliveryComplaintRate = 3.5;
    else if (data.feedbackPercent < 98) deliveryComplaintRate = 2.0;
    else if (data.feedbackPercent < 99) deliveryComplaintRate = 1.2;
    else if (data.feedbackPercent >= 99.5) deliveryComplaintRate = 0.3;

    data.deliveryComplaintRate = deliveryComplaintRate;

    data._debug.finalData = {
      feedbackCount: data.feedbackCount,
      feedbackPercent: data.feedbackPercent,
      accountAgeDays: data.accountAgeDays,
      priceVsMarket: data.priceVsMarket,
      deliveryComplaintRate: data.deliveryComplaintRate,
      listingIssues: data.listingIssues,
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
