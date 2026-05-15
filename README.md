# 🛡 eBay TrustScore

**AI-powered seller risk analyser for eBay UK — Chrome Extension**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Chrome Extension](https://img.shields.io/badge/Platform-Chrome%20Extension-yellow)](https://developer.chrome.com/docs/extensions/)
[![Status](https://img.shields.io/badge/Status-MVP-green)]()

> Built as part of a Global Talent visa portfolio demonstrating applied AI/ML in a consumer-facing UK product context.

---

## What it does

eBay TrustScore is a Chrome extension that **automatically analyses seller risk** whenever you open an eBay listing. It scores six key signals and presents a single trust score (0–100) directly on the product page — no extra clicks, no manual research.

### Risk signals analysed

| Signal | Weight | Description |
|--------|--------|-------------|
| Feedback Volume | 20 pts | Number of seller reviews |
| Positive Rate | 25 pts | % positive feedback vs eBay average |
| Account Age | 15 pts | Days since seller joined |
| Price Anomaly | 20 pts | Price vs recent sold comps |
| Listing Quality | 10 pts | Returns, photos, location, description |
| Delivery Record | 10 pts | Delivery complaint rate |

### Score interpretation

| Score | Risk Level | Meaning |
|-------|-----------|---------|
| 85–100 | 🟢 Low Risk | Strong seller, safe to buy |
| 65–84 | 🟡 Moderate | Proceed with caution |
| 40–64 | 🔴 High Risk | Significant concerns |
| 0–39 | 🚨 Very High | Avoid — multiple red flags |

---

## Screenshots

The extension injects a TrustScore widget directly below the price on any eBay listing:

```
┌─────────────────────────────────────┐
│ 🛡 TrustScore                  82  │
│ ████████████████░░░░  / 100         │
│ ⚡ Moderate Risk  1 warning         │
│                                     │
│ Proceed with caution. 1 concern     │
│ detected. Review the flags below.   │
│                                     │
│ Feedback Volume  ████████░░  17/20  │
│ Positive Rate    ██████████  21/25  │
│ Account Age      ██████░░░░   9/15  │
│ ...                                 │
│ ▼ Show details                      │
└─────────────────────────────────────┘
```

---

## Architecture

```
ebay-trustscore/
├── extension/
│   ├── manifest.json              # Chrome MV3 manifest
│   ├── background/
│   │   ├── service_worker.js      # Message routing, badge management
│   │   └── scoring-engine.js      # Core risk scoring algorithm
│   ├── content/
│   │   ├── content.js             # eBay page scraper + overlay injector
│   │   └── content.css            # Overlay styles
│   ├── popup/
│   │   ├── popup.html             # Extension popup UI
│   │   ├── popup.css              # Popup styles
│   │   └── popup.js               # Popup logic + report renderer
│   └── assets/                    # Icons
├── demo/
│   └── index.html                 # Interactive web demo (no install needed)
└── docs/
    └── scoring-methodology.md     # Detailed scoring explanation
```

---

## Scoring methodology

### 1. Weighted signal scoring

Each signal is independently scored and weighted to reflect its empirical correlation with buyer dispute rates:

```javascript
// Positive feedback rate (25 pts — highest weight)
// Research shows <98% rate correlates strongly with INAD claims
if (feedbackPercent >= 99.5) score = 25;
else if (feedbackPercent >= 99.0) score = 21;
else if (feedbackPercent >= 98.0) score = 16;
// ...

// Price anomaly (20 pts)
// Both overpriced AND underpriced listings are flagged
if (priceRatio < 0.60) flag('danger', 'Suspiciously low — possible counterfeit');
if (priceRatio > 1.50) flag('danger', 'Significantly overpriced vs sold history');
```

### 2. Non-linear penalty system

Flags are additive but scores are bounded — a single critical flag (e.g. 3-day-old account) cannot mask other positive signals. This prevents both false positives and false negatives.

### 3. Price comparison

In the MVP, price comparison uses a heuristic ratio. The roadmap includes integrating with eBay's Terapeak sold data API for real-time comp analysis.

---

## Installation (Developer Mode)

1. Clone this repo
   ```bash
   git clone https://github.com/meeral/ebay-trustscore.git
   ```

2. Open Chrome → `chrome://extensions`

3. Enable **Developer Mode** (top right toggle)

4. Click **Load unpacked** → select the `extension/` folder

5. Navigate to any eBay listing — TrustScore will appear automatically

---

## Try the demo

Open `demo/index.html` in any browser for a fully interactive demo with scenario presets (Trusted Seller, New Seller, Suspicious, Scam Signals).

---

## Roadmap

### Phase 1 — MVP (current)
- [x] Chrome extension with content script overlay
- [x] Six-signal scoring engine
- [x] Popup UI with animated score ring
- [x] Scenario-based interactive demo

### Phase 2 — Data enrichment
- [ ] Live eBay sold listing API integration (price comps)
- [ ] Seller profile page scraping (account age, DSR ratings)
- [ ] Negative feedback NLP analysis

### Phase 3 — AI enhancement
- [ ] Claude API integration for natural language risk summaries
- [ ] Image analysis for counterfeit detection (sneakers, luxury goods)
- [ ] Cross-listing pattern detection (same seller, multiple accounts)

### Phase 4 — Platform expansion
- [ ] Firefox extension
- [ ] Mobile companion app (iOS + Android)

---

## Technical stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome MV3, Vanilla JS |
| Scraping | DOM traversal, MutationObserver |
| Scoring | Weighted heuristic engine (JS) |
| AI (Phase 3) | Anthropic Claude API |
| Demo | Vanilla HTML/CSS/JS |
| Future backend | Python Flask + Supabase |

---

## Contributing

Contributions welcome. Please open an issue first for major changes.

```bash
git clone https://github.com/meeral/ebay-trustscore.git
cd ebay-trustscore
# No build step required — pure JS extension
```

---

## Licence

MIT — see [LICENSE](LICENSE)

---

## Author

Built by **Meeral** — Dev Support Engineer & AI Innovation Lead  
MSc AI & Data Science (Distinction), Keele University

*This project is part of a portfolio of applied AI work developed in a UK professional context.*
