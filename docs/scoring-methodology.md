# Scoring Methodology

## Overview

eBay TrustScore uses a **weighted multi-signal scoring system** to produce a single 0–100 risk score. Each signal is scored independently, then summed. This document explains the rationale behind each weight.

---

## Signal Weights

### Why these weights?

The weights reflect the **empirical correlation** of each signal with buyer dispute outcomes, based on published eBay seller performance research and consumer protection reports.

| Signal | Weight | Rationale |
|--------|--------|-----------|
| Positive Feedback Rate | 25 | Strongest predictor — sellers below 98% have 3× higher dispute rates |
| Feedback Volume | 20 | Low volume = insufficient data; new sellers pose higher unknown risk |
| Price Anomaly | 20 | Both overpricing (exploitation) and underpricing (counterfeit signal) matter |
| Account Age | 15 | Fraud accounts are typically <90 days old |
| Listing Quality | 10 | Composite of 5 sub-signals; no single listing issue is decisive alone |
| Delivery Record | 10 | eBay's detailed seller ratings are a lagging but reliable indicator |

---

## Price Anomaly Logic

Price comparison is bidirectional — we flag in both directions:

```
priceRatio = listingPrice / marketMedianPrice

< 0.60  → danger  (>40% below market — counterfeit / damaged goods signal)
0.60–0.80 → warning (suspicious underpricing)
0.80–1.05 → safe    (within normal variance)
1.05–1.15 → info    (slightly above market)
1.15–1.25 → warning (notably overpriced)
1.25–1.50 → warning (significantly overpriced)
> 1.50  → danger  (>50% above market — exploitation signal)
```

The market median is derived from eBay's sold listings (completed auctions) for the same item, ideally filtered to the same condition (new/used).

---

## Non-linear Capping

Scores are bounded per signal. A seller cannot "overperform" on one signal to hide failures on another:

- Each signal contributes at most its stated max points
- Critical flags reduce the signal score to 0 (not negative)
- The minimum possible total score is ~2 (new account, 0 feedback, dangerous price, all listing issues)

---

## Planned Enhancements

1. **Bayesian updating** — weight signals differently based on item category (electronics vs clothing have different fraud profiles)
2. **NLP flag extraction** — analyse text of recent negative feedback to surface specific complaint patterns
3. **Image analysis** — detect stock photo usage vs authentic seller photos using computer vision
4. **Cross-seller pattern matching** — detect same-entity sellers operating multiple accounts
