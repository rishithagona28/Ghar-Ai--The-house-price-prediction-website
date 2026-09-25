"""
GharAI - model training pipeline.

Run:  python ml/train.py

The classic ML workflow, step by step:
  1. LOAD      ~29k real Indian property listings (with GPS coordinates)
  2. CLEAN     fix swapped columns, remove duplicates, typos, bad geocodes
  3. SPLIT     hold out 20% of homes the model never sees while learning
  4. FEATURES  turn raw columns into signals, incl. "what do nearby homes cost?"
  5. TRAIN     baseline vs. linear model vs. gradient boosting
  6. EVALUATE  score on the held-out homes (the only honest score)
  7. SAVE      final model + listings (with fair-price estimates) for the website

Data: "House Price Prediction Challenge" (MachineHack/Kaggle), prices in lakhs.
"""
import json
import os

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.model_selection import KFold, train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.compose import ColumnTransformer

from features import NeighborhoodIndex, build_features, haversine_km  # step 4. FEATURES

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw_geo", "train.csv")
OUT_DIR = os.path.join(ROOT, "models")
SEED = 42
MIN_CITY_LISTINGS = 30    # smaller cities are grouped as "Other" for the model


# =========================================================================== 1. LOAD + 2. CLEAN
def load_and_clean() -> pd.DataFrame:
    df = pd.read_csv(RAW)
    n0 = len(df)
    # The source file has LATITUDE and LONGITUDE swapped - always sanity-check your data!
    df = df.rename(columns={
        "LONGITUDE": "lat", "LATITUDE": "lon", "SQUARE_FT": "sqft", "BHK_NO.": "bhk",
        "POSTED_BY": "posted_by", "UNDER_CONSTRUCTION": "under_construction", "RERA": "rera",
        "READY_TO_MOVE": "ready_to_move", "RESALE": "resale", "BHK_OR_RK": "unit_type",
        "ADDRESS": "address", "TARGET(PRICE_IN_LACS)": "price_lakhs",
    })
    parts = df.address.str.split(",")
    df["city"] = parts.str[-1].str.strip().str.title()
    df["locality"] = parts.str[0].str.strip().str.title()
    df["price"] = df.price_lakhs * 1e5
    df = df.drop_duplicates(subset=["address", "sqft", "bhk", "price", "posted_by"])

    # Remove physically implausible listings (typos): 115 sq ft 3BHKs, 1.5 lakh sq ft flats...
    df = df[df.lat.between(6, 37) & df.lon.between(68, 98)]            # inside India
    df = df[df.sqft.between(250, 10_000) & df.bhk.between(1, 10) & (df.price >= 3e5)]
    df["ppsf"] = df.price / df.sqft
    lo, hi = df.ppsf.quantile([0.01, 0.99])
    df = df[df.ppsf.between(lo, hi)]

    # Bad geocodes: a "Bangalore" address placed 800 km away. Drop pins >60 km from
    # the city's median location (only for cities with enough listings to know the centre).
    city_n = df.groupby("city").city.transform("size")
    c_lat = df.groupby("city").lat.transform("median")
    c_lon = df.groupby("city").lon.transform("median")
    km = haversine_km(df.lat, df.lon, c_lat, c_lon)
    df = df[(city_n < 20) | (km <= 60)]

    print(f"Cleaning: {n0:,} -> {len(df):,} listings, {df.city.nunique()} cities")
    return df.reset_index(drop=True)


LGB_PARAMS = dict(
    n_estimators=2000, learning_rate=0.03, num_leaves=63, min_child_samples=15,
    subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0,
    objective="l1",   # L1 = predict the median, not the mean -> robust to junk listings
    random_state=SEED, verbose=-1,
)


def fit_lgb(X, y, **overrides):
    return lgb.LGBMRegressor(**{**LGB_PARAMS, **overrides}).fit(X, y)


# =========================================================================== 6. EVALUATE
def metrics(y_true, y_pred) -> dict:
    ape = np.abs(y_pred - y_true) / y_true
    le = np.log(y_pred) - np.log(y_true)
    lt = np.log(y_true)
    return {
        "median_error_pct": round(float(np.median(ape) * 100), 1),
        "within_10pct": round(float(np.mean(ape <= 0.10) * 100), 1),
        "within_20pct": round(float(np.mean(ape <= 0.20) * 100), 1),
        "r2_log": round(float(1 - np.sum(le ** 2) / np.sum((lt - lt.mean()) ** 2)), 3),
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    df = load_and_clean()

    # ======================================================================= 3. SPLIT
    # Split FIRST. Anything learned from data (neighbour prices, city list) must come
    # from the training part only - otherwise test answers leak in and scores lie.
    tr, te = train_test_split(df, test_size=0.2, random_state=SEED)
    counts = tr.city.value_counts()
    top_cities = sorted(counts[counts >= MIN_CITY_LISTINGS].index)
    nbr = NeighborhoodIndex(tr.lat, tr.lon, np.log(tr.ppsf))
    X_tr = build_features(tr, nbr, top_cities, exclude_self=True)
    X_te = build_features(te, nbr, top_cities)
    # Predict log(price): a 10% miss on a ₹30L flat and a ₹3Cr villa count the same.
    y_tr = np.log(tr.price.values)
    results = {}

    # ---- 5a. Baseline: "neighbours' median ₹/sqft × your sqft" - what a broker does.
    results["Baseline: nearby ₹/sqft × area"] = metrics(te.price.values, np.exp(X_te.nbr_log_ppsf) * te.sqft.values)

    # ---- 5b. Linear regression: price = w1*x1 + w2*x2 + ... (straight lines only)
    lin_cols = ["log_sqft", "bhk", "sqft_per_bhk", "under_construction", "rera",
                "ready_to_move", "resale", "is_rk", "nbr_log_ppsf", "nbr_spread", "nbr_dist_km"]
    lin = make_pipeline(ColumnTransformer([
        ("num", StandardScaler(), lin_cols),
        ("cat", OneHotEncoder(handle_unknown="ignore"), ["posted_by", "city"]),
    ]), Ridge(alpha=1.0))
    lin.fit(X_tr, y_tr)
    results["Linear regression"] = metrics(te.price.values, np.exp(lin.predict(X_te)))

    # ---- 5c. LightGBM: hundreds of small decision trees, each fixing the last one's errors
    model = fit_lgb(X_tr, y_tr)
    results["LightGBM (gradient boosting)"] = metrics(te.price.values, np.exp(model.predict(X_te)))

    # ---- Price range: quantile models predict the 5th and 95th percentile price.
    # (Aiming at 90% because quantile models tend to be over-confident; we check below.)
    q_lo = fit_lgb(X_tr, y_tr, objective="quantile", alpha=0.05, n_estimators=800)
    q_hi = fit_lgb(X_tr, y_tr, objective="quantile", alpha=0.95, n_estimators=800)
    lo, hi = np.exp(q_lo.predict(X_te)), np.exp(q_hi.predict(X_te))
    coverage = float(np.mean((te.price.values >= lo) & (te.price.values <= hi)) * 100)

    print("\nScores on held-out homes the model never saw:")
    print(pd.DataFrame(results).T.to_string())
    print(f"\nThe 80% price range contains the true price {coverage:.1f}% of the time")

    # ======================================================================= 7. SAVE
    # (a) Honest "fair price" for every listing on the website: out-of-fold predictions.
    #     Each listing is priced by a model trained on the OTHER 80% of listings,
    #     so a home never gets to "see" its own price.
    counts_all = df.city.value_counts()
    top_all = sorted(counts_all[counts_all >= MIN_CITY_LISTINGS].index)
    oof = np.zeros(len(df))
    for k, (a, b) in enumerate(KFold(5, shuffle=True, random_state=SEED).split(df)):
        fa, fb = df.iloc[a], df.iloc[b]
        nb = NeighborhoodIndex(fa.lat, fa.lon, np.log(fa.ppsf))
        m = fit_lgb(build_features(fa, nb, top_all, exclude_self=True), np.log(fa.price.values))
        oof[b] = np.exp(m.predict(build_features(fb, nb, top_all)))
        print(f"  out-of-fold pricing: fold {k + 1}/5 done")

    # (b) Production model: retrain on ALL listings.
    nbr_all = NeighborhoodIndex(df.lat, df.lon, np.log(df.ppsf))
    X_all = build_features(df, nbr_all, top_all, exclude_self=True)
    y_all = np.log(df.price.values)
    joblib.dump({
        "model": fit_lgb(X_all, y_all),
        "q_low": fit_lgb(X_all, y_all, objective="quantile", alpha=0.05, n_estimators=800),
        "q_high": fit_lgb(X_all, y_all, objective="quantile", alpha=0.95, n_estimators=800),
        "nbr": nbr_all,
        "top_cities": top_all,
    }, os.path.join(OUT_DIR, "price_model.joblib"))

    imp = pd.Series(model.booster_.feature_importance("gain"), index=X_tr.columns)
    with open(os.path.join(OUT_DIR, "model_meta.json"), "w", encoding="utf-8") as f:
        json.dump({
            "metrics": results,
            "range_coverage_pct": round(coverage, 1),
            "n_listings": int(len(df)),
            "n_cities": int(df.city.nunique()),
            "feature_importance_pct": (imp / imp.sum() * 100).round(1).sort_values(ascending=False).to_dict(),
        }, f, indent=2, ensure_ascii=False)

    out = df[["address", "locality", "city", "lat", "lon", "sqft", "bhk", "unit_type", "posted_by",
              "under_construction", "rera", "ready_to_move", "resale", "price"]].copy()
    out["fair_price"] = oof.round(-3)
    out["sqft"] = out.sqft.round()
    out.insert(0, "id", np.arange(len(out)))
    out.to_csv(os.path.join(ROOT, "data", "listings.csv"), index=False)
    print(f"\nSaved model + {len(out):,} listings")


if __name__ == "__main__":
    main()
