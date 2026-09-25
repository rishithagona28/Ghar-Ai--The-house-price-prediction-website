"""
GharAI API - serves listings, the AI price estimator, and the website.

Run:  uvicorn backend.main:app --reload      (from the ghar-ai folder)
Then open http://127.0.0.1:8000
"""
import json
import os
import re
import sqlite3
import sys
from typing import Literal, Optional

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "ml"))
from features import build_features, haversine_km  # noqa: E402  (needed to unpickle the model too)

# ---------------------------------------------------------------- load once at startup
BUNDLE = joblib.load(os.path.join(ROOT, "models", "price_model.joblib"))
MODEL, Q_LOW, Q_HIGH, NBR, TOP_CITIES = (BUNDLE[k] for k in ("model", "q_low", "q_high", "nbr", "top_cities"))
with open(os.path.join(ROOT, "models", "model_meta.json"), encoding="utf-8") as f:
    META = json.load(f)

L = pd.read_csv(os.path.join(ROOT, "data", "listings.csv"))
L["ppsf"] = L.price / L.sqft
# deal = how far the asking price is from the AI's fair price (negative = cheaper than fair)
L["deal_pct"] = ((L.price / L.fair_price - 1) * 100).round(1)
# >45% below the model's price is far more likely a data error than a bargain
SUSPICIOUS_PCT = -45
L["suspicious"] = L.deal_pct <= SUSPICIOUS_PCT
L["status"] = np.where(L.under_construction == 1, "Under construction", "Ready to move")

LOCALITIES = (
    L.groupby(["city", "locality"])
    .agg(lat=("lat", "median"), lon=("lon", "median"), n=("id", "size"), ppsf=("ppsf", "median"))
    .reset_index()
)
LOCALITIES["label"] = LOCALITIES.locality + ", " + LOCALITIES.city

# Human-friendly groups for explaining a prediction
FACTOR_GROUPS = {
    "Location & neighbourhood": ["lat", "lon", "city", "nbr_log_ppsf", "nbr_spread", "nbr_dist_km"],
    "Size & layout": ["log_sqft", "bhk", "sqft_per_bhk", "is_rk"],
    "Construction status": ["under_construction", "ready_to_move", "resale"],
    "Seller & RERA": ["posted_by", "rera"],
}

app = FastAPI(title="GharAI", version="1.0")


def clean_records(df: pd.DataFrame) -> list:
    return json.loads(df.to_json(orient="records"))


def apply_filters(city, q, bhk, min_price, max_price, posted_by, rera, status, deals_only):
    m = pd.Series(True, index=L.index)
    if city:
        m &= L.city.str.lower() == city.lower()
    if q:
        m &= L.address.str.contains(q, case=False, regex=False)
    if bhk:
        m &= L.bhk >= 5 if bhk >= 5 else L.bhk == bhk
    if min_price:
        m &= L.price >= min_price
    if max_price:
        m &= L.price <= max_price
    if posted_by:
        m &= L.posted_by == posted_by
    if rera:
        m &= L.rera == 1
    if status:
        m &= L.status == status
    if deals_only:
        m &= (L.deal_pct <= -10) & ~L.suspicious
    return L[m]


# ---------------------------------------------------------------- endpoints
@app.get("/api/overview")
def overview():
    cities = (
        L.groupby("city")
        .agg(listings=("id", "size"), median_price=("price", "median"), median_ppsf=("ppsf", "median"),
             lat=("lat", "median"), lon=("lon", "median"))
        .reset_index().sort_values("listings", ascending=False)
    )
    return {
        "model": META,
        "total_listings": int(len(L)),
        "cities": clean_records(cities.head(40).round(0)),
    }


@app.get("/api/search-suggest")
def search_suggest(q: str = Query(..., min_length=2), limit: int = 8):
    ql = q.lower()
    cities = L.city.drop_duplicates()
    c = cities[cities.str.lower().str.startswith(ql)].head(4)
    loc = LOCALITIES[LOCALITIES.label.str.lower().str.contains(ql, regex=False)].sort_values("n", ascending=False)
    return {
        "cities": [{"city": x, "listings": int((L.city == x).sum())} for x in c],
        "localities": clean_records(loc.head(limit)[["city", "locality", "label", "lat", "lon", "n"]]),
    }


@app.get("/api/listings")
def listings(
    city: Optional[str] = None, q: Optional[str] = None, bhk: Optional[int] = None,
    min_price: Optional[float] = None, max_price: Optional[float] = None,
    posted_by: Optional[str] = None, rera: bool = False, status: Optional[str] = None,
    deals_only: bool = False,
    sort: Literal["deal", "price_asc", "price_desc", "ppsf_asc", "size_desc"] = "deal",
    page: int = 1, page_size: int = Query(24, le=60),
):
    df = apply_filters(city, q, bhk, min_price, max_price, posted_by, rera, status, deals_only)
    order = {"deal": ("deal_pct", True), "price_asc": ("price", True), "price_desc": ("price", False),
             "ppsf_asc": ("ppsf", True), "size_desc": ("sqft", False)}[sort]
    df = df.sort_values(order[0], ascending=order[1])
    if sort == "deal":  # real deals first, likely-data-errors last
        df = pd.concat([df[~df.suspicious], df[df.suspicious]])
    start = (page - 1) * page_size
    # map pins: compact arrays [id, lat, lon, price, deal_pct] for (up to) all matches
    pins = df.head(6000)[["id", "lat", "lon", "price", "deal_pct"]].values.round(5).tolist()
    return {
        "total": int(len(df)),
        "median_price": float(df.price.median()) if len(df) else None,
        "median_ppsf": float(df.ppsf.median()) if len(df) else None,
        "results": clean_records(df.iloc[start:start + page_size]),
        "pins": pins,
    }


@app.get("/api/listings/{listing_id}")
def listing_detail(listing_id: int):
    if listing_id not in L.index:
        raise HTTPException(404, "Listing not found")
    row = L.loc[listing_id]
    est = estimate_core(L.loc[[listing_id]], exclude_self=True)
    fair = float(row.fair_price)
    return {"listing": clean_records(L.loc[[listing_id]])[0], "explanation": est["factors"],
            # the quantile models' range, re-centred on this listing's out-of-fold fair price
            "fair_low": round(fair * est["low"] / est["price"], -3),
            "fair_high": round(fair * est["high"] / est["price"], -3),
            "comparables": comparables(row.lat, row.lon, row.bhk, exclude_id=listing_id)}


class EstimateRequest(BaseModel):
    lat: float = Field(..., ge=6, le=37)
    lon: float = Field(..., ge=68, le=98)
    city: str
    sqft: float = Field(..., ge=250, le=10000)
    bhk: int = Field(..., ge=1, le=10)
    unit_type: Literal["BHK", "RK"] = "BHK"
    posted_by: Literal["Owner", "Dealer", "Builder"] = "Owner"
    under_construction: bool = False
    rera: bool = False
    resale: bool = True


def estimate_core(df: pd.DataFrame, exclude_self=False) -> dict:
    X = build_features(df, NBR, TOP_CITIES, exclude_self=exclude_self)
    price = float(np.exp(MODEL.predict(X))[0])
    low = float(np.exp(Q_LOW.predict(X))[0])
    high = float(np.exp(Q_HIGH.predict(X))[0])
    low, high = min(low, price * 0.97), max(high, price * 1.03)

    # SHAP values: how much each feature pushed THIS prediction up or down (in log-price).
    # LightGBM computes them exactly for tree models with pred_contrib=True.
    contrib = MODEL.predict(X, pred_contrib=True)[0]
    base_log, parts = contrib[-1], dict(zip(X.columns, contrib[:-1]))
    factors = []
    for name, cols in FACTOR_GROUPS.items():
        v = sum(parts[c] for c in cols)
        factors.append({"factor": name, "effect_pct": round((np.exp(v) - 1) * 100, 1)})
    factors.sort(key=lambda f: -abs(f["effect_pct"]))
    return {
        "price": round(price, -3), "low": round(low, -3), "high": round(high, -3),
        "ppsf": round(price / float(df.sqft.iloc[0])),
        "typical_home_price": round(float(np.exp(base_log)), -3),
        "neighbourhood_ppsf": round(float(np.exp(X.nbr_log_ppsf.iloc[0]))),
        "factors": factors,
    }


def comparables(lat, lon, bhk, exclude_id=None, n=6):
    d = L.assign(km=haversine_km(L.lat, L.lon, lat, lon))
    d = d[(d.km <= 15) & (d.bhk.between(bhk - 1, bhk + 1))]
    if exclude_id is not None:
        d = d[d.id != exclude_id]
    d = d.assign(score=d.km + (d.bhk - bhk).abs() * 2).nsmallest(n, "score")
    return clean_records(d.round({"km": 2}))


@app.post("/api/estimate")
def estimate(req: EstimateRequest):
    df = pd.DataFrame([{
        "lat": req.lat, "lon": req.lon, "city": req.city.title(), "sqft": req.sqft, "bhk": req.bhk,
        "unit_type": req.unit_type, "posted_by": req.posted_by,
        "under_construction": int(req.under_construction), "rera": int(req.rera),
        "ready_to_move": int(not req.under_construction), "resale": int(req.resale),
    }])
    out = estimate_core(df)
    out["comparables"] = comparables(req.lat, req.lon, req.bhk)
    near = haversine_km(L.lat, L.lon, req.lat, req.lon)
    out["listings_within_5km"] = int((near <= 5).sum())
    out["confidence"] = "High" if out["listings_within_5km"] >= 30 else "Medium" if out["listings_within_5km"] >= 8 else "Low"
    return out


@app.get("/api/insights/{city}")
def insights(city: str):
    d = L[L.city.str.lower() == city.lower()]
    if d.empty:
        raise HTTPException(404, "City not found")
    loc = (d.groupby("locality").agg(n=("id", "size"), ppsf=("ppsf", "median"), price=("price", "median"))
           .query("n >= 5").sort_values("ppsf", ascending=False).reset_index())
    by_bhk = d.assign(b=d.bhk.clip(upper=5)).groupby("b").agg(n=("id", "size"), price=("price", "median")).reset_index()
    return {
        "city": d.city.iloc[0], "listings": int(len(d)),
        "median_price": float(d.price.median()), "median_ppsf": float(d.ppsf.median()),
        "under_construction_share": round(float(d.under_construction.mean() * 100), 1),
        "rera_share": round(float(d.rera.mean() * 100), 1),
        "seller_mix": d.posted_by.value_counts().to_dict(),
        "priciest_localities": clean_records(loc.head(8).round(0)),
        "affordable_localities": clean_records(loc.tail(8).iloc[::-1].round(0)),
        "by_bhk": clean_records(by_bhk.round(0)),
    }


# ---------------------------------------------------------------- enquiries (buyer -> seller leads)
# Stored in a local SQLite file. SQLite ships with Python: a whole database in one file,
# perfect for a prototype. (A real deployment would use Postgres + seller logins.)
DB_PATH = os.path.join(ROOT, "data", "enquiries.db")
ENQUIRY_STATUSES = ["New", "Contacted", "Visit scheduled", "Closed"]


def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


with db() as _con:
    _con.execute("""
        CREATE TABLE IF NOT EXISTS enquiries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            listing_id INTEGER NOT NULL,
            kind TEXT NOT NULL,              -- callback | visit | question
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            email TEXT,
            contact_via TEXT NOT NULL,       -- Call | WhatsApp | Email
            message TEXT,
            visit_date TEXT,
            visit_slot TEXT,
            needs_loan INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'New',
            seller_note TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        )""")


class EnquiryIn(BaseModel):
    listing_id: int
    kind: Literal["callback", "visit", "question"] = "callback"
    name: str = Field(..., min_length=2, max_length=60)
    # Indian mobile numbers: 10 digits starting 6-9, optional +91 / 0 prefix
    phone: str = Field(..., pattern=r"^(\+91[\s-]?|0)?[6-9]\d{9}$")
    email: Optional[str] = Field(None, max_length=120, pattern=r"^$|^[^@\s]+@[^@\s]+\.[^@\s]+$")
    contact_via: Literal["Call", "WhatsApp", "Email"] = "Call"
    message: Optional[str] = Field(None, max_length=1000)
    visit_date: Optional[str] = Field(None, pattern=r"^$|^\d{4}-\d{2}-\d{2}$")
    visit_slot: Optional[Literal["", "Morning", "Afternoon", "Evening"]] = None
    needs_loan: bool = False


class EnquiryUpdate(BaseModel):
    status: Optional[Literal["New", "Contacted", "Visit scheduled", "Closed"]] = None
    seller_note: Optional[str] = Field(None, max_length=500)


def enquiry_out(row: sqlite3.Row) -> dict:
    e = dict(row)
    e["needs_loan"] = bool(e["needs_loan"])
    if e["listing_id"] in L.index:
        l = L.loc[e["listing_id"]]
        e["listing"] = {"id": int(l.id), "price": float(l.price), "bhk": int(l.bhk), "sqft": float(l.sqft),
                        "locality": l.locality, "city": l.city, "posted_by": l.posted_by}
    return e


@app.post("/api/enquiries", status_code=201)
def create_enquiry(e: EnquiryIn):
    if e.listing_id not in L.index:
        raise HTTPException(404, "Listing not found")
    if e.contact_via == "Email" and not e.email:
        raise HTTPException(422, "Please add an email address to be contacted by email")
    phone = re.sub(r"\D", "", e.phone)[-10:]
    with db() as con:
        # Simple spam guard: same phone + same home within 10 minutes = same enquiry
        dup = con.execute("""SELECT * FROM enquiries WHERE phone = ? AND listing_id = ?
                             AND created_at >= datetime('now', 'localtime', '-10 minutes')""",
                          (phone, e.listing_id)).fetchone()
        if dup:
            return {**enquiry_out(dup), "duplicate": True}
        cur = con.execute(
            """INSERT INTO enquiries (listing_id, kind, name, phone, email, contact_via, message,
                                      visit_date, visit_slot, needs_loan)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (e.listing_id, e.kind, e.name.strip(), phone, (e.email or "").strip() or None, e.contact_via,
             (e.message or "").strip() or None, e.visit_date or None, e.visit_slot or None, int(e.needs_loan)))
        row = con.execute("SELECT * FROM enquiries WHERE id = ?", (cur.lastrowid,)).fetchone()
    return enquiry_out(row)


@app.get("/api/enquiries")
def list_enquiries(status: Optional[str] = None):
    with db() as con:
        rows = con.execute("SELECT * FROM enquiries ORDER BY id DESC").fetchall()
        counts = dict(con.execute("SELECT status, COUNT(*) FROM enquiries GROUP BY status").fetchall())
    items = [enquiry_out(r) for r in rows if not status or r["status"] == status]
    return {"items": items, "counts": {s: counts.get(s, 0) for s in ENQUIRY_STATUSES}}


@app.patch("/api/enquiries/{enquiry_id}")
def update_enquiry(enquiry_id: int, u: EnquiryUpdate):
    with db() as con:
        if not con.execute("SELECT 1 FROM enquiries WHERE id = ?", (enquiry_id,)).fetchone():
            raise HTTPException(404, "Enquiry not found")
        if u.status is not None:
            con.execute("UPDATE enquiries SET status = ? WHERE id = ?", (u.status, enquiry_id))
        if u.seller_note is not None:
            con.execute("UPDATE enquiries SET seller_note = ? WHERE id = ?", (u.seller_note.strip(), enquiry_id))
        return enquiry_out(con.execute("SELECT * FROM enquiries WHERE id = ?", (enquiry_id,)).fetchone())


# ---------------------------------------------------------------- website
FRONTEND = os.path.join(ROOT, "frontend")
app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(FRONTEND, "index.html"))


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(os.path.join(FRONTEND, "favicon.svg"), media_type="image/svg+xml")
