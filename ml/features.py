"""
Feature engineering shared by training (ml/train.py) and the website API (backend/main.py).

Keeping this in ONE place guarantees the model sees features computed exactly the same
way at training time and at prediction time ("training/serving skew" is a classic bug).
"""
import numpy as np
import pandas as pd
from sklearn.neighbors import BallTree

K_NEIGHBORS = 15          # how many nearby homes to look at
EARTH_KM = 6371.0


def haversine_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_KM * np.arcsin(np.sqrt(a))


class NeighborhoodIndex:
    """'Comps': median price-per-sqft of the K nearest homes (like a broker's comparables).

    A BallTree finds nearest neighbours on a sphere quickly (haversine distance).
    """

    def __init__(self, lat, lon, log_ppsf):
        self.tree = BallTree(np.radians(np.c_[lat, lon]), metric="haversine")
        self.log_ppsf = np.asarray(log_ppsf)

    def query(self, lat, lon, exclude_self=False):
        k = K_NEIGHBORS + (1 if exclude_self else 0)
        dist, idx = self.tree.query(np.radians(np.c_[lat, lon]), k=k)
        if exclude_self:  # a home must not be its own comparable (that's cheating = leakage)
            dist, idx = dist[:, 1:], idx[:, 1:]
        vals = self.log_ppsf[idx]
        return pd.DataFrame({
            "nbr_log_ppsf": np.median(vals, axis=1),
            "nbr_spread": vals.std(axis=1),                  # how varied the area is
            "nbr_dist_km": np.median(dist, axis=1) * EARTH_KM,  # how dense / remote
        })


def build_features(df, nbr: NeighborhoodIndex, top_cities, exclude_self=False) -> pd.DataFrame:
    X = pd.DataFrame({
        "lat": df.lat.values, "lon": df.lon.values,
        "log_sqft": np.log(df.sqft.values),
        "bhk": df.bhk.values,
        "sqft_per_bhk": (df.sqft / df.bhk).values,
        "under_construction": df.under_construction.values,
        "rera": df.rera.values,
        "ready_to_move": df.ready_to_move.values,
        "resale": df.resale.values,
        "is_rk": (df.unit_type == "RK").astype(int).values,
        "posted_by": pd.Categorical(df.posted_by.values, categories=["Owner", "Dealer", "Builder"]),
        "city": pd.Categorical(np.where(df.city.isin(top_cities), df.city, "Other"),
                               categories=sorted(top_cities) + ["Other"]),
    })
    return pd.concat([X, nbr.query(df.lat.values, df.lon.values, exclude_self)], axis=1)
