# GharAI: Zillow-style home prices for India

Search 23,000+ real Indian property listings on a map and see an **AI "fair price"** for every home.
You can also get an instant estimate for your own home, with a price range and an explanation of the price.

**Features:** map search · AI fair price & deal badges · "price my home" estimator · market insights ·
**EMI & true-cost calculator** (stamp duty, registration, GST, RBI down-payment rules, amortisation) ·
**contact the lister** (call-back / site visit / question) · **seller leads inbox** (one-tap call / WhatsApp / email) ·
**photo galleries** (real city photos + labelled representative home photos, fully credited).

```
ghar-ai/
├── data/
│   ├── raw_geo/train.csv      ← real listings (MachineHack "House Price Prediction Challenge")
│   ├── raw/*.csv              ← 2nd dataset we evaluated and rejected (see Lesson 1)
│   └── listings.csv           ← cleaned listings + AI fair price (generated)
├── ml/
│   ├── features.py            ← feature engineering, shared by training AND the API
│   └── train.py               ← clean → split → train → evaluate → save
├── models/                    ← trained model + metrics (generated)
├── scripts/fetch_photos.py    ← downloads openly-licensed photos + credits from Wikimedia Commons
├── backend/main.py            ← FastAPI: search, estimate, insights, enquiries (SQLite) + serves the site
└── frontend/
    ├── app.js                 ← router, search + map, listing drawer, estimator, insights
    ├── emi.js                 ← EMI & cost-of-buying maths and UI
    ├── contact.js             ← enquiry form (buyers) + leads inbox (sellers)
    ├── photos.js              ← galleries, city photos, credits page
    └── photos/                ← downloaded photos + credits.json
```

## Run it

```bash
cd ghar-ai
python -m venv .venv
.venv\Scripts\activate            # Windows  (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python ml/train.py                # ~1 min: trains & prints the model scoreboard
python scripts/fetch_photos.py    # ~2 min: downloads photos (already done if frontend/photos exists)
uvicorn backend.main:app --reload # then open http://127.0.0.1:8000
```

API docs are generated automatically at http://127.0.0.1:8000/docs. Try `POST /api/estimate` there.

## Results (on 4,610 homes the model never saw)

| Model | Typical error | Within 20% | R² (log price) |
|---|---|---|---|
| Baseline: nearby ₹/sqft × area | ±16.0% | 59.4% | 0.843 |
| Linear regression | ±16.1% | 59.2% | 0.861 |
| **LightGBM (gradient boosting)** | **±12.7%** | **67.3%** | **0.894** |

The "80% price range" contains the true price 81.2% of the time, so the range is honest.

---

## What you learn from this project (read alongside the code)

**Lesson 1: Data quality beats model choice.** We first tried the popular "Housing Prices in Metropolitan
Areas of India" dataset. Even the best model only reached R² 0.40. Look at 2BHK ~750 sqft flats in one Mumbai
locality: they're listed anywhere from ₹55 L to ₹2.35 Cr. No algorithm can learn from contradictory labels.
Switching to a cleaner dataset more than doubled the R² with the *same* algorithm.

**Lesson 2: Always look at your data.** The raw file has latitude/longitude **swapped**, "3BHK" flats of
115 sq ft, and pins geocoded 800 km from their city. See `load_and_clean()` in `ml/train.py`.

**Lesson 3: Train/test split and leakage.** We hide 20% of homes *before* computing anything. The
"nearby homes" feature is built only from training homes, and a home is never its own neighbour
(`exclude_self`). Break this rule and the score looks great but the model fails in real use.

**Lesson 4: Feature engineering.** The #1 feature (24% importance) isn't in the raw data. We built it:
the median ₹/sqft of the 15 nearest homes (a broker's "comps"), found with a `BallTree`.

**Lesson 5: Always beat a baseline.** A one-line rule (neighbours' ₹/sqft × area) already gets ±16%.
The ML model is only worth it because it beats that clearly.

**Lesson 6: Predict log(price).** Prices range from ₹3 L to ₹20+ Cr. In log space a 10% miss counts
the same on any home. We also use L1 loss (predict the *median*), which resists junk listings.

**Lesson 7: Gradient boosting.** LightGBM adds 2,000 small decision trees, each one fixing the leftover
errors of the ones before it. It handles non-linear effects (e.g. location × size) that linear regression can't.

**Lesson 8: Uncertainty.** Quantile regression (`objective="quantile"`) predicts a low and a high price.
We *checked* the range: it was over-confident at first (70% coverage), so we widened it to get ~80%.

**Lesson 9: Explainability.** `model.predict(X, pred_contrib=True)` returns SHAP values: how much
each feature pushed *this* prediction up or down. The site groups them into four readable factors.

**Lesson 10: Out-of-fold predictions.** Every listing's "fair price" comes from a model trained on the
*other* 80% (5-fold cross-validation). Otherwise the model would have memorised the asking price
and "good deal" badges would be meaningless.

**Lesson 11: ML in production.** `ml/features.py` is used by both training and the API, so features
are computed identically in both (avoiding "training/serving skew"). The model loads once at startup.
We also treat >45% "discounts" as probable data errors, not deals.

## Product features (non-AI, but what makes it feel real)

**EMI formula.** `EMI = P·r·(1+r)^n / ((1+r)^n − 1)` with r = monthly rate and n = months. The calculator
also applies RBI loan-to-value caps (banks lend at most 90% up to ₹30 L, 80% up to ₹75 L, 75% above)
and adds day-one costs: stamp duty (a default per state), registration, GST on under-construction homes,
the processing fee and brokerage. Tax rates are **approximate defaults and editable**. Check your
state's current official rates before budgeting.

**Contacting sellers without inventing data.** The dataset has no seller names or phone numbers, so the
site never makes any up. Instead the *buyer* leaves their details (validated: Indian mobile format,
consent checkbox, a duplicate guard), which are stored in SQLite (`data/enquiries.db`). The lister then
reaches the buyer from the **Leads inbox** via `tel:`, `wa.me` and `mailto:` links. ⚠️ The inbox has no
login in this prototype, so anyone who opens it sees every enquiry. Add authentication before real use.

**Photos.** The listings have no photos, so galleries show *representative* images, clearly labelled,
plus a real photo of the city. All are openly licensed (CC0 / CC BY / CC BY-SA) and credited at `#/credits`,
which is what the licences require.

## Ideas to try next (good practice)

1. **Tune hyperparameters** with `optuna`: try `num_leaves`, `learning_rate`, `K_NEIGHBORS`.
2. **Add a feature**: distance to the city centre or the nearest metro station. Does the score improve?
3. **Error analysis**: which cities have the worst error? Why?
4. **Spatial validation**: split by locality instead of randomly. How does the score change on brand-new areas?
5. **Deploy it**: Render or Railway (backend), or wrap it in Docker.

## Data and disclaimer
Listings: MachineHack "House Price Prediction Challenge" (via a public GitHub mirror). Map ©
OpenStreetMap contributors. This is a learning project. Asking prices are not sale prices, and the
estimates are not valuations.
