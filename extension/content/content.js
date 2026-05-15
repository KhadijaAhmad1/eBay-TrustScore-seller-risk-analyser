/**
 * eBay TrustScore — Content Script
 * Scrapes listing data from eBay pages and injects the TrustScore overlay
 */

(function () {
  'use strict';

  // ── SCRAPER: Extract seller data from eBay listing page ──────────────────
  function scrapeListingData() {
    const data = {};

    // Seller feedback count
    const feedbackEl = document.querySelector('[data-testid="ux-seller-section__item--feedback"] .ux-textspans--BOLD')
      || document.querySelector('.mbg-feedback-number')
      || document.querySelector('.ux-seller-info__item--feedback .ux-textspans');
    if (feedbackEl) {
      data.feedbackCount = parseInt(feedbackEl.textContent.replace(/,/g, '').trim()) || 0;
    } else {
      data.feedbackCount = 0;
    }

    // Feedback percentage
    const feedbackPctEl = document.querySelector('[data-testid="ux-seller-section__item--feedback"] .ux-textspans:not(.ux-textspans--BOLD)')
      || document.querySelector('.mbg-feedback-percentage');
    if (feedbackPctEl) {
      const match = feedbackPctEl.textContent.match(/([\d.]+)%/);
      data.feedbackPercent = match ? parseFloat(match[1]) : 99.0;
    } else {
      data.feedbackPercent = 99.0;
    }

    // Item price
    const priceEl = document.querySelector('.x-price-primary .ux-textspans')
      || document.querySelector('.x-bin-price__content .ux-textspans')
      || document.querySelector('[itemprop="price"]');
    if (priceEl) {
      const match = priceEl.textContent.match(/[\d,]+\.?\d*/);
      data.currentPrice = match ? parseFloat(match[0].replace(/,/g, '')) : null;
    }

    // Item title
    const titleEl = document.querySelector('.x-item-title__mainTitle .ux-textspans')
      || document.querySelector('#itemTitle');
    data.title = titleEl ? titleEl.textContent.trim() : '';

    // Returns policy
    const returnsEl = document.querySelector('[data-testid="ux-labels-values--returns"]');
    data.listingIssues = [];
    if (returnsEl && returnsEl.textContent.toLowerCase().includes('no returns')) {
      data.listingIssues.push('no_returns');
    }

    // Item location / overseas check
    const locationEl = document.querySelector('[data-testid="ux-labels-values--item-location"]')
      || document.querySelector('.ux-labels-values--item-location');
    if (locationEl) {
      const loc = locationEl.textContent.toLowerCase();
      if (!loc.includes('united kingdom') && !loc.includes('uk') && !loc.includes('england')
        && !loc.includes('scotland') && !loc.includes('wales')) {
        data.listingIssues.push('overseas_seller');
        data.itemLocation = locationEl.textContent.trim();
      }
    }

    // Quantity available
    const qtyEl = document.querySelector('[data-testid="x-quantity__select-box"]')
      || document.querySelector('.qtySubTxt');
    if (qtyEl) {
      const match = qtyEl.textContent.match(/(\d+)/);
      if (match && parseInt(match[1]) > 50) {
        data.listingIssues.push('high_quantity');
      }
    }

    // Image count (stock photo detection heuristic)
    const imageEls = document.querySelectorAll('.ux-image-carousel-item img');
    if (imageEls.length <= 1) {
      data.listingIssues.push('stock_photo_only');
    }

    // Description length heuristic
    const descFrame = document.querySelector('#desc_ifr');
    if (descFrame) {
      try {
        const descText = descFrame.contentDocument?.body?.textContent || '';
        if (descText.trim().length < 100) data.listingIssues.push('vague_description');
      } catch (e) { /* cross-origin frame */ }
    }

    // Simulate account age (in production: derive from member-since scrape)
    // eBay shows "Member since: Jun-2019" on seller profile page
    data.accountAgeDays = 730; // default 2 years — real scrape from seller profile

    // Delivery complaint rate (placeholder — real data from eBay seller ratings)
    data.deliveryComplaintRate = 0.8; // default low — real scrape from detailed ratings

    // Price vs market (placeholder — real data from eBay sold listings API)
    data.priceVsMarket = data.currentPrice ? 1.05 : 1.0;

    return data;
  }

  // ── OVERLAY: Inject TrustScore widget into the eBay listing page ─────────
  function injectOverlay(report) {
    // Remove existing overlay if present
    const existing = document.getElementById('ebay-trustscore-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ebay-trustscore-overlay';
    overlay.innerHTML = buildOverlayHTML(report);

    // Insert after the price section
    const insertTarget = document.querySelector('.x-bin-price')
      || document.querySelector('.x-price-primary')
      || document.querySelector('#prcIsum')
      || document.querySelector('.vim.d-vi-VR-finalPrice');

    if (insertTarget && insertTarget.parentNode) {
      insertTarget.parentNode.insertBefore(overlay, insertTarget.nextSibling);
    } else {
      // Fallback: inject near top of right column
      const rightCol = document.querySelector('.vim.d-vi-VR-cnt-x')
        || document.querySelector('#RightSummaryPanel');
      if (rightCol) rightCol.prepend(overlay);
    }

    // Animate in
    requestAnimationFrame(() => {
      overlay.classList.add('ts-visible');
    });

    // Toggle flag details
    overlay.querySelector('.ts-toggle')?.addEventListener('click', () => {
      const details = overlay.querySelector('.ts-flags');
      const isOpen = details.classList.toggle('ts-open');
      overlay.querySelector('.ts-toggle').textContent = isOpen ? '▲ Hide details' : '▼ Show details';
    });
  }

  function buildOverlayHTML(report) {
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
        </div>
      `;
    }).join('');

    const dangerCount = flags.filter(f => f.type === 'danger').length;
    const warnCount = flags.filter(f => f.type === 'warning').length;

    return `
      <div class="ts-card ts-risk--${riskLevel}">
        <div class="ts-header">
          <div class="ts-brand">
            <span class="ts-logo">🛡</span>
            <span class="ts-title">TrustScore</span>
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
      </div>
    `;
  }

  // ── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    const isListingPage = window.location.href.includes('/itm/');
    if (!isListingPage) return;

    const sellerData = scrapeListingData();

    // Send to background for scoring
    chrome.runtime.sendMessage(
      { type: 'ANALYSE_LISTING', data: sellerData },
      (response) => {
        if (response?.success) {
          injectOverlay(response.report);
          // Store report for popup to read
          chrome.runtime.sendMessage({
            type: 'STORE_REPORT',
            report: { ...response.report, sellerData }
          });
        }
      }
    );
  }

  // Run on page load (and re-run if eBay navigates via SPA)
  init();
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(init, 1500);
    }
  }).observe(document, { subtree: true, childList: true });

})();
