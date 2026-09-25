/* EMI & total cost of buying calculator.
   Rates below are APPROXIMATE defaults (they vary by state, buyer gender, property value and
   change over time). Every one is editable in the UI, so buyers can plug in current numbers. */

// Typical stamp duty % by state (general rate for a male buyer; many states discount women buyers)
const STATE_OF_CITY = {
  Mumbai: "Maharashtra", Pune: "Maharashtra", Nagpur: "Maharashtra", Maharashtra: "Maharashtra", Thane: "Maharashtra", "Navi Mumbai": "Maharashtra",
  Bangalore: "Karnataka", Mysore: "Karnataka", Chennai: "Tamil Nadu", Coimbatore: "Tamil Nadu",
  Noida: "Uttar Pradesh", Ghaziabad: "Uttar Pradesh", "Greater Noida": "Uttar Pradesh", Lucknow: "Uttar Pradesh",
  Gurgaon: "Haryana", Faridabad: "Haryana", Kolkata: "West Bengal", Jaipur: "Rajasthan", Bhiwadi: "Rajasthan",
  Chandigarh: "Chandigarh", Mohali: "Punjab", Vadodara: "Gujarat", Surat: "Gujarat", Ahmedabad: "Gujarat",
  Hyderabad: "Telangana", Bhubaneswar: "Odisha", Indore: "Madhya Pradesh", Bhopal: "Madhya Pradesh",
  Kochi: "Kerala", Visakhapatnam: "Andhra Pradesh", "New Delhi": "Delhi", Delhi: "Delhi",
};
const STAMP_DUTY = {
  Maharashtra: 6, Karnataka: 5, "Tamil Nadu": 7, "Uttar Pradesh": 7, Haryana: 7, "West Bengal": 6, Rajasthan: 6,
  Chandigarh: 6, Punjab: 7, Gujarat: 4.9, Telangana: 5.5, Odisha: 5, "Madhya Pradesh": 7.5, Kerala: 8,
  "Andhra Pradesh": 5, Delhi: 6,
};

/** RBI loan-to-value caps: banks can lend at most 90% / 80% / 75% of the price. */
function minDownPct(price) {
  return price <= 30e5 ? 10 : price <= 75e5 ? 20 : 25;
}

/** EMI = P·r·(1+r)^n / ((1+r)^n − 1), r = monthly rate, n = months. */
function emiOf(principal, annualRate, years) {
  const r = annualRate / 12 / 100, n = years * 12;
  if (principal <= 0) return 0;
  if (r === 0) return principal / n;
  const f = Math.pow(1 + r, n);
  return (principal * r * f) / (f - 1);
}

function costBreakdown(o) {
  const down = (o.price * o.downPct) / 100;
  const loan = o.price - down;
  const emi = emiOf(loan, o.rate, o.years);
  const totalPaid = emi * o.years * 12;
  const interest = Math.max(0, totalPaid - loan);
  const upfront = {
    "Down payment": down,
    "Stamp duty": (o.price * o.stampPct) / 100,
    "Registration": Math.min((o.price * o.regPct) / 100, o.regCap || Infinity),
    "GST (under-construction only)": (o.price * o.gstPct) / 100,
    "Loan processing fee": (loan * o.feePct) / 100,
    "Brokerage": (o.price * o.brokeragePct) / 100,
    "Legal & documentation": o.legal,
  };
  const upfrontTotal = Object.values(upfront).reduce((a, b) => a + b, 0);
  const schedule = [];
  let bal = loan;
  const r = o.rate / 12 / 100;
  for (let y = 1; y <= o.years; y++) {
    let pi = 0, ii = 0;
    for (let m = 0; m < 12; m++) {
      const int = bal * r, prin = Math.min(emi - int, bal);
      ii += int; pi += prin; bal -= prin;
    }
    schedule.push({ year: y, principal: pi, interest: ii, balance: Math.max(0, bal) });
  }
  return {
    down, loan, emi, interest, totalPaid, upfront, upfrontTotal,
    incomeNeeded: emi / 0.4, // banks like EMIs ≤ ~40% of take-home pay
    schedule,
  };
}

function defaultCostInputs({ price, city, uc, posted_by }) {
  const state = STATE_OF_CITY[city];
  const stamp = STAMP_DUTY[state] ?? 6;
  return {
    price, downPct: Math.max(20, minDownPct(price)), rate: 8.5, years: 20,
    stampPct: stamp, regPct: 1, regCap: state === "Maharashtra" ? 30000 : null,
    gstPct: uc ? (price <= 45e5 ? 1 : 5) : 0, feePct: 0.5,
    brokeragePct: posted_by === "Dealer" ? 1 : 0, legal: 15000, state: state || "your state",
  };
}

function donut(parts) {
  const total = parts.reduce((a, p) => a + p.v, 0) || 1;
  let acc = 0;
  const R = 54, C = 2 * Math.PI * R;
  return `<svg viewBox="0 0 140 140" class="donut" role="img" aria-label="Cost split">
    ${parts.map((p) => { const len = (p.v / total) * C; const s = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${p.c}" stroke-width="20" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-acc}" transform="rotate(-90 70 70)"/>`; acc += len; return s; }).join("")}
  </svg>`;
}

/** Compact calculator for the listing drawer. */
function emiWidgetHTML(l) {
  return `<div class="emi-mini card" id="emimini">
    <div class="emi-mini-top">
      <div><span class="muted">Estimated EMI</span><div class="emi-big" id="em-emi">—</div><span class="muted" id="em-sub"></span></div>
      <div style="text-align:right"><span class="muted">Cash needed upfront</span><div class="emi-mid" id="em-up">—</div><span class="muted">down payment + taxes & fees</span></div>
    </div>
    <div class="sliders">
      <label>Down payment <b id="em-dp-v"></b><input type="range" id="em-dp" min="${minDownPct(l.price)}" max="90" step="5"/></label>
      <label>Interest rate <b id="em-rate-v"></b><input type="range" id="em-rate" min="6.5" max="13" step="0.05"/></label>
      <label>Loan tenure <b id="em-yrs-v"></b><input type="range" id="em-yrs" min="5" max="30" step="1"/></label>
    </div>
    <a class="btn ghost" style="width:100%" href="#/emi?price=${l.price}&city=${encodeURIComponent(l.city)}&uc=${l.under_construction}&by=${l.posted_by}">See full cost breakdown →</a>
  </div>`;
}

function wireEmiWidget(root, l) {
  const o = defaultCostInputs({ price: l.price, city: l.city, uc: l.under_construction, posted_by: l.posted_by });
  const dp = root.querySelector("#em-dp"), rt = root.querySelector("#em-rate"), yr = root.querySelector("#em-yrs");
  if (!dp) return;
  dp.value = o.downPct; rt.value = o.rate; yr.value = o.years;
  const upd = () => {
    Object.assign(o, { downPct: +dp.value, rate: +rt.value, years: +yr.value });
    const c = costBreakdown(o);
    root.querySelector("#em-emi").textContent = `${inr(c.emi)}/month`;
    root.querySelector("#em-sub").textContent = `on a ${inr(c.loan)} loan`;
    root.querySelector("#em-up").textContent = inr(c.upfrontTotal);
    root.querySelector("#em-dp-v").textContent = `${o.downPct}% · ${inr(c.down)}`;
    root.querySelector("#em-rate-v").textContent = `${o.rate.toFixed(2)}%`;
    root.querySelector("#em-yrs-v").textContent = `${o.years} yrs`;
  };
  [dp, rt, yr].forEach((el) => el.addEventListener("input", upd));
  upd();
}

/** Full calculator page: #/emi?price=&city=&uc=&by= */
function renderEmi(params) {
  const price = +params.get("price") || 75e5;
  const city = params.get("city") || "Bangalore";
  const o = defaultCostInputs({ price, city, uc: params.get("uc") === "1", posted_by: params.get("by") });
  const cities = Object.keys(STATE_OF_CITY).sort();
  const field = (id, label, val, attrs, suffix, hint = "") => `<div><label for="${id}">${label}</label>
      <div class="suffix"><input id="${id}" type="number" value="${val}" ${attrs}/><span>${suffix}</span></div>${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;

  view.innerHTML = `<div class="container page">
    <h2 class="section-title">EMI & cost of buying calculator</h2>
    <p class="section-sub">The sticker price is only part of the story. See your monthly EMI, the cash you need on day one, and what the home really costs over the whole loan.</p>
    <div class="emi-page">
      <div class="card form" style="position:static">
        <label for="c-price">Property price</label>
        <div class="suffix"><input id="c-price" type="number" min="100000" step="50000" value="${price}"/><span id="c-price-w">${inr(price)}</span></div>
        <label for="c-city">City (for stamp duty)</label>
        <select id="c-city">${cities.map((c) => `<option ${c === city ? "selected" : ""}>${c}</option>`).join("")}${cities.includes(city) ? "" : `<option selected>${esc(city)}</option>`}</select>
        <h4 class="form-h">Home loan</h4>
        <div class="row2">
          ${field("c-dp", "Down payment", o.downPct, `min="${minDownPct(price)}" max="100" step="1"`, "%", "")}
          ${field("c-rate", "Interest rate", o.rate, 'min="1" max="20" step="0.05"', "% p.a.")}
        </div>
        <div class="hint" id="c-ltv"></div>
        <label for="c-yrs">Tenure: <b id="c-yrs-v">${o.years} years</b></label>
        <input id="c-yrs" type="range" min="5" max="30" step="1" value="${o.years}" style="height:auto;border:0;padding:0"/>
        <h4 class="form-h">Taxes & fees <span class="muted" style="font-weight:500">(approx., editable)</span></h4>
        <div class="row2">
          ${field("c-stamp", "Stamp duty", o.stampPct, 'min="0" max="15" step="0.1"', "%")}
          ${field("c-reg", "Registration", o.regPct, 'min="0" max="5" step="0.1"', "%")}
          ${field("c-gst", "GST", o.gstPct, 'min="0" max="12" step="1"', "%", "0% ready-to-move · 1% / 5% under construction")}
          ${field("c-fee", "Processing fee", o.feePct, 'min="0" max="3" step="0.05"', "% of loan")}
          ${field("c-brk", "Brokerage", o.brokeragePct, 'min="0" max="3" step="0.5"', "%")}
          ${field("c-legal", "Legal & docs", o.legal, 'min="0" step="1000"', "₹")}
        </div>
        <div class="hint">Stamp duty default for <b id="c-state">${o.state}</b>. Many states charge less for women buyers; check your state's official rates before you budget.</div>
      </div>
      <div id="c-out"></div>
    </div>
  </div>`;

  const $v = (id) => +document.getElementById(id).value;
  const recalc = () => {
    const p = $v("c-price");
    const minDp = minDownPct(p);
    document.getElementById("c-dp").min = minDp;
    Object.assign(o, {
      price: p, downPct: Math.max($v("c-dp"), minDp), rate: $v("c-rate"), years: $v("c-yrs"),
      stampPct: $v("c-stamp"), regPct: $v("c-reg"), gstPct: $v("c-gst"), feePct: $v("c-fee"),
      brokeragePct: $v("c-brk"), legal: $v("c-legal"),
    });
    document.getElementById("c-price-w").textContent = inr(p);
    document.getElementById("c-yrs-v").textContent = `${o.years} years`;
    document.getElementById("c-ltv").innerHTML = $v("c-dp") < minDp
      ? `<span style="color:var(--bad)">RBI rules: for a ${inr(p)} home, banks lend at most ${100 - minDp}%, so the minimum down payment is ${minDp}%. Using ${minDp}%.</span>`
      : `RBI rule: banks lend at most ${100 - minDp}% of a home priced ${p <= 30e5 ? "up to ₹30 L" : p <= 75e5 ? "₹30–75 L" : "above ₹75 L"}.`;
    const c = costBreakdown(o);
    const colors = ["#155eef", "#f79009", "#12b76a"];
    const upNoDown = c.upfrontTotal - c.down;
    const maxYear = Math.max(...c.schedule.map((s) => s.principal + s.interest));
    document.getElementById("c-out").innerHTML = `
      <div class="card result">
        <div class="emi-headline">
          <div><span class="muted">Monthly EMI</span><div class="emi-huge">${inr(c.emi)}</div><span class="muted">${inr(c.loan)} loan · ${o.rate}% · ${o.years} yrs</span></div>
          <div><span class="muted">Cash needed upfront</span><div class="emi-huge" style="color:var(--warn)">${inr(c.upfrontTotal)}</div><span class="muted">down payment + ${inr(upNoDown)} taxes & fees</span></div>
          <div><span class="muted">Suggested take-home income</span><div class="emi-huge" style="color:var(--good)">${inr(c.incomeNeeded)}<small>/mo</small></div><span class="muted">so EMI stays ≤ 40% of income</span></div>
        </div>
        <div class="emi-split">
          <div class="donut-wrap">${donut([{ v: o.price, c: colors[0] }, { v: c.interest, c: colors[1] }, { v: upNoDown, c: colors[2] }])}
            <div class="donut-center"><span class="muted">Total cost</span><b>${inr(o.price + c.interest + upNoDown)}</b></div></div>
          <div class="legend">
            <div><i style="background:${colors[0]}"></i>Property price<b>${inr(o.price)}</b></div>
            <div><i style="background:${colors[1]}"></i>Interest paid to the bank<b>${inr(c.interest)}</b></div>
            <div><i style="background:${colors[2]}"></i>Taxes, fees & charges<b>${inr(upNoDown)}</b></div>
            <p class="explain-note">Over ${o.years} years you pay <b>${inr(c.interest)}</b> in interest, <b>${Math.round((c.interest / Math.max(c.loan, 1)) * 100)}%</b> of what you borrowed. A shorter tenure means a higher EMI but much less interest.</p>
          </div>
        </div>
        <h3 class="sub-h">Day-one payments</h3>
        <table class="metrics-table cost-table"><tbody>
          ${Object.entries(c.upfront).filter(([, v]) => v > 0).map(([k, v]) => `<tr><td>${k}</td><td>${inr(v)}</td></tr>`).join("")}
          <tr class="win"><td>Total cash upfront</td><td>${inr(c.upfrontTotal)}</td></tr>
        </tbody></table>
        <h3 class="sub-h">How your EMIs split, year by year</h3>
        <div class="amort">${c.schedule.map((s) => `<div class="amort-row" title="Year ${s.year}: principal ${inr(s.principal)}, interest ${inr(s.interest)}, balance ${inr(s.balance)}">
            <span>Yr ${s.year}</span>
            <div class="amort-bar"><i style="width:${(s.principal / maxYear) * 100}%;background:${colors[0]}"></i><i style="width:${(s.interest / maxYear) * 100}%;background:${colors[1]}"></i></div>
            <span class="muted">${inr(s.balance)} left</span></div>`).join("")}</div>
        <p class="explain-note">Blue = principal (you own more of the home) · Orange = interest. Early EMIs are mostly interest, so prepaying in the first years saves the most.</p>
      </div>`;
  };
  view.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", recalc));
  document.getElementById("c-city").addEventListener("change", (e) => {
    const s = STATE_OF_CITY[e.target.value];
    document.getElementById("c-stamp").value = STAMP_DUTY[s] ?? 6;
    document.getElementById("c-state").textContent = s || "your state";
    o.regCap = s === "Maharashtra" ? 30000 : null; // Maharashtra caps registration fee at ₹30,000
    recalc();
  });
  recalc();
}
