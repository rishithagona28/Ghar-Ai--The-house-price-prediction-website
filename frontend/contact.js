/* Buyer ↔ seller contact: enquiry form (buyers) + leads inbox (sellers).
   The dataset has no seller names or numbers, so we never invent any. Instead buyers leave
   THEIR details, and the lister reaches them from the leads inbox via call / WhatsApp / email. */
const modal = document.getElementById("modal");
const KIND_LABEL = { callback: "Request a call back", visit: "Schedule a site visit", question: "Ask a question" };
const KIND_SHORT = { callback: "📞 Call back", visit: "📅 Site visit", question: "💬 Question" };
const SELLER_ICON = { Owner: "🏠", Dealer: "🤝", Builder: "🏗️" };

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
};

function contactCardHTML(l) {
  const who = { Owner: "the owner", Dealer: "a dealer / agent", Builder: "the builder" }[l.posted_by] || "the lister";
  return `<div class="contact-card card">
    <div class="seller">
      <div class="seller-ico">${SELLER_ICON[l.posted_by] || "🏠"}</div>
      <div><b>Listed by ${esc(l.posted_by)}</b><div class="muted" style="font-size:13px">Your enquiry goes straight to ${who}${l.rera ? " · RERA registered" : ""}</div></div>
    </div>
    <div class="contact-actions">
      <button class="btn" data-enquire="callback">📞 Request a call back</button>
      <button class="btn ghost" data-enquire="visit">📅 Schedule a visit</button>
      <button class="btn ghost" data-enquire="question">💬 Ask a question</button>
    </div>
    <div class="muted privacy">🔒 Your phone number is shared only with this lister. No spam, no calls from other agents.</div>
  </div>`;
}

function wireContactCard(root, l) {
  root.querySelectorAll("[data-enquire]").forEach((b) => (b.onclick = () => openEnquiryForm(l, b.dataset.enquire)));
}

function openModal(html) {
  modal.querySelector(".modal-body").innerHTML = html;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  setTimeout(() => modal.querySelector("input, textarea, button")?.focus(), 50);
}
function closeModal() {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}
modal.addEventListener("click", (e) => { if (e.target.closest("[data-mclose]")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal.classList.contains("open")) { e.stopImmediatePropagation(); closeModal(); } }, true);

function openEnquiryForm(l, kind = "callback") {
  const me = store.get("gharai-buyer") || {};
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const defaultMsg = `Hi, I'm interested in the ${l.bhk} ${l.unit_type} (${num(l.sqft)} sq ft) in ${l.locality}, ${l.city} listed at ${inr(l.price)}. Please get in touch.`;
  openModal(`
    <h3 class="modal-title">Contact the ${esc(l.posted_by.toLowerCase())}</h3>
    <div class="modal-listing">${cardImage(l)}<div><b>${inr(l.price)}</b> · ${l.bhk} ${l.unit_type} · ${num(l.sqft)} sq ft<br><span class="muted">${esc(l.locality)}, ${esc(l.city)}</span></div></div>
    <div class="seg kind-seg">${Object.entries(KIND_SHORT).map(([k, t]) => `<button type="button" data-k="${k}" class="${k === kind ? "on" : ""}">${t}</button>`).join("")}</div>
    <form id="enq" novalidate>
      <div class="row2">
        <div><label for="q-name">Your name</label><input id="q-name" required minlength="2" maxlength="60" value="${esc(me.name || "")}" autocomplete="name"/></div>
        <div><label for="q-phone">Mobile number</label><div class="suffix pre"><span>+91</span><input id="q-phone" required inputmode="numeric" maxlength="10" pattern="[6-9][0-9]{9}" value="${esc(me.phone || "")}" autocomplete="tel-national" placeholder="98765 43210"/></div></div>
      </div>
      <label for="q-email">Email <span class="muted">(optional)</span></label>
      <input id="q-email" type="email" maxlength="120" value="${esc(me.email || "")}" autocomplete="email"/>
      <label>Best way to reach you</label>
      <div class="seg" id="q-via">${["Call", "WhatsApp", "Email"].map((v) => `<button type="button" data-v="${v}" class="${v === (me.via || "Call") ? "on" : ""}">${v}</button>`).join("")}</div>
      <div id="q-visit" ${kind === "visit" ? "" : "hidden"}>
        <div class="row2">
          <div><label for="q-date">Visit date</label><input id="q-date" type="date" min="${tomorrow}" value="${tomorrow}"/></div>
          <div><label for="q-slot">Time</label><select id="q-slot"><option>Morning</option><option>Afternoon</option><option>Evening</option></select></div>
        </div>
      </div>
      <label for="q-msg">Message</label>
      <textarea id="q-msg" rows="3" maxlength="1000">${esc(defaultMsg)}</textarea>
      <label class="check"><input type="checkbox" id="q-loan"/> I'm interested in a home loan for this property</label>
      <label class="check"><input type="checkbox" id="q-consent" required/> I agree to be contacted by this lister about this property</label>
      <div class="form-err" id="q-err" role="alert"></div>
      <button class="btn" style="width:100%;margin-top:6px" id="q-send">Send enquiry</button>
    </form>`);

  let via = me.via || "Call";
  const body = modal.querySelector(".modal-body");
  body.querySelectorAll(".kind-seg button").forEach((b) => (b.onclick = () => {
    kind = b.dataset.k;
    body.querySelectorAll(".kind-seg button").forEach((x) => x.classList.toggle("on", x === b));
    body.querySelector("#q-visit").hidden = kind !== "visit";
  }));
  body.querySelectorAll("#q-via button").forEach((b) => (b.onclick = () => {
    via = b.dataset.v;
    body.querySelectorAll("#q-via button").forEach((x) => x.classList.toggle("on", x === b));
  }));

  body.querySelector("#enq").onsubmit = async (ev) => {
    ev.preventDefault();
    const err = body.querySelector("#q-err");
    const v = (id) => body.querySelector(id).value.trim();
    const phone = v("#q-phone").replace(/\D/g, "");
    const problems = [];
    if (v("#q-name").length < 2) problems.push("your name");
    if (!/^[6-9]\d{9}$/.test(phone)) problems.push("a valid 10-digit mobile number");
    if (via === "Email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v("#q-email"))) problems.push("an email address (you chose email)");
    if (!body.querySelector("#q-consent").checked) problems.push("your consent to be contacted");
    if (problems.length) { err.textContent = "Please add " + problems.join(", ") + "."; return; }
    err.textContent = "";
    const btn = body.querySelector("#q-send");
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const r = await api("/api/enquiries", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listing_id: l.id, kind, name: v("#q-name"), phone, email: v("#q-email") || null, contact_via: via,
          message: v("#q-msg") || null, needs_loan: body.querySelector("#q-loan").checked,
          visit_date: kind === "visit" ? v("#q-date") : null, visit_slot: kind === "visit" ? v("#q-slot") : null,
        }),
      });
      store.set("gharai-buyer", { name: v("#q-name"), phone, email: v("#q-email"), via });
      const ref = "GH-" + String(r.id).padStart(6, "0");
      body.innerHTML = `<div class="sent">
        <div class="sent-ico">✓</div>
        <h3 class="modal-title">${r.duplicate ? "You've already contacted this lister" : "Enquiry sent!"}</h3>
        <p>${kind === "visit" ? `Visit requested for <b>${new Date((v("#q-date") || r.visit_date) + "T00:00").toDateString()}</b> (${esc(r.visit_slot || "")}). ` : ""}The ${esc(l.posted_by.toLowerCase())} will reach you by <b>${esc(r.contact_via)}</b> on +91 ${esc(r.phone)}.</p>
        <p class="muted">Reference <b>${ref}</b></p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px">
          <button class="btn ghost" data-mclose>Done</button>
          <a class="btn" href="#/emi?price=${l.price}&city=${encodeURIComponent(l.city)}&uc=${l.under_construction}&by=${l.posted_by}" data-mclose>Plan my EMI →</a>
        </div></div>`;
    } catch (e) {
      err.textContent = "Couldn't send: " + e.message;
      btn.disabled = false; btn.textContent = "Send enquiry";
    }
  };
}

// ------------------------------------------------------------------ seller side: leads inbox
function timeAgo(s) {
  const d = (Date.now() - new Date(s.replace(" ", "T")).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

function leadCard(e) {
  const l = e.listing || {};
  const intro = `Hi ${e.name.split(" ")[0]}, this is regarding your enquiry (GH-${String(e.id).padStart(6, "0")}) on GharAI for the ${l.bhk || ""} BHK in ${l.locality || ""}, ${l.city || ""}.`;
  const wa = `https://wa.me/91${e.phone}?text=${encodeURIComponent(intro)}`;
  const mail = e.email ? `mailto:${e.email}?subject=${encodeURIComponent(`Your enquiry: ${l.bhk} BHK in ${l.locality}`)}&body=${encodeURIComponent(intro)}` : null;
  return `<article class="lead card" data-id="${e.id}">
    <div class="lead-top">
      <div>
        <div class="lead-name">${esc(e.name)} <span class="pill ${e.status === "New" ? "brand" : e.status === "Closed" ? "neutral" : "good"}">${e.status}</span></div>
        <div class="muted" style="font-size:13px">${KIND_LABEL[e.kind]} · prefers <b>${esc(e.contact_via)}</b> · ${timeAgo(e.created_at)}</div>
      </div>
      <select class="lead-status chip" aria-label="Status">${["New", "Contacted", "Visit scheduled", "Closed"].map((s) => `<option ${s === e.status ? "selected" : ""}>${s}</option>`).join("")}</select>
    </div>
    ${l.id != null ? `<a class="lead-listing" href="#/listing/${l.id}">🏠 ${inr(l.price)} · ${l.bhk} BHK · ${num(l.sqft)} sq ft · ${esc(l.locality)}, ${esc(l.city)} <span class="muted">(${esc(l.posted_by)})</span></a>` : ""}
    <div class="lead-facts">
      <span>📱 +91 ${esc(e.phone)}</span>${e.email ? `<span>✉️ ${esc(e.email)}</span>` : ""}
      ${e.visit_date ? `<span>📅 Visit ${new Date(e.visit_date + "T00:00").toDateString()} · ${esc(e.visit_slot || "")}</span>` : ""}
      ${e.needs_loan ? `<span class="pill warn">Needs home loan</span>` : ""}
    </div>
    ${e.message ? `<blockquote>${esc(e.message)}</blockquote>` : ""}
    <div class="lead-actions">
      <a class="btn" href="tel:+91${e.phone}">📞 Call</a>
      <a class="btn ghost" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>
      ${mail ? `<a class="btn ghost" href="${mail}">Email</a>` : ""}
    </div>
    <div class="lead-note"><input placeholder="Private note, e.g. 'Called, visiting Saturday'" value="${esc(e.seller_note || "")}" maxlength="500"/><button class="btn ghost save-note">Save</button></div>
  </article>`;
}

async function renderLeads(params) {
  const status = params.get("status") || "";
  view.innerHTML = `<div class="container page" style="max-width:980px">
    <div class="insights-head"><div><h2 class="section-title">Leads inbox</h2><p class="section-sub" style="margin:0">Buyers who enquired about listings. Reach them in one tap.</p></div></div>
    <div class="demo-note">🧪 <b>Demo inbox.</b> In a real product each owner, dealer or builder would log in and see only the leads for <i>their</i> listings. Here, everyone who opens this page sees every enquiry.</div>
    <div id="lbody">${loading()}</div></div>`;
  const d = await api("/api/enquiries" + (status ? `?status=${encodeURIComponent(status)}` : ""));
  const all = Object.values(d.counts).reduce((a, b) => a + b, 0);
  $("#lbody").innerHTML = `
    <div class="tabs">${[["", "All", all], ...Object.entries(d.counts).map(([k, v]) => [k, k, v])].map(([k, t, n]) =>
      `<a href="#/leads${k ? "?status=" + encodeURIComponent(k) : ""}" class="${k === status ? "on" : ""}">${t} <span>${n}</span></a>`).join("")}</div>
    ${d.items.length ? `<div class="leads">${d.items.map(leadCard).join("")}</div>` :
      `<div class="card empty-state"><div class="big-ico">📭</div><h3>No enquiries ${status ? `marked "${esc(status)}"` : "yet"}</h3><p class="muted">Open any listing and use <b>Request a call back</b> to see how leads arrive here.</p><a class="btn" href="#/search">Browse homes</a></div>`}`;

  view.querySelectorAll(".lead").forEach((card) => {
    const id = card.dataset.id;
    const patch = (body) => api(`/api/enquiries/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    card.querySelector(".lead-status").onchange = async (e) => { await patch({ status: e.target.value }); router(); };
    card.querySelector(".save-note").onclick = async (e) => {
      await patch({ seller_note: card.querySelector(".lead-note input").value });
      e.target.textContent = "Saved ✓"; setTimeout(() => (e.target.textContent = "Save"), 1500);
    };
  });
}
