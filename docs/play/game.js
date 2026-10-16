// Short Gamma: the desk, the loop, and the online board.

import { analyticDigital } from "./engine.js";
import { DIGITAL_PAYOUT, EDGE, N_TICKS, REGIMES, RFQ_WINDOW, SIM_VERSION, Sim, TICKS_PER_DAY, clock, makeMarket, replay, todaySeed, unitPrice } from "./sim.js";
import { BOTS, bookRisk, bumpCheck, paths, runBot } from "./risk.js";

const $ = (s) => document.querySelector(s);
const DAILY = todaySeed();
const TICK_MS = 1200;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const MINUS = "−";
const money = (x) => {
  const r = Math.round(x);
  return (r < 0 ? MINUS : r > 0 ? "+" : "") + "$" + nf0.format(Math.abs(r));
};
const signed = (x, d = 0) => {
  const s = Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return (Math.round(x * 10 ** d) < 0 ? MINUS : "") + s;
};
const pct = (x, d = 1) => (100 * x).toFixed(d) + "%";
const cls = (x) => (x > 0.5 ? "up" : x < -0.5 ? "down" : "");
const when = (k) => { const c = clock(k); return `D${c.day} ${c.label}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const st = {
  mode: "daily", seed: DAILY, sim: null, risk: null,
  running: false, started: false, speed: 1, timer: null,
  digital: { mode: "sharp", h: 1 }, usedSmooth: false, smoothTicks: 0,
  autoBand: 0, tapePos: 0, sweeps: 0, greeks: 0, bumpPricings: 0,
  ghost: null, feed: [], ach: new Set(), lastRfq: null, finished: false,
};

const ACH = [
  { id: "bump", label: "Trust, but bump" },
  { id: "zero", label: "Found the zero" },
  { id: "green", label: "Closed green" },
  { id: "beat", label: "Beat the tape bot" },
  { id: "spread", label: "Earned the spread" },
  { id: "picked", label: "Picked off" },
  { id: "pin", label: "Pinned and alive" },
  { id: "zen", label: "Zen" },
];

function newGame(mode, seed, ghost = null) {
  clearTimeout(st.timer);
  Object.assign(st, {
    mode, seed, sim: new Sim(seed), running: false, started: false, finished: false,
    digital: { mode: "sharp", h: Number($("#dgH").value) || 1 }, usedSmooth: false, smoothTicks: 0,
    tapePos: 0, sweeps: 0, greeks: 0, bumpPricings: 0, feed: [], ach: new Set(), lastRfq: null, ghost: null,
  });
  if (ghost) {
    const byTick = new Map();
    for (const a of ghost.log || []) { if (!byTick.has(a[0])) byTick.set(a[0], []); byTick.get(a[0]).push(a); }
    st.ghost = { name: ghost.name, sim: new Sim(seed, st.sim.m), byTick };
  }
  $("#bumpOut").innerHTML = "";
  syncDigitalUI();
  $("#modeChip").textContent = mode === "daily" ? `Today's market · ${DAILY}` : `Practice · ${seed}`;
  $("#tGhostBox").hidden = $("#lgGhost").hidden = !st.ghost;
  tapeCache.clear();
  post(0, "The book is on. You are short 40 straddles, 25 puts and the 104 digital, sold at the screen.", "");
  if (st.ghost) post(0, `Racing ${st.ghost.name}'s ghost. Same market, their trades replayed alongside yours.`, "win");
  newsFor(0);
  recompute(true);
  render(true);
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

function setRunning(on) {
  if (st.finished) return;
  st.running = on;
  if (on) st.started = true;
  $("#playBtn").textContent = on ? "❚❚ Pause" : st.started ? "▶ Resume" : "▶ Run";
  clearTimeout(st.timer);
  if (on) st.timer = setTimeout(tick, TICK_MS / st.speed);
  pushPresence();
}

function tick() {
  const sim = st.sim;
  if (sim.done) return;
  if (st.autoBand > 0 && st.risk && Math.abs(st.risk.delta) > st.autoBand) doTrade(-st.risk.delta, true);
  if (st.digital.mode === "smooth") st.smoothTicks++;
  if (st.ghost) {
    for (const a of st.ghost.byTick.get(sim.k) || []) {
      if (a[1] === "B") st.ghost.sim.trade(Number(a[2]));
      else if (a[1] === "Q") st.ghost.sim.answer(Number(a[2]), String(a[3]));
    }
    st.ghost.sim.step();
  }
  sim.step();
  newsFor(sim.k);
  if (st.lastRfq && sim.k > st.lastRfq.until) st.lastRfq = null;
  recompute(true);
  render(true);
  pushPresence();
  if (sim.done) return finish();
  st.timer = setTimeout(tick, TICK_MS / st.speed);
}

function recompute(count) {
  st.risk = bookRisk(st.sim, st.digital, paths());
  if (count) {
    st.sweeps += st.risk.sweeps;
    st.greeks += st.risk.rows.length * 6;
    st.bumpPricings += st.risk.rows.length * 11;
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function doTrade(q, auto = false) {
  const sim = st.sim;
  if (sim.done || !st.started) return;
  const done = sim.trade(q);
  if (!done) return;
  const cost = Math.abs(done) * 0.01 + 2e-6 * done * done;
  post(sim.k, `${auto ? "Auto-hedge: " : ""}${done > 0 ? "bought" : "sold"} ${nf0.format(Math.abs(done))} sh at ${sim.S.toFixed(2)} · cost $${cost.toFixed(0)}`, "");
  recompute(false);
  render(false);
}

function flatten() {
  if (st.risk) doTrade(-st.risk.delta);
}

function quote(choice) {
  const sim = st.sim;
  const q = sim.activeRfqs()[0];
  if (!q || !st.started || sim.done) return;
  const res = sim.answer(q.id, choice);
  if (!res) return;
  st.lastRfq = { q, res, until: sim.k + 2 };
  const what = `${q.qty}× ${q.K} ${q.type}`;
  if (choice === "pass") post(sim.k, `Passed on the client's ${what}.`, "");
  else if (res.filled) post(sim.k, `Filled: ${q.side === "buy" ? "sold" : "bought"} ${what} at ${res.price.toFixed(2)} (σ ${pct(res.sigma)}).`, "good");
  else post(sim.k, `Client walked from your ${choice} quote on ${what}.`, "bad");
  recompute(false);
  render(false);
}

function setDigital(mode) {
  st.digital = { mode, h: Number($("#dgH").value) || 1 };
  if (mode === "smooth" && !st.usedSmooth) {
    st.usedSmooth = true;
    unlock("zero", "The digital's delta was never zero. The step payoff's derivative is, almost everywhere.");
  }
  syncDigitalUI();
  tapeCache.clear();
  recompute(false);
  render(true);
}

function syncDigitalUI() {
  $("#dgSharp").setAttribute("aria-pressed", String(st.digital.mode === "sharp"));
  $("#dgSmooth").setAttribute("aria-pressed", String(st.digital.mode === "smooth"));
  $("#dgH").disabled = st.digital.mode !== "smooth";
}

function runBumpCheck() {
  const sim = st.sim;
  const rows = [];
  let mismatch = false;
  for (const pos of sim.live()) {
    const b = bumpCheck(pos, sim.S, sim.iv, sim.k, st.digital, paths());
    if (!b) continue;
    const n = pos.qty * pos.mult;
    const aad = n * b.aad.S + 0, fd = n * b.fd.S;
    const off = Math.abs(aad - fd) > Math.max(25, 0.08 * Math.abs(fd));
    if (off && pos.type === "digital") mismatch = true;
    rows.push(`<tr><td>${esc(pos.label)}</td><td>${signed(aad)}</td><td>${signed(fd)}</td><td class="${off ? "down" : "up"}">${off ? "disagree" : "agree"}</td></tr>`);
  }
  $("#bumpOut").innerHTML = `<div class="tbl"><table><thead><tr><th>Δ shares</th><th>tape</th><th>bumped ±0.50</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    + `<p class="note">${rows.length * 11} pricings to check what ${rows.length} reverse sweeps produced.${mismatch ? " The digital disagrees: its pathwise payoff is a step, and the derivative of a step is zero almost everywhere." : ""}</p>`;
  if (mismatch) unlock("bump", "A bump caught the tape reporting zero delta on the digital.");
}

// ---------------------------------------------------------------------------
// news and achievements
// ---------------------------------------------------------------------------

function newsFor(k) {
  const m = st.sim.m;
  for (const e of m.events) {
    if (e.scheduled && e.announce === k && e.tick > k) post(k, `Scheduled: ${e.name} at ${when(e.tick)}. Implied vol gets bid into it.`, "ev");
    if (e.tick === k) post(k, `${e.name}: spot ${m.jump[k] >= 0 ? "+" : MINUS}${pct(Math.abs(m.jump[k]))} on the print.`, "ev");
  }
  if (k > 1 && (k - 1) % TICKS_PER_DAY === 0) {
    const gap = Math.log(m.S[k] / m.S[k - 1]);
    post(k, `Day ${clock(k).day} open: ${gap >= 0 ? "+" : MINUS}${pct(Math.abs(gap), 2)} from yesterday's close.`, "");
  }
  for (const q of m.rfqs) if (q.tick === k) post(k, `Client on the line for ${q.qty}× ${q.K} ${q.type}.`, "ev");
  if (k === N_TICKS) post(k, `The bell. Spot settles at ${m.S[k].toFixed(2)}; the 10-day options and the digital expire.`, "ev");
}

function post(k, text, kind) {
  st.feed.unshift({ k, text, kind });
  if (st.feed.length > 80) st.feed.pop();
}

let toastT = null;
function unlock(id, why) {
  if (st.ach.has(id)) return;
  st.ach.add(id);
  const a = ACH.find((x) => x.id === id);
  post(st.sim.k, `Unlocked: ${a.label}. ${why}`, "win");
  const t = $("#toast");
  t.innerHTML = `<b>Unlocked · ${esc(a.label)}</b>${esc(why)}`;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 4200);
  renderFeed();
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render(animate) {
  renderTop();
  renderBook();
  renderHedge();
  renderRfq();
  drawSpot();
  drawPnl();
  renderTape(animate);
  renderFeed();
}

function renderTop() {
  const sim = st.sim;
  $("#tClock").textContent = when(sim.k);
  $("#tSpot").textContent = sim.S.toFixed(2);
  $("#tIv").textContent = pct(sim.iv);
  $("#tRv").textContent = sim.k >= 3 ? pct(sim.realizedVol()) : "n/a";
  const pnl = sim.equity();
  const el = $("#tPnl");
  el.textContent = money(pnl);
  el.className = cls(pnl);
  if (st.ghost) {
    const d = pnl - st.ghost.sim.equity();
    $("#tGhost").textContent = money(d);
    $("#tGhost").className = cls(d);
  }
}

function renderBook() {
  const r = st.risk;
  $("#bookRows").innerHTML = r.rows.map((row) => {
    const p = row.pos;
    const isDig = p.type === "digital";
    const how = isDig
      ? st.digital.mode === "sharp"
        ? `<span class="how warn">tape · Monte Carlo pathwise · ${nf0.format(paths().length)} paths</span>`
        : `<span class="how">tape · call spread h=${st.digital.h} · ${nf0.format(paths().length)} paths</span>`
      : `<span class="how">tape · closed form · ${row.unit.tape.length} nodes</span>`;
    const qty = isDig ? `${MINUS}$${nf0.format(Math.abs(p.qty))}` : signed(p.qty);
    return `<tr data-pos="${p.id}" class="${p.id === st.tapePos ? "sel" : ""}"><td>${esc(p.label)}${p.src === "client" ? ' <span class="dim">client</span>' : ""}${how}</td>`
      + `<td>${qty}</td><td>${money(row.value)}</td><td>${signed(row.delta)}</td><td>${isDig ? "—" : signed(row.vega)}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">Everything has expired.</td></tr>`;
  $("#gGamma").textContent = signed(r.gamma);
  $("#gVega").textContent = signed(r.vega);
  $("#gTheta").textContent = (r.theta >= 0 ? "+" : "") + signed(r.theta);
  $("#gValue").textContent = money(r.rows.reduce((a, x) => a + x.value, 0));
}

function renderHedge() {
  const sim = st.sim, d = st.risk.delta;
  $("#hDelta").textContent = signed(d);
  $("#hDelta").className = Math.abs(d) > 2000 ? "down" : "";
  $("#hDeltaTxt").textContent = Math.abs(d) < 1 ? "flat" : d > 0 ? "shares long delta" : "shares short delta";
  const w = Math.min(50, (Math.abs(d) / 10000) * 50);
  const g = $("#hGauge");
  g.style.left = d >= 0 ? "50%" : `${50 - w}%`;
  g.style.width = `${w}%`;
  g.style.background = Math.abs(d) > 2000 ? "var(--down)" : "var(--adj)";
  $("#hShares").textContent = signed(sim.shares);
  $("#hCost").textContent = "$" + nf0.format(sim.tcost);
  for (const b of document.querySelectorAll(".hedgebtns .btn")) b.disabled = !st.started || sim.done;
}

function renderRfq() {
  const sim = st.sim;
  const q = sim.activeRfqs()[0];
  const card = $("#rfq");
  const total = sim.m.rfqs.length;
  const seen = sim.m.rfqs.filter((x) => x.tick <= sim.k).length;
  $("#rfqCount").textContent = `${seen} of ${total} clients so far`;
  if (q && st.started && !sim.done) {
    card.classList.add("hot");
    const left = q.tick + RFQ_WINDOW - sim.k;
    const ticks = q.expiry - sim.k;
    const proto = { type: q.type, K: q.K };
    const mid = unitPrice(proto, sim.S, sim.iv, ticks);
    const px = (c) => unitPrice(proto, sim.S, Math.max(0.02, sim.iv + (q.side === "buy" ? EDGE[c] : -EDGE[c]) / 100), ticks);
    const verb = q.side === "buy" ? "sell" : "buy";
    $("#rfqBody").innerHTML =
      `<div class="ask">Client wants to <em>${q.side}</em> ${q.qty}× ${q.K} ${q.type}, ${q.expiry > N_TICKS ? "30-day" : "10-day"}.</div>`
      + `<p class="note">Mid ${mid.toFixed(2)} at σ ${pct(sim.iv)}. You would ${verb} ${q.qty * 100} options' worth of ${q.type === "call" ? "upside" : "downside"}.</p>`
      + `<div class="quotes">`
      + `<button class="btn" data-quote="tight"><span>Tight <kbd>1</kbd></span><small>${verb} at ${px("tight").toFixed(2)} · ${EDGE.tight} vol</small></button>`
      + `<button class="btn" data-quote="wide"><span>Wide <kbd>2</kbd></span><small>${verb} at ${px("wide").toFixed(2)} · ${EDGE.wide} vol</small></button>`
      + `<button class="btn" data-quote="pass"><span>Pass <kbd>3</kbd></span><small>no trade</small></button></div>`
      + `<div class="timer"><i style="width:${(100 * left) / RFQ_WINDOW}%"></i></div>`;
    return;
  }
  card.classList.remove("hot");
  const lr = st.lastRfq;
  if (lr) {
    const { q: lq, res } = lr;
    const msg = res.choice === "pass" ? "You passed." : res.filled
      ? `Done. You ${lq.side === "buy" ? "sold" : "bought"} ${lq.qty}× ${lq.K} ${lq.type} at ${res.price.toFixed(2)}. It is on your book now.`
      : "The client walked. Too wide for them, or they knew better.";
    $("#rfqBody").innerHTML = `<p class="note" style="margin:0">${msg}</p>`;
    return;
  }
  const next = sim.m.rfqs.find((x) => x.tick > sim.k);
  $("#rfqBody").innerHTML = `<p class="empty">No client is asking right now.${next ? "" : " That was the last of them."} Requests for quotes land here; you have ${RFQ_WINDOW} bars to answer. Some clients know where volatility is going.</p>`;
}

function renderFeed() {
  $("#feedList").innerHTML = st.feed.slice(0, 60).map((f) => `<li class="${f.kind}"><time>${when(f.k)}</time><span>${esc(f.text)}</span></li>`).join("");
}

// ---------------------------------------------------------------------------
// charts
// ---------------------------------------------------------------------------

const css = getComputedStyle(document.documentElement);
const C = (n) => css.getPropertyValue(n).trim();

function canvasCtx(cv) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawSpot() {
  const cv = $("#spotCv");
  const { ctx, w, h } = canvasCtx(cv);
  const sim = st.sim, m = sim.m, k = sim.k;
  const L = 6, Rt = 62, T = 14, B = 20;
  const S = Array.from(m.S.slice(0, k + 1));
  const strikes = [...new Set(sim.positions.filter((p) => p.settled === null || p.expiry >= k).map((p) => p.K))];
  let lo = Math.min(...S, 98), hi = Math.max(...S, 102);
  for (const K of strikes) if (K > lo - 6 && K < hi + 6) { lo = Math.min(lo, K); hi = Math.max(hi, K); }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const X = (i) => L + (i / N_TICKS) * (w - L - Rt);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
  ctx.font = `10px ${C("--mono")}`;
  ctx.textBaseline = "middle";

  for (let d = 0; d < 10; d++) {
    const x0 = X(d * TICKS_PER_DAY);
    if (d % 2 === 1) { ctx.fillStyle = "rgba(255,255,255,0.018)"; ctx.fillRect(x0, T, X((d + 1) * TICKS_PER_DAY) - x0, h - T - B); }
    ctx.fillStyle = C("--dim");
    ctx.fillText(`D${d + 1}`, x0 + 4, h - 8);
  }
  for (const K of strikes) {
    const y = Y(K);
    if (y < T || y > h - B) continue;
    const isDig = sim.positions.some((p) => p.K === K && p.type === "digital");
    ctx.strokeStyle = isDig ? "rgba(255,100,124,0.55)" : C("--line2");
    ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - Rt, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = isDig ? C("--down") : C("--muted");
    ctx.fillText(`${K}${isDig ? " dig" : ""}`, w - Rt + 6, y);
  }
  for (const e of m.events) {
    const known = e.scheduled ? k >= e.announce : k >= e.tick;
    if (!known) continue;
    const x = X(e.tick);
    ctx.strokeStyle = e.tick > k ? "rgba(255,203,102,0.55)" : "rgba(255,203,102,0.22)";
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, h - B); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = C("--spot");
    ctx.textAlign = x > w * 0.7 ? "right" : "left";
    ctx.fillText(e.name.replace("Headline: ", ""), x + (x > w * 0.7 ? -4 : 4), T - 2);
    ctx.textAlign = "left";
  }
  ctx.strokeStyle = C("--spot"); ctx.lineWidth = 1.8; ctx.lineJoin = "round";
  ctx.beginPath();
  S.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.stroke();
  for (const [id, r] of Object.entries(sim.rfq)) {
    if (!r.filled) continue;
    const q = m.rfqs[id];
    const x = X(r.tick), y = Y(m.S[r.tick]);
    ctx.fillStyle = q.side === "buy" ? C("--down") : C("--up");
    ctx.beginPath();
    if (q.side === "buy") { ctx.moveTo(x, y - 7); ctx.lineTo(x - 5, y - 15); ctx.lineTo(x + 5, y - 15); }
    else { ctx.moveTo(x, y + 7); ctx.lineTo(x - 5, y + 15); ctx.lineTo(x + 5, y + 15); }
    ctx.fill();
  }
  const x = X(k), y = Y(S[k]);
  ctx.fillStyle = C("--spot");
  ctx.shadowColor = C("--spot"); ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
}

function drawPnl() {
  const cv = $("#pnlCv");
  const { ctx, w, h } = canvasCtx(cv);
  const sim = st.sim, k = sim.k;
  const L = 6, Rt = 62, T = 8, B = 6;
  const mine = sim.pnl.slice(0, k + 1);
  const ghost = st.ghost ? st.ghost.sim.pnl.slice(0, k + 1) : [];
  const all = [...mine, ...ghost, 0];
  let lo = Math.min(...all), hi = Math.max(...all);
  const span = Math.max(4000, hi - lo); lo -= span * 0.1; hi = lo + span * 1.2;
  const X = (i) => L + (i / N_TICKS) * (w - L - Rt);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
  ctx.strokeStyle = C("--line2"); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(L, Y(0)); ctx.lineTo(w - Rt, Y(0)); ctx.stroke();
  ctx.font = `10px ${C("--mono")}`; ctx.textBaseline = "middle"; ctx.fillStyle = C("--dim");
  ctx.fillText("$0", w - Rt + 6, Y(0));
  const line = (arr, color, dash) => {
    if (arr.length < 1) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.setLineDash(dash);
    ctx.beginPath();
    arr.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.stroke(); ctx.setLineDash([]);
  };
  if (ghost.length) line(ghost, C("--ghost"), [4, 3]);
  // area under your line
  ctx.beginPath(); ctx.moveTo(X(0), Y(0));
  mine.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
  ctx.lineTo(X(mine.length - 1), Y(0)); ctx.closePath();
  ctx.fillStyle = "rgba(77,231,255,0.08)"; ctx.fill();
  line(mine, C("--adj"), []);
  const last = mine[mine.length - 1];
  ctx.fillStyle = last >= 0 ? C("--up") : C("--down");
  ctx.fillText(money(last), w - Rt + 6, Math.min(h - 8, Math.max(8, Y(last))));
}

// ---------------------------------------------------------------------------
// the tape, drawn
// ---------------------------------------------------------------------------

const tapeCache = new Map();
const GLYPH = { "+": "+", "−": "−", "×": "×", "÷": "÷", neg: "−x", exp: "eˣ", ln: "ln", "√": "√", "Φ": "Φ", relu: "max", step: "1{>}", mean: "x̄", sum: "Σ", pow: "xⁿ" };
const INPUT = { S: "S", K: "K", r: "r", sigma: "σ", T: "T" };
const isZero = (v) => (v instanceof Float64Array ? v.every((x) => x === 0) : v === 0);
const mag = (v) => (v instanceof Float64Array ? v.reduce((a, x) => a + Math.abs(x), 0) / v.length : Math.abs(v));
const short = (v) => (v instanceof Float64Array ? `[${nf0.format(v.length)}]` : Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(3));

function layout(tape, out) {
  const n = out + 1;
  const depth = new Array(n).fill(0), kids = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (const [p] of tape.parents[i]) kids[p].push(i);
    if (tape.parents[i].length) depth[i] = 1 + Math.max(...tape.parents[i].map(([p]) => depth[p]));
  }
  for (let i = 0; i < n; i++)
    if (tape.ops[i] === "const" && kids[i].length) depth[i] = Math.max(1, Math.min(...kids[i].map((c) => depth[c])) - 1);
  const maxD = Math.max(...depth);
  const cols = Array.from({ length: maxD + 1 }, () => []);
  for (let i = 0; i < n; i++) cols[depth[i]].push(i);
  const row = new Array(n).fill(0);
  cols[0].forEach((i, r) => (row[i] = r));
  for (let pass = 0; pass < 3; pass++) {
    for (let d = 1; d <= maxD; d++) {
      const key = (i) => {
        const ps = tape.parents[i].map(([p]) => row[p]);
        const ks = kids[i].map((c) => row[c]);
        const all = ps.length ? ps : ks;
        return all.length ? all.reduce((a, b) => a + b, 0) / all.length : i;
      };
      cols[d].sort((a, b) => key(a) - key(b) || a - b);
      cols[d].forEach((i, r) => (row[i] = r));
    }
  }
  const rows = Math.max(...cols.map((c) => c.length));
  const colW = 58, rowH = 40, padL = 132, padR = 96, padT = 26;
  const W = padL + maxD * colW + padR, H = padT * 2 + (rows - 1) * rowH;
  const pos = [];
  for (let d = 0; d <= maxD; d++) {
    const c = cols[d], off = ((rows - c.length) * rowH) / 2;
    c.forEach((i, r) => (pos[i] = { x: padL + d * colW, y: padT + off + r * rowH }));
  }
  return { n, pos, W, H };
}

function buildTapeSvg(key, tape, out) {
  const L = layout(tape, out);
  const svg = $("#tapeSvg");
  svg.setAttribute("viewBox", `0 0 ${L.W} ${L.H}`);
  const parts = [];
  for (let i = 0; i < L.n; i++)
    for (const [p] of tape.parents[i]) {
      const a = L.pos[p], b = L.pos[i], mx = (a.x + b.x) / 2;
      parts.push(`<path class="edge" data-e="${p}-${i}" d="M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}"/>`);
    }
  for (let i = 0; i < L.n; i++) {
    const { x, y } = L.pos[i], op = tape.ops[i];
    const vec = tape.values[i] instanceof Float64Array;
    const glyph = INPUT[op] || (op === "const" ? (vec ? "z" : short(tape.values[i])) : GLYPH[op] || op);
    parts.push(`<g class="node${vec ? " vec" : ""}" data-n="${i}" transform="translate(${x},${y})">`
      + (vec ? `<circle class="outer" r="17"/>` : "") + `<circle r="13"/><text>${esc(glyph)}</text><title></title></g>`);
  }
  const inputs = [];
  for (let i = 0; i < L.n; i++) if (INPUT[tape.ops[i]]) inputs.push(i);
  for (const i of inputs) {
    const { x, y } = L.pos[i];
    parts.push(`<text class="lab" data-in="${i}" x="${x - 22}" y="${y - 6}" text-anchor="end"></text>`);
    parts.push(`<text class="lab g" data-ad="${i}" x="${x - 22}" y="${y + 8}" text-anchor="end"></text>`);
  }
  const o = L.pos[out];
  parts.push(`<text class="lab" data-out="1" x="${o.x + 22}" y="${o.y - 6}"></text>`);
  parts.push(`<text class="lab g" x="${o.x + 22}" y="${o.y + 8}">adjoint seed 1</text>`);
  svg.innerHTML = parts.join("");
  const nodes = [...svg.querySelectorAll(".node")];
  const edges = [...svg.querySelectorAll(".edge")].map((el) => {
    const [p, c] = el.dataset.e.split("-").map(Number);
    return { el, p, c };
  });
  const entry = { key, L, nodes, edges, inputs, svg };
  tapeCache.set("current", entry);
  return entry;
}

let sweepRaf = 0;
function renderTape(animate) {
  const sim = st.sim;
  const live = st.risk.rows;
  if (!live.some((r) => r.pos.id === st.tapePos) && live.length) st.tapePos = live[0].pos.id;
  $("#tapePick").innerHTML = live.map((r) => `<button class="pill" data-tape="${r.pos.id}" aria-pressed="${r.pos.id === st.tapePos}">${esc(r.pos.label)}</button>`).join("");
  $("#cSweeps").textContent = nf0.format(st.sweeps);
  $("#cGreeks").textContent = nf0.format(st.greeks);
  $("#cBump").textContent = nf0.format(st.bumpPricings) + " pricings";
  const row = live.find((r) => r.pos.id === st.tapePos);
  if (!row) { $("#tapeSvg").innerHTML = ""; return; }
  const { tape, outIdx: out, adj } = row.unit;
  $("#cNodes").textContent = tape.length;
  const key = `${row.pos.type}|${st.digital.mode}|${tape.length}`;
  let T = tapeCache.get("current");
  if (!T || T.key !== key) T = buildTapeSvg(key, tape, out);
  const isDig = row.pos.type === "digital";
  $("#tapeCaption").textContent = isDig
    ? st.digital.mode === "sharp" ? "Monte Carlo digital, sharp payoff: watch the sweep die at the step" : `Monte Carlo digital, call spread h = ${st.digital.h}`
    : "closed-form Black-Scholes on the tape";
  $("#tapeNote").textContent = isDig && st.digital.mode === "sharp"
    ? "The step node's local derivative is zero on every path, so the adjoint reaching S is exactly zero. No NaN, no warning: the screen just says Δ = 0. Bump-check it, or switch the digital to call-spread smoothing."
    : "Forward pass left to right records every operation. The reverse sweep runs right to left and leaves ∂V/∂input on each input: five Greeks for roughly the cost of two pricings, however many inputs there are.";

  for (const i of T.inputs) {
    const op = tape.ops[i];
    T.svg.querySelector(`[data-in="${i}"]`).textContent = `${INPUT[op]} = ${short(tape.values[i])}`;
    const a = T.svg.querySelector(`[data-ad="${i}"]`);
    a.textContent = `∂V/∂${INPUT[op]} = ${isZero(adj[i]) ? "0" : short(adj[i])}`;
    a.setAttribute("class", `lab ${isZero(adj[i]) && op === "S" ? "z" : "g"}`);
  }
  T.svg.querySelector('[data-out="1"]').textContent = `V = ${short(tape.values[out])}`;
  T.nodes.forEach((g, i) => {
    g.querySelector("title").textContent = `node ${i} · ${tape.ops[i]} · value ${short(tape.values[i])} · adjoint ${short(adj[i])}`;
  });

  const reached = (i, p) => i >= p;
  const paint = (prog) => {
    T.nodes.forEach((g, i) => {
      const hit = reached(i, prog);
      const z = isZero(adj[i]);
      g.classList.toggle("lit", hit && !z);
      g.classList.toggle("zero", hit && z && T.edges.some((e) => e.p === i && !isZero(adj[e.c])));
      g.querySelector("circle:not(.outer)").style.fill = hit && !z ? `rgba(77,231,255,${0.08 + 0.26 * Math.min(1, Math.pow(mag(adj[i]) / (mag(adj[out]) || 1), 0.25))})` : "";
    });
    for (const e of T.edges) {
      const on = reached(e.c, prog) && !isZero(adj[e.c]);
      const local = tape.parents[e.c].find(([p]) => p === e.p)[1];
      e.el.classList.toggle("lit", on && !isZero(local));
      e.el.classList.toggle("dead", on && isZero(local));
    }
  };
  cancelAnimationFrame(sweepRaf);
  if (!animate || reduceMotion) return paint(-1);
  const t0 = performance.now(), dur = Math.min(700, (TICK_MS / st.speed) * 0.6);
  const frame = (t) => {
    const f = Math.min(1, (t - t0) / dur);
    paint(out - f * (out + 1));
    if (f < 1) sweepRaf = requestAnimationFrame(frame);
  };
  paint(out + 1);
  sweepRaf = requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// the close
// ---------------------------------------------------------------------------

let botCache = { seed: null, res: null };
function botsFor(seed) {
  if (botCache.seed === seed) return botCache.res;
  const m = seed === st.sim.m.seed ? st.sim.m : makeMarket(seed);
  const res = BOTS.map((b) => ({ ...b, pnl: runBot(seed, b.id, m).equity() }));
  botCache = { seed, res };
  return res;
}

function finish() {
  st.finished = true;
  st.running = false;
  $("#playBtn").textContent = "Closed";
  const sim = st.sim, pnl = sim.equity(), m = sim.m;
  const tradeCount = sim.log.filter((a) => a[1] === "B").length;
  const fills = Object.entries(sim.rfq).filter(([, r]) => r.filled).map(([id]) => m.rfqs[id]);
  if (pnl > 0) unlock("green", "Positive P&L at the bell.");
  if (fills.filter((q) => !q.informed).length >= 3) unlock("spread", "Three fills from clients who didn't know anything.");
  if (fills.some((q) => q.informed)) unlock("picked", "You traded with someone who knew where vol was going.");
  if (Math.abs(m.S[N_TICKS] - 104) < 1.5 && pnl > 0) unlock("pin", "Spot finished on top of the digital's strike and you still made money.");
  if (tradeCount === 0 && pnl > 0) unlock("zen", "No hedges at all, and green anyway. Don't count on it.");

  // how wrong was the screen? the digital's true delta along the path
  let peak = 0, peakK = 0;
  const dig = sim.positions.find((p) => p.type === "digital");
  for (let k = 0; k < N_TICKS; k++) {
    const d = Math.abs(dig.qty * analyticDigital({ S: m.S[k], K: dig.K, r: 0.03, sigma: m.iv[k], T: (N_TICKS - k) / (252 * TICKS_PER_DAY) }).delta);
    if (d > peak) { peak = d; peakK = k; }
  }
  const smoothShare = st.smoothTicks / N_TICKS;
  const attr = sim.attribution();
  const labels = { straddle: "100 straddle", wing: "95 put", digital: "104 digital", clients: "Client trades", hedge: "Stock hedging", costs: "Costs", interest: "Interest" };
  const maxA = Math.max(1, ...Object.values(attr).map(Math.abs));
  const bars = Object.entries(attr).map(([k, v]) => {
    const w = (Math.abs(v) / maxA) * 50;
    return `<div class="bar"><span>${labels[k]}</span><span class="t"><i style="left:${v >= 0 ? 50 : 50 - w}%;width:${w}%;background:${v >= 0 ? "var(--up)" : "var(--down)"}"></i></span><span class="v ${cls(v)}">${money(v)}</span></div>`;
  }).join("");

  const days = Array.from({ length: 10 }, (_, d) => {
    const a = d * TICKS_PER_DAY, b = (d + 1) * TICKS_PER_DAY;
    let iv = 0; for (let k = a; k < b; k++) iv += m.iv[k];
    return { d: d + 1, rv: sim.realizedVol(a, b), iv: iv / TICKS_PER_DAY, regime: REGIMES[m.regime[d]].name };
  });
  const vmax = Math.max(...days.map((x) => Math.max(x.rv, x.iv)));
  const dayRows = days.map((x) => `<div class="bar"><span>D${x.d} · ${x.regime}</span><span class="t vb">`
    + `<i style="left:0;width:${(x.iv / vmax) * 100}%;background:var(--line2);top:0;bottom:6px"></i>`
    + `<i style="left:0;width:${(x.rv / vmax) * 100}%;background:var(--spot);top:7px;bottom:0"></i></span>`
    + `<span class="v">${pct(x.rv, 0)} / ${pct(x.iv, 0)}</span></div>`).join("");

  const clients = m.rfqs.map((q) => {
    const r = sim.rfq[q.id] || { choice: "missed" };
    const pos = r.position != null ? sim.positions[r.position] : null;
    const pl = pos ? pos.flow + (pos.settled ?? sim.mark(pos)) : 0;
    return `<tr><td>${when(q.tick)}</td><td>${q.side} ${q.qty}× ${q.K} ${q.type}</td><td>${q.informed ? '<span class="down">knew vol</span>' : '<span class="dim">no edge</span>'}</td>`
      + `<td>${r.choice}${r.filled ? " · filled" : ""}</td><td class="${cls(pl)}">${pos ? money(pl) : "—"}</td></tr>`;
  }).join("");

  const lesson = smoothShare > 0.5
    ? `You ran the digital on call-spread smoothing for ${pct(smoothShare, 0)} of the game. The pathwise tape would have shown <strong>Δ = 0</strong> the whole time; the true delta peaked at <strong>${nf0.format(peak)} shares</strong> at ${when(peakK)}.`
    : `For ${pct(1 - smoothShare, 0)} of the game your screen said the digital had <strong>zero delta</strong>. The tape was faithful to the program: a step payoff has zero derivative almost everywhere. The true delta peaked at <strong>${nf0.format(peak)} shares</strong> at ${when(peakK)}. That is the "Where it loses" table in the README, with money on it.`;

  const ghostLine = st.ghost ? `<p class="lede m">${esc(st.ghost.name)}'s ghost closed at <span class="${cls(st.ghost.sim.equity())}">${money(st.ghost.sim.equity())}</span>. You were ${pnl >= st.ghost.sim.equity() ? "ahead" : "behind"} by ${money(Math.abs(pnl - st.ghost.sim.equity())).replace("+", "")}.</p>` : "";

  $("#endSheet").innerHTML = `
    <div class="kicker">The bell · ${st.mode === "daily" ? `today's market, ${DAILY}` : `practice market ${esc(st.seed)}`}</div>
    <div class="final ${cls(pnl)}">${money(pnl)}</div>
    <p class="lede m">Spot closed at ${m.S[N_TICKS].toFixed(2)}. Realized vol ran ${pct(sim.realizedVol(0, N_TICKS))} against an average implied of ${pct(m.iv.reduce((a, b) => a + b, 0) / m.iv.length)}. ${tradeCount} hedge trades, $${nf0.format(sim.tcost)} in costs.</p>
    ${ghostLine}
    <div class="lesson">${lesson}</div>
    <div class="two">
      <div><h3>Where the money came from</h3><div class="bars">${bars}</div></div>
      <div><h3>Same market, three bots</h3><div class="bars" id="botBars"><p class="empty">Running the bots on your market…</p></div></div>
    </div>
    <div class="two">
      <div><h3>Realized vs implied, by day</h3><div class="bars">${dayRows}</div><p class="note">Amber is what the market did, grey is what it charged. The regime was hidden from you.</p></div>
      <div><h3>Your clients, unmasked</h3><div class="tbl"><table><tbody>${clients}</tbody></table></div></div>
    </div>
    <h3 style="margin-top:22px">Achievements</h3>
    <div class="ach" id="achList"></div>
    <p class="note" id="postNote"></p>
    <div class="cta">
      <button class="btn primary" id="againBtn">Practice a new market</button>
      ${st.mode === "daily" ? "" : '<button class="btn" id="dailyBtn">Trade today\'s market</button>'}
      <button class="btn" id="deskBtn">Look at the desk</button>
    </div>`;
  $("#endOv").hidden = false;
  renderAch();
  setTimeout(() => {
    const bots = botsFor(st.seed);
    const tape = bots.find((b) => b.id === "aad");
    if (pnl > tape.pnl) unlock("beat", `You beat the bot that trusts the pathwise tape by ${money(pnl - tape.pnl).replace("+", "")}.`);
    const all = [...bots, { name: "You", blurb: "", pnl, me: true }].sort((a, b) => b.pnl - a.pnl);
    const mx = Math.max(1, ...all.map((b) => Math.abs(b.pnl)));
    $("#botBars").innerHTML = all.map((b) => {
      const w = (Math.abs(b.pnl) / mx) * 50;
      return `<div class="bar" title="${esc(b.blurb)}"><span class="${b.me ? "" : "muted"}" style="${b.me ? "color:var(--adj)" : ""}">${esc(b.name)}</span><span class="t"><i style="left:${b.pnl >= 0 ? 50 : 50 - w}%;width:${w}%;background:${b.me ? "var(--adj)" : "var(--line2)"}"></i></span><span class="v ${cls(b.pnl)}">${money(b.pnl)}</span></div>`;
    }).join("") + `<p class="note">"Trusted the tape" delta-hedges every bar with the screen's Greeks, digital zero included. "Smoothed" does the same with h = 1.</p>`;
    renderAch();
    renderBoard();
  }, 60);
  saveRun(pnl);
  pushPresence();
}

function renderAch() {
  const el = $("#achList");
  if (el) el.innerHTML = ACH.map((a) => `<span class="${st.ach.has(a.id) ? "on" : ""}">${esc(a.label)}</span>`).join("");
}

// ---------------------------------------------------------------------------
// online: the board (db), the desk (room), names (user)
// ---------------------------------------------------------------------------

const online = { db: null, room: null, user: null, uid: null, runs: [], verified: new Map(), peers: [], unsub: null };
let dailyMarket = null;
const dm = () => (dailyMarket ||= makeMarket(DAILY));

async function connectOnline() {
  if (!window.claude || typeof window.claude.use !== "function") { renderBoard(); return; }
  const [db, room, user] = await Promise.all(["db", "room", "user"].map((n) => window.claude.use(n).catch(() => null)));
  Object.assign(online, { db, room, user });
  if (user) online.uid = await user.id();
  if (db) {
    online.unsub = db.collection("runs").where("seed", "==", DAILY).orderBy("pnl", "desc").limit(50).onSnapshot(
      (snap) => { online.runs = snap.docs.map((d) => ({ id: d.id, ...d.data() })); renderBoard(); },
      () => { online.db = null; renderBoard(); });
  }
  if (room) {
    room.onPeers((ch) => { online.peers = ch.peers; renderPeers(); }, () => { online.room = null; renderPeers(); });
    pushPresence();
  }
  renderBoard();
}

function pushPresence() {
  if (!online.room) return;
  const sim = st.sim;
  online.room.presence({
    g: "short-gamma", mode: st.mode, daily: st.mode === "daily",
    k: sim ? sim.k : 0, pnl: sim ? Math.round(sim.equity()) : 0,
    status: st.finished ? "closed" : st.running ? "trading" : st.started ? "paused" : "lobby",
  }).catch(() => {});
}

async function names(ids) {
  if (!online.user || !ids.length) return {};
  try { return await online.user.profiles(ids); } catch { return {}; }
}

async function renderPeers() {
  const peers = online.peers.filter((p) => p.presence && p.presence.g === "short-gamma");
  const ps = await names([...new Set(peers.map((p) => p.by).filter(Boolean))]);
  const html = peers.map((p) => {
    const pr = p.presence;
    const who = p.isMe && p.sameTab ? "you" : (p.by && ps[p.by]?.name) || "Someone";
    return `<div class="peer ${p.isMe && p.sameTab ? "me" : ""}"><i></i><span>${esc(who)} <span class="dim">· ${pr.status === "lobby" ? "in the lobby" : `${pr.daily ? "today's market" : "practice"}, ${when(pr.k || 0)}`}</span></span>`
      + `<span class="num ${cls(pr.pnl || 0)}">${pr.status === "lobby" ? "" : money(pr.pnl || 0)}</span><span></span></div>`;
  });
  const box = $("#peers");
  box.hidden = html.length === 0;
  box.innerHTML = html.length ? `<div class="dim" style="font-size:11px;letter-spacing:.12em;text-transform:uppercase">On the desk now · ${html.length}</div>` + html.join("") : "";
  $("#startPeers").innerHTML = html.length ? html.join("") : "Nobody else yet.";
  $("#startPeers").className = html.length ? "peers" : "empty";
}

function verify(run) {
  const key = `${run.id}:${run.at}:${run.pnl}`;
  if (!online.verified.has(key)) {
    let ok = false, pnl = NaN;
    try {
      if (run.v === SIM_VERSION && run.seed === DAILY && Array.isArray(run.log) && run.log.length < 20000) {
        pnl = replay(DAILY, run.log, dm()).equity();
        ok = Math.abs(pnl - run.pnl) < 0.01;
      }
    } catch { ok = false; }
    online.verified.set(key, { ok, pnl });
  }
  return online.verified.get(key);
}

function localRuns() {
  try { return JSON.parse(localStorage.getItem("short-gamma:runs") || "{}"); } catch { return {}; }
}

async function renderBoard() {
  let rows = [];
  let note = "replayed, not trusted";
  if (online.db) {
    const runs = online.runs.map((r) => ({ ...r, check: verify(r) }));
    const ok = runs.filter((r) => r.check.ok);
    const bad = runs.length - ok.length;
    const ps = await names(ok.map((r) => r.id));
    rows = ok.map((r) => ({ name: r.id === online.uid ? "you" : ps[r.id]?.name || "Someone", pnl: r.check.pnl, me: r.id === online.uid, log: r.log }));
    if (bad) note = `${bad} rejected: replay didn't match`;
  } else {
    const mine = localRuns()[DAILY] || [];
    rows = mine.map((r) => ({ name: "you, this browser", pnl: replay(DAILY, r.log, dm()).equity(), me: true, log: r.log }));
    note = "this browser only";
  }
  if (botCache.seed === DAILY) for (const b of botCache.res) rows.push({ name: b.name, pnl: b.pnl, bot: true });
  rows.sort((a, b) => b.pnl - a.pnl);
  $("#boardSub").textContent = note;
  const tr = rows.map((r, i) => `<tr class="${r.bot ? "bot" : r.me ? "me" : ""}"><td class="num">${i + 1}</td><td>${esc(r.name)}${r.bot ? ' <span class="dim">bot</span>' : ' <span class="badge">✓ replayed</span>'}</td>`
    + `<td class="num ${cls(r.pnl)}">${money(r.pnl)}</td><td>${r.log && !r.me ? `<button class="btn" data-ghost="${i}">Race</button>` : ""}</td></tr>`);
  boardRows = rows;
  $("#boardRows").innerHTML = tr.join("") || `<tr><td class="empty">No runs posted for ${DAILY} yet. Finish today's market to post the first.</td></tr>`;
  const humans = rows.filter((r) => !r.bot).slice(0, 5);
  $("#startBoard").innerHTML = humans.length
    ? `<div class="tbl lb"><table><tbody>${humans.map((r, i) => `<tr class="${r.me ? "me" : ""}"><td class="num">${i + 1}</td><td>${esc(r.name)}</td><td class="num ${cls(r.pnl)}">${money(r.pnl)}</td></tr>`).join("")}</tbody></table></div>`
    : `No runs posted for ${DAILY} yet.`;
  $("#startBoard").className = humans.length ? "" : "empty";
}
let boardRows = [];

async function saveRun(pnl) {
  if (st.mode !== "daily") return;
  const note = $("#postNote");
  const run = { seed: DAILY, pnl, log: st.sim.log, v: SIM_VERSION, at: new Date().toISOString(), smooth: st.usedSmooth };
  if (online.db && online.uid) {
    try {
      const ref = online.db.doc("runs/" + online.uid);
      const prev = await ref.get();
      const old = prev.exists ? prev.data() : null;
      if (old && old.seed === DAILY && verify({ id: online.uid, ...old }).ok && old.pnl >= pnl) {
        if (note) note.textContent = `Your earlier run today (${money(old.pnl)}) stays on the board. Best run counts.`;
        return;
      }
      await ref.set(run);
      if (note) note.textContent = "Posted to today's board. Everyone's page re-simulates your trades before it shows your score.";
    } catch (e) {
      if (note) note.textContent = "Couldn't post to the board from this view, so the run is saved in this browser.";
      saveLocal(run);
    }
  } else {
    saveLocal(run);
    if (note) note.textContent = online.db ? "Sign in to post to the shared board. Saved in this browser." : "Saved in this browser. Open the shared version to post to today's board.";
  }
  renderBoard();
}

function saveLocal(run) {
  try {
    const all = localRuns();
    const list = (all[run.seed] || []).concat([{ pnl: run.pnl, log: run.log, at: run.at }]).sort((a, b) => b.pnl - a.pnl).slice(0, 5);
    all[run.seed] = list;
    for (const k of Object.keys(all)) if (k < todaySeed(new Date(Date.now() - 7 * 864e5))) delete all[k];
    localStorage.setItem("short-gamma:runs", JSON.stringify(all));
  } catch { /* storage refused: the run still counted on screen */ }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

function start(mode, ghost = null) {
  const seed = mode === "daily" ? DAILY : "p-" + Math.random().toString(36).slice(2, 8);
  newGame(mode, seed, ghost);
  $("#startOv").hidden = true;
  $("#endOv").hidden = true;
  setRunning(true);
}

$("#startDaily").onclick = () => start("daily");
$("#startPractice").onclick = () => start("practice");
$("#playBtn").onclick = () => {
  if (st.finished) { $("#endOv").hidden = false; return; }
  if (!st.started && !$("#startOv").hidden) return;
  setRunning(!st.running);
};
for (const b of document.querySelectorAll("[data-speed]"))
  b.onclick = () => {
    st.speed = Number(b.dataset.speed);
    for (const x of document.querySelectorAll("[data-speed]")) x.setAttribute("aria-pressed", String(x === b));
    if (st.running) { clearTimeout(st.timer); st.timer = setTimeout(tick, TICK_MS / st.speed); }
  };
for (const b of document.querySelectorAll(".hedgebtns [data-q]")) b.onclick = () => doTrade(Number(b.dataset.q));
$("#flatBtn").onclick = flatten;
$("#autoSel").onchange = (e) => (st.autoBand = Number(e.target.value));
$("#dgSharp").onclick = () => setDigital("sharp");
$("#dgSmooth").onclick = () => setDigital("smooth");
$("#dgH").onchange = () => st.digital.mode === "smooth" && setDigital("smooth");
$("#bumpBtn").onclick = runBumpCheck;
$("#rfqBody").addEventListener("click", (e) => { const b = e.target.closest("[data-quote]"); if (b) quote(b.dataset.quote); });
$("#bookRows").addEventListener("click", (e) => { const tr = e.target.closest("[data-pos]"); if (tr) { st.tapePos = Number(tr.dataset.pos); renderBook(); renderTape(true); } });
$("#tapePick").addEventListener("click", (e) => { const b = e.target.closest("[data-tape]"); if (b) { st.tapePos = Number(b.dataset.tape); renderBook(); renderTape(true); } });
$("#boardRows").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ghost]");
  if (!b) return;
  const r = boardRows[Number(b.dataset.ghost)];
  if (r && r.log) start("daily", { name: r.name, log: r.log });
});
$("#endOv").addEventListener("click", (e) => {
  if (e.target.id === "againBtn") start("practice");
  if (e.target.id === "dailyBtn") start("daily");
  if (e.target.id === "deskBtn") $("#endOv").hidden = true;
});

document.addEventListener("keydown", (e) => {
  if (e.target.closest("select,input,textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === " ") { e.preventDefault(); $("#playBtn").click(); }
  else if (k === "f") flatten();
  else if (k === "b") doTrade(e.shiftKey ? 1000 : 100);
  else if (k === "s") doTrade(e.shiftKey ? -1000 : -100);
  else if (k === "1") quote("tight");
  else if (k === "2") quote("wide");
  else if (k === "3") quote("pass");
  else if (k === "d") setDigital(st.digital.mode === "sharp" ? "smooth" : "sharp");
});

let resizeT = null;
new ResizeObserver(() => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (st.sim) { drawSpot(); drawPnl(); } }, 60); }).observe($("#market"));

// keep a game across a republish: the run is (seed, log), so restore is a replay
function snapshot() {
  return st.sim && st.started ? { mode: st.mode, seed: st.seed, log: st.sim.log, k: st.sim.k, digital: st.digital, finished: st.finished } : {};
}

function boot(data) {
  newGame("daily", DAILY);
  if (data && data.seed && Array.isArray(data.log) && Number.isInteger(data.k) && data.k < N_TICKS && !data.finished) {
    newGame(data.mode === "practice" ? "practice" : "daily", data.seed);
    const sim = st.sim;
    const byTick = new Map();
    for (const a of data.log) { if (!byTick.has(a[0])) byTick.set(a[0], []); byTick.get(a[0]).push(a); }
    for (let k = 0; k < data.k; k++) {
      for (const a of byTick.get(k) || []) a[1] === "B" ? sim.trade(Number(a[2])) : sim.answer(Number(a[2]), String(a[3]));
      sim.step();
    }
    if (data.digital) { st.digital = data.digital; syncDigitalUI(); }
    st.started = true;
    $("#startOv").hidden = true;
    post(sim.k, "The page updated under you. Your game is restored from its trade log; press Resume.", "win");
    recompute(false);
    render(false);
    setRunning(false);
  }
  connectOnline();
  // bots for today's board, once the page is idle
  setTimeout(() => { botsFor(DAILY); renderBoard(); }, 400);
}

const hot = window.claude?.hot;
if (hot && typeof hot.snapshot === "function") hot.snapshot(snapshot);
if (hot && typeof hot.ready === "function") hot.ready(boot);
else boot(hot?.data ?? {});
