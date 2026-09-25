/* GharAI front-end: a tiny hash-router single-page app (no build step). */
const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
let overviewCache = null;

// ------------------------------------------------------------------ helpers
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** ₹ in Indian units: 1 Lakh = 1,00,000 · 1 Crore = 1,00,00,000 */
function inr(v, short = false) {
  if (v == null || isNaN(v)) return "—";
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(v >= 1e8 ? 1 : 2).replace(/\.?0+$/, "")} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(short ? 0 : 1).replace(/\.0$/, "")} L`;
  return "₹" + Math.round(v).toLocaleString("en-IN");
}
const num = (v) => Math.round(v).toLocaleString("en-IN");
const pinLabel = (v) => (v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : `${Math.round(v / 1e5)}L`);

// Listings priced >45% below the model are far more likely to be data errors than bargains.
const SUSPICIOUS = -45;
function dealPill(d) {
  if (d == null) return "";
  if (d <= SUSPICIOUS) return `<span class="pill warn">⚠ Unusual price, verify</span>`;
  if (d <= -10) return `<span class="pill good">▼ ${Math.abs(d).toFixed(0)}% below fair price</span>`;
  if (d >= 15) return `<span class="pill bad">▲ ${d.toFixed(0)}% above fair price</span>`;
  return `<span class="pill neutral">Fairly priced</span>`;
}
const dealClass = (d) => (d <= SUSPICIOUS ? "bad" : d <= -10 ? "good" : d >= 15 ? "bad" : "");

/** Deterministic illustrated "photo" per listing (the dataset has no images). */
function houseArt(id, bhk = 2, uc = 0) {
  const palettes = [
    ["#fde8d0", "#f7c59f", "#e07a5f"], ["#dbeafe", "#bfdbfe", "#1d4ed8"], ["#dcfce7", "#bbf7d0", "#15803d"],
    ["#fef3c7", "#fde68a", "#b45309"], ["#ede9fe", "#ddd6fe", "#6d28d9"], ["#fce7f3", "#fbcfe8", "#be185d"],
    ["#e0f2fe", "#bae6fd", "#0369a1"], ["#f1f5f9", "#e2e8f0", "#334155"],
  ];
  const [sky, sky2, tone] = palettes[id % palettes.length];
  const floors = 3 + ((id * 7) % 6) + Math.min(bhk, 4);
  const w = 90 + ((id * 13) % 40);
  const x = 160 - w / 2, h = floors * 14, y = 150 - h;
  let windows = "";
  for (let f = 0; f < floors; f++)
    for (let c = 0; c < Math.floor(w / 22); c++)
      windows += `<rect x="${x + 10 + c * 22}" y="${y + 8 + f * 14}" width="12" height="7" rx="1.5" fill="${(f * 3 + c + id) % 5 ? "#ffffffcc" : "#fde68a"}"/>`;
  const side = (sx, sh, op) => `<rect x="${sx}" y="${150 - sh}" width="46" height="${sh}" fill="${tone}" opacity="${op}"/>`;
  return `<svg viewBox="0 0 320 170" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="${sky2}"/></linearGradient></defs>
    <rect width="320" height="170" fill="url(#g${id})"/>
    <circle cx="${250 - (id % 5) * 12}" cy="38" r="16" fill="#fff" opacity=".7"/>
    ${side(20, 60 + (id % 4) * 12, 0.25)}${side(255, 50 + (id % 3) * 16, 0.25)}
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${tone}"/>
    ${windows}
    ${uc ? `<path d="M${x + w - 6} ${y} v-34 h40 M${x + w - 6} ${y - 34} l-26 0" stroke="#f59e0b" stroke-width="3" fill="none"/>` : ""}
    <rect y="150" width="320" height="20" fill="${tone}" opacity=".35"/>
    <circle cx="${x - 14}" cy="140" r="11" fill="#22c55e" opacity=".8"/><circle cx="${x + w + 14}" cy="142" r="9" fill="#16a34a" opacity=".8"/>
  </svg>`;
}

function listingCard(l) {
  return `<article class="listing" data-id="${l.id}">
    <div class="img">${cardImage(l)}${dealPill(l.deal_pct)}</div>
    <div class="body">
      <div class="price">${inr(l.price)}</div>
      <div class="specs"><b>${l.bhk}</b> ${l.unit_type} · <b>${num(l.sqft)}</b> sq ft · ${inr(l.ppsf)}/sqft</div>
      <div class="addr">${esc(l.locality)}, ${esc(l.city)}</div>
      <div class="est"><span class="muted">GharEstimate™</span><b>${inr(l.fair_price)}</b></div>
    </div>
  </article>`;
}

function loading(msg = "Loading…") { return `<div class="loading"><div class="spinner"></div>${msg}</div>`; }

function tiles(map) {
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
}

/** Search box with city + locality suggestions. onPick receives {type, city, locality, lat, lon}. */
function attachSuggest(input, box, onPick) {
  let timer, items = [], hl = -1;
  const render = () => {
    if (!items.length) { box.hidden = true; return; }
    let html = "", lastGroup = "";
    items.forEach((it, i) => {
      if (it.group !== lastGroup) { html += `<div class="group">${it.group}</div>`; lastGroup = it.group; }
      html += `<div class="item ${i === hl ? "hl" : ""}" data-i="${i}"><span>${esc(it.label)}</span><span class="muted">${it.n} homes</span></div>`;
    });
    box.innerHTML = html; box.hidden = false;
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { items = []; render(); return; }
    timer = setTimeout(async () => {
      const r = await api(`/api/search-suggest?q=${encodeURIComponent(q)}`);
      items = [
        ...r.cities.map((c) => ({ group: "Cities", type: "city", label: c.city, city: c.city, n: c.listings })),
        ...r.localities.map((l) => ({ group: "Localities", type: "locality", label: l.label, n: l.n, ...l })),
      ];
      hl = -1; render();
    }, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { hl = Math.min(hl + 1, items.length - 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { hl = Math.max(hl - 1, 0); render(); e.preventDefault(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (items[hl] || items[0]) pick(items[hl] ?? items[0]);
      else if (input.value.trim()) onPick({ type: "text", q: input.value.trim() });
    } else if (e.key === "Escape") { items = []; render(); }
  });
  box.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".item");
    if (el) pick(items[+el.dataset.i]);
  });
  input.addEventListener("blur", () => setTimeout(() => (box.hidden = true), 150));
  function pick(it) { input.value = it.label; items = []; render(); onPick(it); }
}

// ------------------------------------------------------------------ router
const routes = {
  "": renderHome, search: renderSearch, estimate: renderEstimate, insights: renderInsights, "how-it-works": renderHow,
  emi: renderEmi, leads: renderLeads, credits: renderCredits,
};

let lastRendered = null;
function router() {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const [page, arg] = path.split("/");
  const params = new URLSearchParams(query || "");
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
  document.body.classList.remove("nav-open");
  if (page === "listing") { openListing(+arg); if (!view.innerHTML) renderSearch(params); return; }
  const wasOpen = drawer.classList.contains("open");
  closeDrawer(false);
  closeModal();
  if (wasOpen && location.hash === lastRendered) return;  // closing the drawer: keep the page as-is
  lastRendered = location.hash;
  (routes[page] || renderHome)(params);
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", async () => { await loadPhotos(); router(); });

// ------------------------------------------------------------------ HOME
async function renderHome() {
  view.innerHTML = `
  <section class="hero" ${cityPhoto("Mumbai") ? `style="--hero-img:url('${cityPhoto("Mumbai").src}')"` : ""}>
    <svg class="hero-skyline" viewBox="0 0 1200 160" preserveAspectRatio="none"><path fill="#fff" d="M0 160V90h40V60h30v30h30V40h40v50h20V70h50v90h30V30h20V10h20v20h20v130h40V80h60V50h30v110h40V90h30V60h40v100h30V20h50v140h30V70h40v90h40V100h30V40h20v120h50V80h40V60h30v100h40V30h30v130h40V90h50v70z"/></svg>
    <div style="position:relative;width:100%">
      <h1>Know the fair price of any home in India</h1>
      <p>Search real listings from 250+ cities. Our AI prices every home, so you can spot a great deal (or an overpriced one) in seconds.</p>
      <div class="hero-tabs"><button class="active" data-mode="buy">Buy</button><button data-mode="estimate">Price my home</button></div>
      <div class="searchbox">
        <div class="field"><input id="heroq" placeholder="Enter a city or locality, e.g. Whitefield, Bangalore" autocomplete="off" /><button class="btn" id="herogo">Search</button></div>
        <div class="suggest" id="herosug" hidden></div>
      </div>
    </div>
  </section>
  <div class="container">
    <div class="card stats-strip" id="stats">${loading()}</div>
    <div style="margin:56px 0 18px"><h2 class="section-title">Explore by city</h2><p class="section-sub">Median asking prices from real listings</p></div>
    <div class="city-grid" id="cities"></div>
    <div style="margin:64px 0 18px"><h2 class="section-title">Everything you need to buy smart</h2><p class="section-sub">Powered by a machine-learning model trained on 23,000+ Indian homes</p></div>
    <div class="features">
      <div class="card feature"><div class="ico">🔎</div><h3>Find a deal</h3><p>Every listing is compared with the AI's fair price. Green badges flag homes priced well below what similar homes nearby cost.</p><a class="btn ghost" href="#/search?deals_only=1">Browse deals</a></div>
      <div class="card feature"><div class="ico">🏷️</div><h3>Price my home</h3><p>Tell us where your home is and how big it is. You get an instant estimate, a likely price range, and the reasons behind it.</p><a class="btn ghost" href="#/estimate">Get an estimate</a></div>
      <div class="card feature"><div class="ico">🧮</div><h3>EMI & true cost</h3><p>Monthly EMI, stamp duty, registration, GST and fees: see the cash you need on day one and the real cost over the full loan.</p><a class="btn ghost" href="#/emi">Calculate EMI</a></div>
      <div class="card feature"><div class="ico">📞</div><h3>Talk to the lister</h3><p>Request a call back, book a site visit or ask a question. Your number goes only to that owner, dealer or builder.</p><a class="btn ghost" href="#/search">Find a home</a></div>
      <div class="card feature"><div class="ico">📊</div><h3>Market insights</h3><p>Compare ₹/sqft across localities, see which areas are premium or affordable, and how prices scale with BHK.</p><a class="btn ghost" href="#/insights">See insights</a></div>
    </div>
  </div>
  <footer class="foot">GharAI is a learning project. Listings come from a public dataset (MachineHack "House Price Prediction Challenge"). Estimates are model predictions, not valuations. Photos are openly licensed from Wikimedia Commons: <a href="#/credits" style="text-decoration:underline">photo credits</a>.</footer>`;

  let mode = "buy";
  view.querySelectorAll(".hero-tabs button").forEach((b) => b.onclick = () => {
    mode = b.dataset.mode;
    view.querySelectorAll(".hero-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $("#heroq").placeholder = mode === "buy" ? "Enter a city or locality, e.g. Whitefield, Bangalore" : "Where is your home? e.g. Andheri West, Mumbai";
    $("#herogo").textContent = mode === "buy" ? "Search" : "Estimate";
  });
  const go = (it) => {
    if (mode === "estimate") {
      if (it.type === "locality") location.hash = `#/estimate?lat=${it.lat}&lon=${it.lon}&city=${encodeURIComponent(it.city)}&loc=${encodeURIComponent(it.label)}`;
      else location.hash = "#/estimate";
      return;
    }
    if (it.type === "city") location.hash = `#/search?city=${encodeURIComponent(it.city)}`;
    else if (it.type === "locality") location.hash = `#/search?city=${encodeURIComponent(it.city)}&q=${encodeURIComponent(it.locality)}`;
    else location.hash = `#/search?q=${encodeURIComponent(it.q)}`;
  };
  attachSuggest($("#heroq"), $("#herosug"), go);
  $("#herogo").onclick = () => { const q = $("#heroq").value.trim(); q ? go({ type: "text", q }) : (location.hash = mode === "buy" ? "#/search" : "#/estimate"); };

  const o = overviewCache ||= await api("/api/overview");
  const lgbm = o.model.metrics["LightGBM (gradient boosting)"];
  $("#stats").innerHTML = `
    <div class="stat"><b>${num(o.total_listings)}</b><span>real listings analysed</span></div>
    <div class="stat"><b>${o.model.n_cities}</b><span>cities &amp; towns</span></div>
    <div class="stat"><b>±${lgbm.median_error_pct}%</b><span>typical AI pricing error</span></div>
    <div class="stat"><b>${lgbm.within_20pct}%</b><span>of homes priced within 20%</span></div>`;
  $("#cities").innerHTML = o.cities.slice(0, 12).map((c) => `
    <div class="card city-card" data-city="${esc(c.city)}">
      ${cityPhoto(c.city) ? `<div class="city-img"><img src="${cityPhoto(c.city).src}" alt="${esc(c.city)}" loading="lazy"/></div>` : ""}
      <div class="city-body"><h3>${esc(c.city)}</h3><div class="muted">${num(c.listings)} homes</div>
      <div class="big">${inr(c.median_price)}</div><div class="muted">${inr(c.median_ppsf)} / sq ft</div></div>
    </div>`).join("");
  view.querySelectorAll(".city-card").forEach((el) => el.onclick = () => location.hash = `#/search?city=${encodeURIComponent(el.dataset.city)}`);
}

// ------------------------------------------------------------------ SEARCH
let searchMap, clusterLayer, pinIndex = {};

async function renderSearch(params) {
  const p = Object.fromEntries(params.entries());
  p.page = +(p.page || 1);
  p.sort = p.sort || "deal";

  view.innerHTML = `
  <div class="search-page" id="sp">
    <section class="results-pane">
      <div class="filters">
        <div class="searchbox" style="flex:1 1 240px;width:auto;margin:0"><input type="search" id="fq" placeholder="City, locality or address" value="${esc([p.q, p.city].filter(Boolean).join(", "))}" style="width:100%" autocomplete="off"/><div class="suggest" id="fsug" hidden></div></div>
        <select id="fbhk"><option value="">Any BHK</option>${[1, 2, 3, 4].map((b) => `<option value="${b}" ${p.bhk == b ? "selected" : ""}>${b} BHK</option>`).join("")}<option value="5" ${p.bhk == 5 ? "selected" : ""}>5+ BHK</option></select>
        <select id="fmax"><option value="">Max price</option>${[25e5, 5e6, 75e5, 1e7, 15e6, 2e7, 3e7, 5e7].map((v) => `<option value="${v}" ${p.max_price == v ? "selected" : ""}>Up to ${inr(v)}</option>`).join("")}</select>
        <select id="fby"><option value="">Any seller</option>${["Owner", "Dealer", "Builder"].map((s) => `<option ${p.posted_by === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <select id="fstatus"><option value="">Any status</option>${["Ready to move", "Under construction"].map((s) => `<option ${p.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <button class="chip ${p.rera ? "on" : ""}" id="frera">RERA ✓</button>
        <button class="chip ${p.deals_only ? "on" : ""}" id="fdeal">🔥 Good deals</button>
      </div>
      <div class="results-head">
        <div><h2 id="rtitle">Homes for sale</h2><div class="muted" id="rsub"></div></div>
        <select id="fsort" class="chip" style="font-weight:600">
          ${[["deal", "Best deals first"], ["price_asc", "Price: low to high"], ["price_desc", "Price: high to low"], ["ppsf_asc", "₹/sqft: low to high"], ["size_desc", "Largest first"]].map(([v, t]) => `<option value="${v}" ${p.sort === v ? "selected" : ""}>${t}</option>`).join("")}
        </select>
      </div>
      <div class="results-scroll" id="rs">${loading("Finding homes…")}</div>
    </section>
    <section class="map-pane"><div id="map"></div>
      <div class="map-legend"><span><i style="background:var(--good)"></i>Good deal</span><span><i style="background:var(--brand)"></i>Fair</span><span><i style="background:#475467"></i>Overpriced</span></div>
    </section>
    <button class="btn mobile-map-toggle" id="mtoggle">🗺 Map</button>
  </div>`;

  const setParam = (k, v) => {
    const np = new URLSearchParams(params);
    v === "" || v == null || v === false ? np.delete(k) : np.set(k, v);
    if (k !== "page") np.delete("page");
    location.hash = "#/search?" + np.toString();
  };
  $("#fbhk").onchange = (e) => setParam("bhk", e.target.value);
  $("#fmax").onchange = (e) => setParam("max_price", e.target.value);
  $("#fby").onchange = (e) => setParam("posted_by", e.target.value);
  $("#fstatus").onchange = (e) => setParam("status", e.target.value);
  $("#fsort").onchange = (e) => setParam("sort", e.target.value);
  $("#frera").onclick = () => setParam("rera", p.rera ? "" : 1);
  $("#fdeal").onclick = () => setParam("deals_only", p.deals_only ? "" : 1);
  $("#mtoggle").onclick = () => { $("#sp").classList.toggle("show-map"); $("#mtoggle").textContent = $("#sp").classList.contains("show-map") ? "☰ List" : "🗺 Map"; searchMap?.invalidateSize(); };
  attachSuggest($("#fq"), $("#fsug"), (it) => {
    const np = new URLSearchParams(params); np.delete("page"); np.delete("q"); np.delete("city");
    if (it.type === "city") np.set("city", it.city);
    else if (it.type === "locality") { np.set("city", it.city); np.set("q", it.locality); }
    else np.set("q", it.q);
    location.hash = "#/search?" + np.toString();
  });
  $("#fq").addEventListener("search", () => { if (!$("#fq").value) { const np = new URLSearchParams(params); np.delete("q"); np.delete("city"); location.hash = "#/search?" + np; } });

  // map
  searchMap = L.map("map", { zoomControl: true, preferCanvas: true }).setView([22.5, 79], 5);
  tiles(searchMap);
  clusterLayer = L.markerClusterGroup({
    showCoverageOnHover: false, maxClusterRadius: 50, chunkedLoading: true,
    iconCreateFunction: (c) => {
      const n = c.getChildCount(), s = n < 50 ? 36 : n < 500 ? 46 : 56;
      return L.divIcon({ html: n, className: "marker-cluster-custom", iconSize: [s, s] });
    },
  });
  searchMap.addLayer(clusterLayer);

  const qs = new URLSearchParams({ ...p, page_size: 24 });
  let data;
  try { data = await api("/api/listings?" + qs); } catch (e) { $("#rs").innerHTML = `<div class="loading">Something went wrong: ${esc(e.message)}</div>`; return; }

  $("#rtitle").textContent = p.city ? `${p.q ? p.q + ", " : ""}${p.city} homes for sale` : p.q ? `Homes matching “${p.q}”` : "Homes for sale across India";
  $("#rsub").innerHTML = data.total ? `${num(data.total)} results · median ${inr(data.median_price)} · ${inr(data.median_ppsf)}/sqft` : "";

  const pages = Math.ceil(data.total / 24);
  $("#rs").innerHTML = data.total ? `
    <div class="grid">${data.results.map(listingCard).join("")}</div>
    <div class="pager">
      <button class="btn ghost" ${p.page <= 1 ? "disabled" : ""} id="prev">← Prev</button>
      <span class="muted">Page ${p.page} of ${pages}</span>
      <button class="btn ghost" ${p.page >= pages ? "disabled" : ""} id="next">Next →</button>
    </div>` : `<div class="empty-state"><div class="big-ico">🏚️</div><h3>No homes match these filters</h3><p class="muted">Try removing a filter or searching a nearby city.</p></div>`;
  $("#prev") && ($("#prev").onclick = () => setParam("page", p.page - 1));
  $("#next") && ($("#next").onclick = () => setParam("page", p.page + 1));

  // pins: [id, lat, lon, price, deal_pct]
  pinIndex = {};
  const markers = data.pins.map(([id, lat, lon, price, deal]) => {
    const m = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: `<span class="price-pin ${dealClass(deal)}">${pinLabel(price)}</span>`, iconSize: [0, 0] }) });
    m.on("click", () => (location.hash = `#/listing/${id}`));
    pinIndex[id] = m;
    return m;
  });
  clusterLayer.addLayers(markers);
  if (markers.length && (p.city || p.q)) searchMap.fitBounds(clusterLayer.getBounds(), { padding: [30, 30], maxZoom: 14 });

  view.querySelectorAll(".listing").forEach((el) => {
    const id = +el.dataset.id;
    el.onclick = () => (location.hash = `#/listing/${id}`);
    el.onmouseenter = () => { const m = pinIndex[id]; if (m) { const vis = clusterLayer.getVisibleParent(m); if (vis === m) m.getElement()?.firstChild?.classList.add("active"); } };
    el.onmouseleave = () => pinIndex[id]?.getElement()?.firstChild?.classList.remove("active");
  });
  sessionStorage.setItem("lastSearch", location.hash);
}

// ------------------------------------------------------------------ LISTING DRAWER
const drawer = $("#drawer");
drawer.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDrawer(true); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawer.classList.contains("open")) closeDrawer(true); });

function closeDrawer(navigate) {
  if (!drawer.classList.contains("open")) return;
  drawer.classList.remove("open");
  if (navigate) history.back();
}

function rangeBar(low, mid, high, ask) {
  const lo = Math.min(low, ask ?? low) * 0.97, hi = Math.max(high, ask ?? high) * 1.03;
  const pos = (v) => ((v - lo) / (hi - lo)) * 100;
  return `<div class="range" style="background:linear-gradient(90deg,#eef2f7 ${pos(low)}%,#cfe0ff ${pos(low)}%,var(--brand) ${pos(mid)}%,#cfe0ff ${pos(high)}%,#eef2f7 ${pos(high)}%)">
      <div class="mark" style="left:${pos(mid)}%"><span>AI: ${inr(mid)}</span></div>
      ${ask ? `<div class="mark ask" style="left:${pos(ask)}%;top:-2px;height:14px"></div>` : ""}
    </div>
    <div class="range-labels"><span>Low ${inr(low)}</span>${ask ? `<span style="color:var(--warn);font-weight:700">● Asking ${inr(ask)}</span>` : ""}<span>High ${inr(high)}</span></div>`;
}

function factorBars(factors) {
  const max = Math.max(20, ...factors.map((f) => Math.abs(f.effect_pct)));
  return `<div class="factors">${factors.map((f) => {
    const w = (Math.min(Math.abs(f.effect_pct), max) / max) * 50;
    const up = f.effect_pct >= 0;
    return `<div class="factor"><span>${f.factor}</span><div class="bar"><i class="${up ? "up" : "down"}" style="width:${w}%"></i></div><span class="v" style="color:${up ? "var(--good)" : "var(--bad)"}">${up ? "+" : ""}${f.effect_pct.toFixed(0)}%</span></div>`;
  }).join("")}</div>`;
}

function compCards(comps) {
  return `<div class="comps">${comps.map((c) => `<div class="comp" data-id="${c.id}"><b>${inr(c.price)}</b>${c.bhk} ${c.unit_type} · ${num(c.sqft)} sqft<br><span class="muted">${esc(c.locality)} · ${c.km} km away</span><div style="margin-top:6px">${dealPill(c.deal_pct)}</div></div>`).join("")}</div>`;
}

async function openListing(id) {
  const body = $("#drawer-body");
  body.innerHTML = loading("Loading home…");
  drawer.classList.add("open");
  let d;
  try { d = await api(`/api/listings/${id}`); } catch (e) { body.innerHTML = `<div class="loading">${esc(e.message)}</div>`; return; }
  const l = d.listing;
  const diff = l.deal_pct;
  const verdict = diff <= SUSPICIOUS
    ? `<div class="verdict bad">⚠ This price is ${Math.abs(diff).toFixed(0)}% below what the AI expects. That's far outside normal, so it's more likely a listing error (wrong area or price) than a real bargain. Verify before trusting it.</div>`
    : diff <= -10
    ? `<div class="verdict good">🔥 Asking price is ${Math.abs(diff).toFixed(0)}% below the AI fair price. This could be a good deal (or it may have issues the data can't see).</div>`
    : diff >= 15 ? `<div class="verdict bad">Asking price is ${diff.toFixed(0)}% above what similar homes nearby suggest. Room to negotiate.</div>`
    : `<div class="verdict neutral">Asking price is within the normal range for this area (${diff > 0 ? "+" : ""}${diff.toFixed(0)}% vs fair price).</div>`;
  const low = d.fair_low, high = d.fair_high;

  body.innerHTML = `
    ${galleryHTML(l)}
    <div class="detail">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${dealPill(diff)}${l.rera ? '<span class="pill brand">RERA approved</span>' : ""}<span class="pill neutral">${l.status}</span></div>
      <div class="price">${inr(l.price)}</div>
      <div class="facts"><span><b>${l.bhk}</b> ${l.unit_type}</span><span><b>${num(l.sqft)}</b> sq ft</span><span><b>${inr(l.ppsf)}</b>/sqft</span></div>
      <div class="muted">${esc(l.address)}</div>

      ${contactCardHTML(l)}

      <h3>GharEstimate™</h3>
      <div class="estimate-box">
        <div class="label">AI fair price</div>
        <div class="value">${inr(l.fair_price)}</div>
        <div class="muted" style="font-size:14px">Estimated by a model that never saw this listing's price</div>
        ${rangeBar(low, l.fair_price, high, l.price)}
        ${verdict}
      </div>

      <h3>Monthly cost if you take a home loan</h3>
      ${emiWidgetHTML(l)}

      <h3>Why the AI values it this way</h3>
      ${factorBars(d.explanation)}
      <p class="explain-note">Compared with a typical home in the dataset, each bar shows how much that group of features pushed this home's value up or down. These are SHAP values from the LightGBM model.</p>

      <h3>Home details</h3>
      <div class="kv">
        <div><span>Listed by</span><b>${l.posted_by}</b></div>
        <div><span>Status</span><b>${l.status}</b></div>
        <div><span>Sale type</span><b>${l.resale ? "Resale" : "New booking"}</b></div>
        <div><span>RERA</span><b>${l.rera ? "Approved" : "Not listed"}</b></div>
        <div><span>Locality</span><b>${esc(l.locality)}</b></div>
        <div><span>City</span><b>${esc(l.city)}</b></div>
      </div>

      <h3>Location</h3>
      <div class="mini-map" id="mini"></div>

      <h3>Comparable homes nearby</h3>
      ${d.comparables.length ? compCards(d.comparables) : '<p class="muted">No similar homes within 15 km.</p>'}
    </div>`;
  wireGallery(body);
  wireContactCard(body, l);
  wireEmiWidget(body, l);
  const mm = L.map("mini", { scrollWheelZoom: false }).setView([l.lat, l.lon], 14);
  tiles(mm);
  L.marker([l.lat, l.lon], { icon: L.divIcon({ className: "", html: `<span class="price-pin active">${pinLabel(l.price)}</span>`, iconSize: [0, 0] }) }).addTo(mm);
  d.comparables.forEach((c) => L.circleMarker([c.lat, c.lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#155eef", fillOpacity: 1 }).bindTooltip(`${inr(c.price)} · ${c.bhk} BHK`).addTo(mm));
  setTimeout(() => mm.invalidateSize(), 300);
  body.querySelectorAll(".comp").forEach((el) => el.onclick = () => (location.hash = `#/listing/${el.dataset.id}`));
  $(".drawer-panel").scrollTop = 0;
}

// ------------------------------------------------------------------ ESTIMATE
async function renderEstimate(params) {
  const st = {
    lat: params.get("lat") ? +params.get("lat") : null, lon: params.get("lon") ? +params.get("lon") : null,
    city: params.get("city") || "", label: params.get("loc") || "",
    bhk: 2, sqft: 1100, posted_by: "Owner", under_construction: false, rera: false, resale: true,
  };
  view.innerHTML = `
  <div class="container estimate-page">
    <div class="card form">
      <h2 style="font-size:22px">Price my home</h2>
      <p class="muted" style="margin:6px 0 0;font-size:14px">An instant AI estimate from 23,000+ real listings</p>
      <label>Location</label>
      <div class="searchbox" style="width:100%"><input id="eloc" placeholder="Search locality, e.g. Kothrud, Pune" value="${esc(st.label)}" autocomplete="off"/><div class="suggest" id="esug" hidden></div></div>
      <div class="pick-map" id="pickmap"></div>
      <div class="hint">Search above, or click the map to drop a pin exactly where the home is.</div>
      <label>Bedrooms</label>
      <div class="seg" id="ebhk">${[1, 2, 3, 4, 5].map((b) => `<button data-v="${b}" class="${b === st.bhk ? "on" : ""}">${b}${b === 5 ? "+" : ""} BHK</button>`).join("")}</div>
      <div class="row2">
        <div><label>Built-up area (sq ft)</label><input id="esqft" type="number" min="250" max="10000" step="10" value="${st.sqft}"/></div>
        <div><label>Selling as</label><select id="eby"><option>Owner</option><option>Dealer</option><option>Builder</option></select></div>
      </div>
      <div class="checks">
        <label><input type="checkbox" id="euc"/> Under construction</label>
        <label><input type="checkbox" id="erera"/> RERA approved</label>
        <label><input type="checkbox" id="eresale" checked/> Resale</label>
      </div>
      <button class="btn" id="ego" style="width:100%;margin-top:20px">Get AI estimate</button>
      <div class="hint" id="eerr" style="color:var(--bad)"></div>
    </div>
    <div id="eresult"><div class="card empty-state"><div class="big-ico">🏡</div><h3>Your estimate will appear here</h3><p class="muted">Pick a location and enter your home's size.<br>You'll get a price, a likely range, the reasons behind it, and comparable homes nearby.</p></div></div>
  </div>`;

  const pm = L.map("pickmap").setView(st.lat ? [st.lat, st.lon] : [22.5, 79], st.lat ? 13 : 4);
  tiles(pm);
  let pin = null;
  const setPin = (lat, lon) => { pin ? pin.setLatLng([lat, lon]) : (pin = L.marker([lat, lon]).addTo(pm)); st.lat = lat; st.lon = lon; };
  if (st.lat) setPin(st.lat, st.lon);
  pm.on("click", async (e) => {
    setPin(e.latlng.lat, e.latlng.lng);
    // nearest known city for the model's "city" feature
    const r = await api(`/api/overview`).catch(() => null);
    if (r) {
      let best = null, bd = 1e9;
      r.cities.forEach((c) => { const dd = (c.lat - e.latlng.lat) ** 2 + (c.lon - e.latlng.lng) ** 2; if (dd < bd) { bd = dd; best = c.city; } });
      st.city = best || "Other";
      $("#eloc").value = `Dropped pin near ${st.city}`;
    }
  });
  attachSuggest($("#eloc"), $("#esug"), (it) => {
    if (it.type === "city") {
      const c = overviewCache?.cities.find((x) => x.city === it.city);
      if (c) { setPin(c.lat, c.lon); pm.setView([c.lat, c.lon], 11); }
      st.city = it.city;
    } else if (it.type === "locality") { setPin(it.lat, it.lon); pm.setView([it.lat, it.lon], 14); st.city = it.city; }
  });
  overviewCache ||= await api("/api/overview");
  view.querySelectorAll("#ebhk button").forEach((b) => b.onclick = () => {
    st.bhk = +b.dataset.v; view.querySelectorAll("#ebhk button").forEach((x) => x.classList.toggle("on", x === b));
    $("#esqft").value = [0, 600, 1050, 1500, 2100, 2800][st.bhk];
  });

  $("#ego").onclick = async () => {
    $("#eerr").textContent = "";
    if (st.lat == null) { $("#eerr").textContent = "Please choose a location first."; return; }
    const payload = {
      lat: st.lat, lon: st.lon, city: st.city || "Other", bhk: st.bhk, sqft: +$("#esqft").value,
      posted_by: $("#eby").value, under_construction: $("#euc").checked, rera: $("#erera").checked, resale: $("#eresale").checked,
    };
    $("#eresult").innerHTML = `<div class="card">${loading("Asking the model…")}</div>`;
    try {
      const r = await api("/api/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      renderEstimateResult(r, payload);
    } catch (e) { $("#eresult").innerHTML = `<div class="card empty-state">Couldn't estimate: ${esc(e.message)}</div>`; }
  };
  if (st.lat && params.get("go")) $("#ego").click();
}

function renderEstimateResult(r, p) {
  const conf = { High: "good", Medium: "brand", Low: "bad" }[r.confidence];
  $("#eresult").innerHTML = `
    <div class="card result">
      <div class="result-top">
        <div class="estimate-box">
          <div class="label">GharEstimate™ · ${p.bhk} BHK · ${num(p.sqft)} sq ft</div>
          <div class="value">${inr(r.price)}</div>
          <div class="muted">${inr(r.ppsf)} per sq ft</div>
          ${rangeBar(r.low, r.price, r.high)}
          <p class="explain-note">There's roughly an <b>80% chance</b> the true market price falls in this range, based on how often our ranges were right on homes the model never saw.</p>
        </div>
        <div class="mini-stats">
          <div><span>Confidence</span><b><span class="pill ${conf}" style="font-size:14px">${r.confidence}</span></b><div class="hint">${r.listings_within_5km} listings within 5 km</div></div>
          <div><span>Neighbourhood median</span><b>${inr(r.neighbourhood_ppsf)}/sqft</b></div>
          <div><span>Your estimate vs neighbourhood</span><b>${r.ppsf >= r.neighbourhood_ppsf ? "+" : ""}${((r.ppsf / r.neighbourhood_ppsf - 1) * 100).toFixed(0)}% ₹/sqft</b></div>
        </div>
      </div>
      <h3 style="margin:28px 0 12px;font-size:18px">What's driving this price</h3>
      ${factorBars(r.factors)}
      <p class="explain-note">Starting from a typical Indian home in our data (${inr(r.typical_home_price)}), each bar shows how much a group of features moved <i>your</i> estimate up or down. The model computes these with SHAP (SHapley Additive exPlanations).</p>
      <h3 style="margin:28px 0 12px;font-size:18px">Comparable homes nearby</h3>
      ${r.comparables.length ? compCards(r.comparables) : '<p class="muted">No similar listings within 15 km, so treat this estimate with caution.</p>'}
    </div>`;
  $("#eresult").querySelectorAll(".comp").forEach((el) => el.onclick = () => (location.hash = `#/listing/${el.dataset.id}`));
}

// ------------------------------------------------------------------ INSIGHTS
async function renderInsights(params) {
  overviewCache ||= await api("/api/overview");
  const city = params.get("city") || overviewCache.cities[0].city;
  view.innerHTML = `<div class="container page">
    <div class="insights-head"><div><h2 class="section-title">Market insights</h2><p class="section-sub" style="margin:0">What real listings say about prices</p></div>
      <select id="icity" class="chip" style="height:46px;min-width:220px">${overviewCache.cities.map((c) => `<option ${c.city === city ? "selected" : ""}>${esc(c.city)}</option>`).join("")}</select></div>
    <div id="ibody">${loading()}</div></div>`;
  $("#icity").onchange = (e) => (location.hash = `#/insights?city=${encodeURIComponent(e.target.value)}`);
  const d = await api(`/api/insights/${encodeURIComponent(city)}`);
  const cp = cityPhoto(d.city);
  const bars = (rows, key, fmt, alt) => {
    const max = Math.max(...rows.map((r) => r[key]));
    return rows.map((r) => `<div class="hbar"><span class="name" title="${esc(r.locality ?? "")}">${esc(r.locality ?? (r.b >= 5 ? "5+ BHK" : r.b + " BHK"))}</span><div class="track"><i class="${alt ? "alt" : ""}" style="width:${(r[key] / max) * 100}%"></i></div><span class="v">${fmt(r[key])}</span></div>`).join("");
  };
  const cmp = overviewCache.cities.slice(0, 12).sort((a, b) => b.median_ppsf - a.median_ppsf).map((c) => ({ locality: c.city, ppsf: c.median_ppsf }));
  $("#ibody").innerHTML = `
    ${cp ? `<div class="city-banner"><img src="${cp.src}" alt="${esc(d.city)}"/><div class="city-banner-text"><h3>${esc(d.city)}</h3><span>${num(d.listings)} listings · median ${inr(d.median_ppsf)}/sq ft</span></div><div class="city-banner-credit">${creditLine(cp)}</div></div>` : ""}
    <div class="kpis">
      <div class="card kpi"><span>Listings</span><b>${num(d.listings)}</b></div>
      <div class="card kpi"><span>Median price</span><b>${inr(d.median_price)}</b></div>
      <div class="card kpi"><span>Median ₹/sq ft</span><b>${inr(d.median_ppsf)}</b></div>
      <div class="card kpi"><span>RERA approved</span><b>${d.rera_share}%</b></div>
    </div>
    <div class="two-col">
      <div class="card panel"><h3>💎 Priciest localities (₹/sq ft)</h3>${d.priciest_localities.length ? bars(d.priciest_localities, "ppsf", inr) : '<p class="muted">Not enough data per locality.</p>'}</div>
      <div class="card panel"><h3>💚 Most affordable localities (₹/sq ft)</h3>${d.affordable_localities.length ? bars(d.affordable_localities, "ppsf", inr, true) : '<p class="muted">Not enough data per locality.</p>'}</div>
      <div class="card panel"><h3>Median price by bedrooms</h3>${bars(d.by_bhk, "price", inr)}</div>
      <div class="card panel"><h3>₹/sq ft across major cities</h3>${bars(cmp, "ppsf", inr)}</div>
    </div>
    <div style="margin-top:20px;display:flex;gap:12px;flex-wrap:wrap"><a class="btn" href="#/search?city=${encodeURIComponent(d.city)}">Browse ${esc(d.city)} homes</a><a class="btn ghost" href="#/search?city=${encodeURIComponent(d.city)}&deals_only=1">See deals in ${esc(d.city)}</a></div>`;
}

// ------------------------------------------------------------------ HOW IT WORKS
async function renderHow() {
  overviewCache ||= await api("/api/overview");
  const m = overviewCache.model;
  const rows = Object.entries(m.metrics);
  const imp = Object.entries(m.feature_importance_pct).slice(0, 10);
  const nice = { nbr_log_ppsf: "Nearby homes' ₹/sqft", log_sqft: "Built-up area", sqft_per_bhk: "Area per bedroom", nbr_spread: "Price variety nearby", city: "City", lon: "Longitude", lat: "Latitude", nbr_dist_km: "Distance to neighbours", bhk: "Bedrooms", posted_by: "Owner / dealer / builder", rera: "RERA approval", under_construction: "Under construction", resale: "Resale", ready_to_move: "Ready to move", is_rk: "RK unit" };
  view.innerHTML = `<div class="container page" style="max-width:960px">
    <h2 class="section-title">How the AI works</h2>
    <p class="section-sub">GharAI's estimate is a supervised machine-learning model. It learned the relationship between a home's features and its price from ${num(m.n_listings)} real listings.</p>
    <div class="steps">
      <div class="card step"><h3>Collect real data</h3><p>29,451 Indian property listings with price, size, BHK, seller type, RERA status, construction status and GPS coordinates. <b>Supervised learning</b> means every example comes with the right answer (the price) for the model to learn from.</p></div>
      <div class="card step"><h3>Clean it (the unglamorous 80%)</h3><p>The raw file had latitude and longitude <i>swapped</i>, duplicate listings, 115 sq ft "3BHKs", and pins placed 800 km from their city. We removed ${num(29451 - m.n_listings)} bad rows. Bad data in = bad predictions out.</p></div>
      <div class="card step"><h3>Engineer features</h3><p>Models only see numbers. The most powerful feature we built mimics a property broker: <b>the median ₹/sqft of the 15 nearest homes</b> ("comps"), found with a BallTree nearest-neighbour search. We also predict <code>log(price)</code> so a 10% miss counts the same on a ₹30 L flat and a ₹3 Cr villa.</p></div>
      <div class="card step"><h3>Hold out a test set</h3><p>20% of homes are hidden during training. Scoring the model on homes it has never seen is the only honest way to measure it. Anything else is like grading a student with the exact questions they practised.</p></div>
      <div class="card step"><h3>Train and compare models</h3><p><b>Gradient boosting (LightGBM)</b> builds 2,000 small decision trees, each one correcting the mistakes of the trees before it. We compared it with a simple broker-style baseline and a linear regression:</p>
        <table class="metrics-table" style="margin-top:12px"><thead><tr><th>Model</th><th>Typical error</th><th>Within 10%</th><th>Within 20%</th><th>R² (log)</th></tr></thead><tbody>
        ${rows.map(([name, r]) => `<tr class="${name.startsWith("LightGBM") ? "win" : ""}"><td>${name}</td><td>±${r.median_error_pct}%</td><td>${r.within_10pct}%</td><td>${r.within_20pct}%</td><td>${r.r2_log}</td></tr>`).join("")}
        </tbody></table></div>
      <div class="card step"><h3>Predict a range, not just a number</h3><p>Two extra <b>quantile regression</b> models predict a low and a high price. On unseen homes, the true price fell inside our range ${m.range_coverage_pct}% of the time. Being honest about uncertainty matters as much as accuracy.</p></div>
      <div class="card step"><h3>Explain every prediction</h3><p>For each estimate we compute <b>SHAP values</b>, a game-theory method that splits a prediction into how much each feature contributed. That's the "What's driving this price" chart. Overall, the features the model leans on most:</p>
        <div style="margin-top:14px">${imp.map(([k, v]) => `<div class="hbar"><span class="name">${nice[k] || k}</span><div class="track"><i style="width:${(v / imp[0][1]) * 100}%"></i></div><span class="v">${v}%</span></div>`).join("")}</div></div>
      <div class="card step"><h3>Fair price for every listing</h3><p>Each listing's GharEstimate comes from <b>5-fold cross-validation</b>: the data is split into 5 parts, and each part is priced by a model trained on the other 4. No home ever sees its own price, so "below fair price" badges are genuine.</p></div>
    </div>
    <p class="explain-note" style="margin-top:24px">Limitations: the data is a snapshot of asking prices (not sale prices) and lacks floor, age, amenities and photos, so some variation is unexplainable from the data we have. Treat estimates as a starting point, not a valuation.</p>
  </div>`;
}
