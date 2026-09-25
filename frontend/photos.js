/* Photos: real city photos + clearly-labelled representative home photos (Wikimedia Commons).
   The dataset has no pictures of the actual homes, so we never pretend a photo IS the home. */
let PHOTOS = null;

async function loadPhotos() {
  if (PHOTOS) return PHOTOS;
  try {
    PHOTOS = await (await fetch("/static/photos/credits.json")).json();
  } catch {
    PHOTOS = { cities: {}, exterior: [], living: [], kitchen: [], bedroom: [] }; // site still works with drawings
  }
  return PHOTOS;
}

const pickPhoto = (list, n) => (list && list.length ? list[Math.abs(n) % list.length] : null);
const cityPhoto = (city) => PHOTOS?.cities?.[city] || null;

/** Stable set of photos for a listing: same home always shows the same pictures. */
function listingPhotos(l) {
  if (!PHOTOS) return [];
  const id = l.id;
  const set = [
    [pickPhoto(PHOTOS.exterior, id), "Building exterior"],
    [pickPhoto(PHOTOS.living, id * 3 + 1), "Living room"],
    [pickPhoto(PHOTOS.kitchen, id * 7 + 2), "Kitchen & dining"],
    [pickPhoto(PHOTOS.bedroom, id * 5 + 3), "Bedroom"],
    [cityPhoto(l.city), `${l.city}, the city`],
  ];
  return set.filter(([p]) => p).map(([p, label]) => ({ ...p, label }));
}

function cardImage(l) {
  const p = pickPhoto(PHOTOS?.exterior, l.id);
  if (!p) return houseArt(l.id, l.bhk, l.under_construction);
  return `<img src="${p.src}" alt="Representative apartment exterior" loading="lazy" onerror="this.outerHTML=houseArt(${l.id},${l.bhk},${l.under_construction})"/>
          <span class="rep-tag">Representative image</span>`;
}

function creditLine(p) {
  return `Photo: ${esc(p.author)} · <a href="${esc(p.source)}" target="_blank" rel="noopener">${esc(p.license)}</a>, via Wikimedia Commons`;
}

/** Gallery for the listing drawer. Returns HTML; call wireGallery(root) after inserting it. */
function galleryHTML(l) {
  const ps = listingPhotos(l);
  if (!ps.length) return `<div class="detail-hero">${houseArt(l.id, l.bhk, l.under_construction)}</div>`;
  return `<div class="gallery" data-i="0">
      <div class="g-main">
        ${ps.map((p, i) => `<img src="${p.src}" alt="${esc(p.label)} (representative)" class="${i ? "" : "on"}" loading="${i ? "lazy" : "eager"}"/>`).join("")}
        <button class="g-nav prev" aria-label="Previous photo">‹</button><button class="g-nav next" aria-label="Next photo">›</button>
        <span class="g-count">1 / ${ps.length}</span>
        <span class="g-label">${esc(ps[0].label)} · representative image</span>
      </div>
      <div class="g-thumbs">${ps.map((p, i) => `<img src="${p.src}" alt="" data-i="${i}" class="${i ? "" : "on"}" loading="lazy"/>`).join("")}</div>
      <div class="g-credit">${creditLine(ps[0])}</div>
      <script type="application/json">${JSON.stringify(ps.map((p) => ({ label: p.label, credit: creditLine(p) })))}</script>
    </div>
    <p class="rep-note">📷 This listing came without photos. These are <b>representative images</b> of similar homes and of ${esc(l.city)}, not photos of this property. Always visit before you decide.</p>`;
}

function wireGallery(root) {
  const g = root.querySelector(".gallery");
  if (!g) return;
  const meta = JSON.parse(g.querySelector("script").textContent);
  const mains = g.querySelectorAll(".g-main img"), thumbs = g.querySelectorAll(".g-thumbs img");
  const show = (i) => {
    i = (i + meta.length) % meta.length;
    g.dataset.i = i;
    mains.forEach((m, k) => m.classList.toggle("on", k === i));
    thumbs.forEach((t, k) => t.classList.toggle("on", k === i));
    g.querySelector(".g-count").textContent = `${i + 1} / ${meta.length}`;
    g.querySelector(".g-label").textContent = `${meta[i].label} · representative image`;
    g.querySelector(".g-credit").innerHTML = meta[i].credit;
  };
  g.querySelector(".prev").onclick = () => show(+g.dataset.i - 1);
  g.querySelector(".next").onclick = () => show(+g.dataset.i + 1);
  thumbs.forEach((t) => (t.onclick = () => show(+t.dataset.i)));
}

async function renderCredits() {
  await loadPhotos();
  const row = (p, label) => `<div class="credit-row"><img src="${p.src}" alt="" loading="lazy"/><div><b>${esc(label || p.title)}</b><br><span class="muted">${creditLine(p)}</span></div></div>`;
  view.innerHTML = `<div class="container page" style="max-width:960px">
    <h2 class="section-title">Photo credits</h2>
    <p class="section-sub">All photos are openly licensed from Wikimedia Commons (CC0, public domain, CC BY or CC BY-SA). Home photos are representative; the listings dataset contains no pictures of the actual properties.</p>
    <h3 class="credits-h">Cities</h3>
    <div class="credits">${Object.entries(PHOTOS.cities).map(([c, p]) => row(p, c)).join("")}</div>
    ${["exterior", "living", "kitchen", "bedroom"].map((g) => `<h3 class="credits-h">${{ exterior: "Building exteriors", living: "Living rooms", kitchen: "Kitchens", bedroom: "Bedrooms" }[g]}</h3>
      <div class="credits">${PHOTOS[g].map((p) => row(p)).join("")}</div>`).join("")}
  </div>`;
}
