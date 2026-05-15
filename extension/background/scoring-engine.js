/**
 * eBay TrustScore — Risk Scoring Engine
 * Core ML-inspired heuristic scoring system
 * Author: Meeral | github.com/meeral
 */

/**
 * Master scoring function — returns a full TrustScore report
 * @param {Object} sellerData - Raw data scraped from eBay listing
 * @returns {Object} Full risk report with score, flags, breakdown
 */
function computeTrustScore(sellerData) {
  const flags = [];
  const breakdown = {};

  // ── 1. FEEDBACK VOLUME SCORE (0–20 pts) ──────────────────────────────────
  // Low feedback volume = high risk for buyers
  const feedbackCount = sellerData.feedbackCount || 0;
  let feedbackVolumeScore = 0;
  if (feedbackCount >= 1000) feedbackVolumeScore = 20;
  else if (feedbackCount >= 500) feedbackVolumeScore = 17;
  else if (feedbackCount >= 100) feedbackVolumeScore = 13;
  else if (feedbackCount >= 50)  feedbackVolumeScore = 9;
  else if (feedbackCount >= 10)  feedbackVolumeScore = 5;
  else {
    feedbackVolumeScore = 2;
    flags.push({ type: 'warning', code: 'LOW_FEEDBACK', message: `Only ${feedbackCount} feedback ratings — new or low-volume seller` });
  }
  breakdown.feedbackVolume = { score: feedbackVolumeScore, max: 20 };

  // ── 2. POSITIVE FEEDBACK RATE SCORE (0–25 pts) ───────────────────────────
  const feedbackPercent = sellerData.feedbackPercent || 0;
  let feedbackRateScore = 0;
  if (feedbackPercent >= 99.5) feedbackRateScore = 25;
  else if (feedbackPercent >= 99.0) feedbackRateScore = 21;
  else if (feedbackPercent >= 98.0) feedbackRateScore = 16;
  else if (feedbackPercent >= 95.0) feedbackRateScore = 10;
  else if (feedbackPercent >= 90.0) feedbackRateScore = 5;
  else {
    feedbackRateScore = 0;
    flags.push({ type: 'danger', code: 'LOW_FEEDBACK_RATE', message: `${feedbackPercent}% positive — significantly below eBay average (98.5%)` });
  }
  if (feedbackPercent < 98.0 && feedbackPercent >= 95.0) {
    flags.push({ type: 'warning', code: 'MODERATE_FEEDBACK_RATE', message: `${feedbackPercent}% positive feedback — slightly below average` });
  }
  breakdown.feedbackRate = { score: feedbackRateScore, max: 25 };

  // ── 3. ACCOUNT AGE SCORE (0–15 pts) ──────────────────────────────────────
  const accountAgeDays = sellerData.accountAgeDays || 0;
  let accountAgeScore = 0;
  if (accountAgeDays >= 365 * 5) accountAgeScore = 15;
  else if (accountAgeDays >= 365 * 2) accountAgeScore = 12;
  else if (accountAgeDays >= 365) accountAgeScore = 9;
  else if (accountAgeDays >= 180) accountAgeScore = 6;
  else if (accountAgeDays >= 30) accountAgeScore = 3;
  else {
    accountAgeScore = 0;
    flags.push({ type: 'danger', code: 'NEW_ACCOUNT', message: `Account created ${accountAgeDays} days ago — very new seller` });
  }
  if (accountAgeDays < 180 && accountAgeDays >= 30) {
    flags.push({ type: 'warning', code: 'YOUNG_ACCOUNT', message: `Account is under 6 months old` });
  }
  breakdown.accountAge = { score: accountAgeScore, max: 15 };

  // ── 4. PRICE ANOMALY SCORE (0–20 pts) ────────────────────────────────────
  // Compare listing price vs recently sold comps
  const priceRatio = sellerData.priceVsMarket || 1.0; // 1.0 = at market
  let priceScore = 0;
  if (priceRatio <= 1.05) priceScore = 20;       // within 5% of market
  else if (priceRatio <= 1.15) priceScore = 16;  // 5–15% above
  else if (priceRatio <= 1.25) priceScore = 10;  // 15–25% above
  else if (priceRatio <= 1.50) priceScore = 4;   // 25–50% above
  else {
    priceScore = 0;
    flags.push({ type: 'danger', code: 'PRICE_ANOMALY_HIGH', message: `Price is ${Math.round((priceRatio - 1) * 100)}% above recent sold listings` });
  }

  // Too cheap = also suspicious (possible counterfeit)
  if (priceRatio < 0.60) {
    priceScore = Math.min(priceScore, 5);
    flags.push({ type: 'danger', code: 'PRICE_ANOMALY_LOW', message: `Price is suspiciously low — ${Math.round((1 - priceRatio) * 100)}% below market value` });
  } else if (priceRatio < 0.80) {
    flags.push({ type: 'warning', code: 'PRICE_BELOW_MARKET', message: `Price is ${Math.round((1 - priceRatio) * 100)}% below typical sold price — verify authenticity` });
  }
  breakdown.priceAnomaly = { score: priceScore, max: 20 };

  // ── 5. LISTING QUALITY SCORE (0–10 pts) ──────────────────────────────────
  let listingScore = 10;
  const listingIssues = sellerData.listingIssues || [];

  if (listingIssues.includes('no_returns')) {
    listingScore -= 3;
    flags.push({ type: 'warning', code: 'NO_RETURNS', message: 'Seller does not accept returns' });
  }
  if (listingIssues.includes('stock_photo_only')) {
    listingScore -= 2;
    flags.push({ type: 'warning', code: 'STOCK_PHOTOS', message: 'Listing uses only stock/generic photos — no actual item photos' });
  }
  if (listingIssues.includes('vague_description')) {
    listingScore -= 2;
    flags.push({ type: 'info', code: 'VAGUE_DESC', message: 'Listing description is unusually short or vague' });
  }
  if (listingIssues.includes('overseas_seller')) {
    listingScore -= 2;
    flags.push({ type: 'warning', code: 'OVERSEAS_SELLER', message: 'Item ships from outside UK — longer delivery, harder returns' });
  }
  if (listingIssues.includes('high_quantity')) {
    listingScore -= 1;
    flags.push({ type: 'info', code: 'HIGH_QUANTITY', message: 'Large quantity available — may indicate bulk/dropship seller' });
  }
  listingScore = Math.max(0, listingScore);
  breakdown.listingQuality = { score: listingScore, max: 10 };

  // ── 6. DELIVERY COMPLAINT SCORE (0–10 pts) ────────────────────────────────
  const deliveryComplaintRate = sellerData.deliveryComplaintRate || 0; // percentage
  let deliveryScore = 10;
  if (deliveryComplaintRate > 5) {
    deliveryScore = 0;
    flags.push({ type: 'danger', code: 'HIGH_DELIVERY_COMPLAINTS', message: `${deliveryComplaintRate}% delivery complaints — significantly above average` });
  } else if (deliveryComplaintRate > 2) {
    deliveryScore = 5;
    flags.push({ type: 'warning', code: 'MODERATE_DELIVERY_COMPLAINTS', message: `${deliveryComplaintRate}% delivery complaints — above average` });
  } else if (deliveryComplaintRate > 1) {
    deliveryScore = 8;
  }
  breakdown.deliveryComplaints = { score: deliveryScore, max: 10 };

  // ── TOTAL SCORE ───────────────────────────────────────────────────────────
  const totalScore = Math.round(
    feedbackVolumeScore + feedbackRateScore + accountAgeScore +
    priceScore + listingScore + deliveryScore
  );

  // ── RISK LABEL ────────────────────────────────────────────────────────────
  let riskLevel, riskLabel, riskColor;
  if (totalScore >= 85) {
    riskLevel = 'low';
    riskLabel = 'Low Risk';
    riskColor = '#10b981';
  } else if (totalScore >= 65) {
    riskLevel = 'medium';
    riskLabel = 'Moderate Risk';
    riskColor = '#f59e0b';
  } else if (totalScore >= 40) {
    riskLevel = 'high';
    riskLabel = 'High Risk';
    riskColor = '#ef4444';
  } else {
    riskLevel = 'critical';
    riskLabel = 'Very High Risk';
    riskColor = '#dc2626';
  }

  // ── AI SUMMARY (template — replaced with real AI in backend) ─────────────
  const dangerFlags = flags.filter(f => f.type === 'danger');
  const warningFlags = flags.filter(f => f.type === 'warning');

  let summary = '';
  if (riskLevel === 'low') {
    summary = `This seller has a strong track record with ${sellerData.feedbackCount?.toLocaleString()} reviews at ${sellerData.feedbackPercent}% positive. Price is consistent with recent sold listings.`;
  } else if (riskLevel === 'medium') {
    summary = `Proceed with caution. ${warningFlags.length} concern${warningFlags.length > 1 ? 's' : ''} detected. Review the flags below before purchasing.`;
  } else {
    summary = `We detected ${dangerFlags.length} high-risk signal${dangerFlags.length > 1 ? 's' : ''} with this listing. We recommend checking alternatives before buying.`;
  }

  return {
    score: totalScore,
    riskLevel,
    riskLabel,
    riskColor,
    summary,
    flags,
    breakdown,
    meta: {
      analysedAt: new Date().toISOString(),
      version: '1.0.0'
    }
  };
}

// Export for use in content script and popup
if (typeof module !== 'undefined') module.exports = { computeTrustScore };
