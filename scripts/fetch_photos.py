"""
Download openly licensed photos from Wikimedia Commons for the website.

Run:  python scripts/fetch_photos.py

The dataset has no photos of the actual homes, so the site shows:
  * a real photo of each CITY (the lead image of its Wikipedia article), and
  * REPRESENTATIVE photos (exteriors, living rooms, kitchens, bedrooms), always labelled as such.

Every photo is CC0 / public domain / CC BY / CC BY-SA. CC BY licences REQUIRE credit,
so we save author + licence + source for each file to frontend/photos/credits.json.
"""
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "frontend", "photos")
UA = {"User-Agent": "GharAI-learning-project/1.0 (educational use)"}
FREE = re.compile(r"^(CC0|Public domain|CC BY(-SA)? [0-9.]+)$")
WIDTH = 960  # one of Wikimedia's standard thumbnail widths

# Wikipedia article whose lead image represents each city in our data
CITIES = {
    "Bangalore": "Bangalore", "Mumbai": "Mumbai", "Pune": "Pune", "Noida": "Noida", "Kolkata": "Kolkata",
    "Chennai": "Chennai", "Ghaziabad": "Ghaziabad", "Jaipur": "Jaipur", "Chandigarh": "Chandigarh",
    "Faridabad": "Faridabad", "Mohali": "Mohali", "Vadodara": "Vadodara", "Gurgaon": "Gurgaon", "Surat": "Surat",
    "Nagpur": "Nagpur", "Lucknow": "Lucknow", "Bhubaneswar": "Bhubaneswar", "Indore": "Indore", "Kochi": "Kochi",
    "Bhopal": "Bhopal", "Visakhapatnam": "Visakhapatnam", "Coimbatore": "Coimbatore", "Hyderabad": "Hyderabad",
    "Ahmedabad": "Ahmedabad", "Maharashtra": "Maharashtra",
}

# Hand-picked Commons files (reviewed visually; noisy search results were rejected)
REPRESENTATIVE = {
    "exterior": [
        "Ganesh Apartment, Kasba Peth, Pune.jpg",
        "Pune Skyline 2018.jpg",
        "A View of Residential Complex at Hydershakote.jpg",
        "New Residential Complex at Hydershakote.JPG",
        "Rajapushpa Provincia and My Home Avatar complexes - High-rise residential skyline in Hyderabad.jpg",
        "An apartment in OMR.jpg",
        "Magarpatta Residential Zone.JPG",
        "A residential apartment in Hitec City, Hyderabad.jpg",
        "Chandni chowk pune (2).jpg",
    ],
    "living": [
        "Living room (Unsplash).jpg",
        "Modern living room with large windows showing view of trees and lake in daylight.jpg",
        "Modern living room with stylish furniture and a view of the outdoors in a cozy apartment setting.jpg",
        "Artchapiz1 artchapiz.es apartment rental granada 01.jpg",
        "Budapest Apartment (Unsplash).jpg",
        "Living room Germany 2006.jpg",
    ],
    "kitchen": [
        "A stylish living area features a modern kitchen, comfortable seating, and large windows allowing ample natural ligh.jpg",
        "Modern dining area with stylish table and chairs in cozy interior design.jpg",
        "Modern kitchen and dining area in a simple home setting showing light colors and minimal decor.jpg",
        "Modern kitchen and dining area with stylish furnishings and natural light in a contemporary home setting.jpg",
        "Modern luxury living room with kitchen interior.jpg",
    ],
    "bedroom": [
        "Balanced Modern Bedroom Design with Neutral Tones and Layered Lighting.jpg",
        "Canopy bed of Amantaka Suite in Amantaka luxury Resort & Hotel in Luang Prabang Laos.jpg",
        "Modern bedroom design in a stylish hotel room featuring geometric patterns and soft linens.jpg",
    ],
}


def get(url: str) -> bytes:
    for attempt in range(6):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
        except urllib.error.HTTPError as e:
            if e.code == 429:  # rate limited: be polite and back off
                time.sleep(5 * (attempt + 1))
                continue
            raise
    raise RuntimeError(f"Gave up after rate limiting: {url}")


def api(host: str, **params) -> dict:
    return json.loads(get(f"https://{host}/w/api.php?" + urllib.parse.urlencode({**params, "format": "json"})))


def file_info(titles: list) -> dict:
    """Commons metadata (thumbnail url, licence, author) for up to 50 'File:...' titles."""
    r = api("commons.wikimedia.org", action="query", titles="|".join(titles), prop="imageinfo",
            iiprop="url|extmetadata", iiurlwidth=WIDTH)
    renamed = {n["to"]: n["from"] for n in r["query"].get("normalized", [])}
    out = {}
    for p in r["query"]["pages"].values():
        if "imageinfo" not in p:
            print("  ! not found:", p["title"])
            continue
        ii, meta = p["imageinfo"][0], p["imageinfo"][0]["extmetadata"]
        out[renamed.get(p["title"], p["title"])] = {
            "thumb": ii["thumburl"],
            "source": ii["descriptionurl"],
            "license": meta.get("LicenseShortName", {}).get("value", ""),
            "author": re.sub(r"<[^>]+>", "", meta.get("Artist", {}).get("value", "Unknown")).strip(),
        }
    return out


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def main():
    os.makedirs(OUT, exist_ok=True)
    # 1) city -> lead image of its Wikipedia article
    r = api("en.wikipedia.org", action="query", titles="|".join(CITIES.values()), prop="pageimages",
            piprop="name", redirects=1)
    alias = {x["from"]: x["to"] for x in r["query"].get("redirects", []) + r["query"].get("normalized", [])}
    lead = {p["title"]: p.get("pageimage") for p in r["query"]["pages"].values()}
    wanted = [("city", city, lead.get(alias.get(t, t))) for city, t in CITIES.items()]
    wanted += [(group, f"{group}-{i + 1}", f) for group, files in REPRESENTATIVE.items() for i, f in enumerate(files)]
    wanted = [(g, k, "File:" + f.replace("_", " ")) for g, k, f in wanted if f]

    info = {}
    for i in range(0, len(wanted), 40):
        info.update(file_info([t for _, _, t in wanted[i:i + 40]]))
        time.sleep(1)

    credits = {"cities": {}, "exterior": [], "living": [], "kitchen": [], "bedroom": []}
    for group, key, title in wanted:
        meta = info.get(title)
        if not meta or not FREE.match(meta["license"]):
            print(f"  - skipped {title} ({meta and meta['license']})")
            continue
        fname = f"{group}-{slug(key)}.jpg" if group == "city" else f"{slug(key)}.jpg"
        path = os.path.join(OUT, fname)
        if not os.path.exists(path):
            with open(path, "wb") as f:
                f.write(get(meta["thumb"]))
            time.sleep(1)
        entry = {"src": f"/static/photos/{fname}", "title": title[5:].rsplit(".", 1)[0],
                 "author": meta["author"][:120], "license": meta["license"], "source": meta["source"]}
        if group == "city":
            credits["cities"][key] = entry
        else:
            credits[group].append(entry)
        print(f"  ✓ {fname}  ({meta['license']})")

    with open(os.path.join(OUT, "credits.json"), "w", encoding="utf-8") as f:
        json.dump(credits, f, indent=1, ensure_ascii=False)
    n = len(credits["cities"]) + sum(len(v) for k, v in credits.items() if k != "cities")
    print(f"\nSaved {n} photos + credits.json to {OUT}")


if __name__ == "__main__":
    main()
