/**
 * eBay TrustScore — Scoring Engine v2
 *
 * Design principle: only penalise on CONFIRMED signals.
 * If data cannot be scraped, that signal scores at neutral (not zero).
 * This prevents good listings from being dragged down by missing data.
 */

function computeTrustScore(d) {
  const flags   = [];
  const breakdown = {};
  const dataConfidence = {}; // track which signals had real data

  // ── 1. FEEDBACK VOLUME (0–20) ─────────────────────────────────────────────
  // Only score if we actually found a feedback count
  const hasFeedbackCount = d.feedbackCount > 0;
  let feedbackVolumeScore;

  if (!hasFeedbackCount) {
    // No data — neutral score, no flag
    feedbackVolumeScore = 10;
    dataConfidence.feedbackVolume = false;
  } else {
    dataConfidence.feedbackVolume = true;
    if      (d.feedbackCount >= 1000) feedbackVolumeScore = 25;
    else if (d.feedbackCount >= 500)  feedbackVolumeScore = 21;
    else if (d.feedbackCount >= 100)  feedbackVolumeScore = 16;
    else if (d.feedbackCount >= 50)   feedbackVolumeScore = 10;
    else if (d.feedbackCount >= 10)   feedbackVolumeScore = 6;
    else {
      feedbackVolumeScore = 2;
      flags.push({ type: 'warning', message: `Only ${d.feedbackCount} feedback ratings — new or low-volume seller` });
    }
  }
  breakdown.feedbackVolume = { score: feedbackVolumeScore, max: 25, label: 'Feedback Volume', confirmed: dataConfidence.feedbackVolume };

  // ── 2. POSITIVE FEEDBACK RATE (0–25) ─────────────────────────────────────
  // eBay average is 98.5%. We only penalise if we actually read a value.
  const hasFeedbackPct = d.feedbackPercent && d.feedbackPercent !== 99.0; // 99.0 is our fallback default
  let feedbackRateScore;

  if (!hasFeedbackPct && !dataConfidence.feedbackVolume) {
    // No data at all — neutral
    feedbackRateScore = 15;
    dataConfidence.feedbackRate = false;
  } else {
    dataConfidence.feedbackRate = true;
    const pct = d.feedbackPercent || 99.0;
    if      (pct >= 99.5) feedbackRateScore = 30;
    else if (pct >= 99.0) feedbackRateScore = 26;
    else if (pct >= 98.0) feedbackRateScore = 20;
    else if (pct >= 95.0) feedbackRateScore = 12;
    else if (pct >= 90.0) feedbackRateScore = 6;
    else {
      feedbackRateScore = 0;
      flags.push({ type: 'danger', message: `${pct.toFixed(1)}% positive — significantly below eBay average (98.5%)` });
    }
    if (pct < 98.0 && pct >= 95.0) {
      flags.push({ type: 'warning', message: `${pct.toFixed(1)}% positive feedback — slightly below average` });
    }
  }
  breakdown.feedbackRate = { score: feedbackRateScore, max: 30, label: 'Positive Rate', confirmed: dataConfidence.feedbackRate };

  // ── 3. ACCOUNT AGE (0–15) ─────────────────────────────────────────────────
  // Only flag if we have high confidence (member-since text found, or very low feedback)
  let accountAgeScore;

  if (d._accountAgeConfirmed) {
    // Real data from "member since" text on page
    dataConfidence.accountAge = true;
    if      (d.accountAgeDays >= 365 * 5) accountAgeScore = 20;
    else if (d.accountAgeDays >= 365 * 2) accountAgeScore = 16;
    else if (d.accountAgeDays >= 365)     accountAgeScore = 12;
    else if (d.accountAgeDays >= 180)     accountAgeScore = 8;
    else if (d.accountAgeDays >= 30)      accountAgeScore = 4;
    else {
      accountAgeScore = 0;
      flags.push({ type: 'danger', message: `Account created ${d.accountAgeDays} days ago — very new seller` });
    }
    if (d.accountAgeDays < 180 && d.accountAgeDays >= 30) {
      flags.push({ type: 'warning', message: 'Seller account is under 6 months old' });
    }
  } else if (d.feedbackCount > 0 && d.feedbackCount < 10) {
    // Inferred from very low feedback — flag as warning only
    dataConfidence.accountAge = false;
    accountAgeScore = 4;
    flags.push({ type: 'warning', message: `Very low feedback count (${d.feedbackCount}) — seller may be new` });
  } else {
    // Not enough info — give benefit of the doubt, neutral score
    dataConfidence.accountAge = false;
    accountAgeScore = 12;
  }
  breakdown.accountAge = { score: accountAgeScore, max: 20, label: 'Account Age', confirmed: dataConfidence.accountAge };

  // ── 4. PRICE ANOMALY — REMOVED ───────────────────────────────────────────
  // Price comparison requires eBay sold listings API (needs API key + OAuth).
  // Showing a fake/neutral score is misleading — removed entirely.
  // Its 20pts redistributed: feedbackVolume +5 (→25), feedbackRate +5 (→30),
  // accountAge +5 (→20), listingQuality +5 (→15). See max values below.
  // breakdown entry kept as null so overlay can show "N/A" honestly.
  breakdown.priceAnomaly = null; // excluded from scoring

  // ── 5. LISTING QUALITY (0–10) ─────────────────────────────────────────────
  // Only penalise on issues that are reliably detected
  let listingScore = 15;
  const issues = d.listingIssues || [];

  // Business sellers on eBay UK are regulated — slight positive signal
  if (d.isBusiness) listingScore = Math.min(10, listingScore + 1);

  if (issues.includes('no_returns')) {
    listingScore -= 3;
    flags.push({ type: 'warning', message: 'Seller does not accept returns' });
  }
  // Stock photo check REMOVED — unreliable due to lazy loading
  // Only flag overseas if we actually found a non-UK location string
  if (issues.includes('overseas_seller') && d.itemLocation) {
    listingScore -= 2;
    flags.push({ type: 'warning', message: `Ships from outside UK (${d.itemLocation}) — longer delivery, harder returns` });
  }
  if (issues.includes('vague_description')) {
    listingScore -= 2;
    flags.push({ type: 'info', message: 'Listing description is short or vague' });
  }
  if (issues.includes('high_quantity')) {
    listingScore -= 1;
    flags.push({ type: 'info', message: 'Large quantity available — may be bulk/dropship seller' });
  }
  listingScore = Math.max(0, listingScore);
  breakdown.listingQuality = { score: listingScore, max: 15, label: 'Listing Quality', confirmed: true };

  // ── 6. DELIVERY RECORD (0–10) ─────────────────────────────────────────────
  // Only penalise if feedback% is confirmed AND meaningfully low
  let deliveryScore;

  if (dataConfidence.feedbackRate && d.feedbackPercent < 98) {
    // Derive from feedback % as a proxy — directionally correct
    if      (d.feedbackPercent < 90) { deliveryScore = 0; flags.push({ type: 'danger',  message: `Estimated high delivery complaint rate based on ${d.feedbackPercent.toFixed(1)}% feedback score` }); }
    else if (d.feedbackPercent < 95) { deliveryScore = 3; flags.push({ type: 'warning', message: 'Below-average feedback suggests possible delivery issues' }); }
    else if (d.feedbackPercent < 97) { deliveryScore = 6; }
    else                             { deliveryScore = 8; }
  } else {
    // No confirmed issue — full score
    deliveryScore = 10;
  }
  breakdown.deliveryComplaints = { score: deliveryScore, max: 10, label: 'Delivery Record', confirmed: dataConfidence.feedbackRate };

  // ── TOTAL ─────────────────────────────────────────────────────────────────
  const totalScore = Math.round(
    feedbackVolumeScore + feedbackRateScore + accountAgeScore +
    listingScore + deliveryScore
  );

  // ── RISK LABEL ────────────────────────────────────────────────────────────
  let riskLevel, riskLabel, riskColor;
  if      (totalScore >= 85) { riskLevel = 'low';      riskLabel = 'Low Risk';       riskColor = '#10b981'; }
  else if (totalScore >= 65) { riskLevel = 'medium';   riskLabel = 'Moderate Risk';  riskColor = '#f59e0b'; }
  else if (totalScore >= 40) { riskLevel = 'high';     riskLabel = 'High Risk';      riskColor = '#ef4444'; }
  else                       { riskLevel = 'critical'; riskLabel = 'Very High Risk'; riskColor = '#dc2626'; }

  // ── DATA CONFIDENCE NOTE ──────────────────────────────────────────────────
  const unconfirmedCount = Object.values(dataConfidence).filter(v => !v).length;
  const confirmedSignals = Object.values(dataConfidence).filter(v => v).length;

  if (unconfirmedCount > 2) {
    flags.push({ type: 'info', message: `${unconfirmedCount} signals could not be scraped from this page — open console for debug info` });
  }

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  const dangerFlags  = flags.filter(f => f.type === 'danger');
  const warningFlags = flags.filter(f => f.type === 'warning');
  let summary = '';

  if (riskLevel === 'low') {
    summary = `This seller has a strong track record${d.feedbackCount > 0 ? ` with ${d.feedbackCount.toLocaleString()} reviews at ${d.feedbackPercent?.toFixed(1)}% positive` : ''}. No significant risk signals detected.`;
  } else if (riskLevel === 'medium') {
    summary = `Proceed with caution. ${warningFlags.length} concern${warningFlags.length !== 1 ? 's' : ''} detected. Review the flags below before purchasing.`;
  } else {
    summary = `${dangerFlags.length} high-risk signal${dangerFlags.length !== 1 ? 's' : ''} detected. We recommend checking alternatives before buying.`;
  }

  if (confirmedSignals < 2) {
    summary += ' Note: limited data was available on this page — score reflects what could be confirmed.';
  }

  return {
    score: totalScore,
    riskLevel,
    riskLabel,
    riskColor,
    summary,
    flags,
    breakdown,
    dataConfidence,
    meta: { analysedAt: new Date().toISOString(), version: '2.0.0' }
  };
}

if (typeof module !== 'undefined') module.exports = { computeTrustScore };
