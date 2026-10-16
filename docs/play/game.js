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
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const st = {
  mode: "daily", seed: DAILY, sim: null, risk: null,
  running: false, started: false, speed: 1, timer: null,
  digital: { mode: "sharp", h: 1 }, usedSmooth: false, smoothTicks: 0,
  autoBand: 0, tapePos: 0, sweeps: 0, greeks: 0, bumpPricings: 0,
  ghost: null, feed: [], feedSeq: 0, feedSeen: 0, ach: new Set(), lastRfq: null, finished: false,
  seg: { t0: 0, dur: 1 }, view: null, profile: null, flash: null,
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
    view: null, flash: null, seg: { t0: 0, dur: 1 },
  });
  if (ghost) {
    const byTick = new Map();
    for (const a of ghost.log || []) { if (!byTick.has(a[0])) byTick.set(a[0], []); byTick.get(a[0]).push(a); }
    st.ghost = { name: ghost.name, sim: new Sim(seed, st.sim.m), byTick };
  }
  $("#bumpOut").innerHTML = "";
  syncDigitalUI();
  $("#modeChip").textContent = mode === "daily" ? `today's market · ${DAILY}` : `practice · ${seed}`;
  $("#tGhostBox").hidden = $("#lgGhost").hidden = !st.ghost;
  tapeCache.clear();
  post(0, "The book is on. You are short 40 straddles, 25 puts and the 104 digital, sold at the screen.", "");
  if (st.ghost) post(0, `Racing ${st.ghost.name}'s ghost. Same market, their trades replayed beside yours.`, "win");
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
  st.seg = { t0: performance.now(), dur: Math.min(560, (TICK_MS / st.speed) * 0.7) };
  newsFor(sim.k);
  if (st.lastRfq && sim.k > st.lastRfq.until) st.lastRfq = null;
  recompute(true);
  render(true);
  pushPresence();
  if (sim.done) return finish();
  st.timer = setTimeout(tick, TICK_MS / st.speed);
}

function recompute(count) {
  const sim = st.sim;
  st.risk = bookRisk(sim, st.digital, paths());
  if (count) {
    st.sweeps += st.risk.sweeps;
    st.greeks += st.risk.rows.length * 6;
    st.bumpPricings += st.risk.rows.length * 11;
  }
  // the chart's vertical range, and the book's P&L if spot jumped to each level
  const S = sim.m.S;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= sim.k; i++) { lo = Math.min(lo, S[i]); hi = Math.max(hi, S[i]); }
  lo = Math.min(lo, sim.S * 0.93, 95); hi = Math.max(hi, sim.S * 1.07, 105);
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  if (!st.view) st.view = { lo, hi, tlo: lo, thi: hi };
  st.view.tlo = lo; st.view.thi = hi;
  const live = sim.live();
  const value = (s) => {
    let v = sim.shares * s;
    for (const p of live) v += p.qty * p.mult * unitPrice(p, s, sim.iv, p.expiry - sim.k);
    return v;
  };
  const now = value(sim.S);
  const grid = [], val = [];
  for (let i = 0; i <= 90; i++) { const s = lo + ((hi - lo) * i) / 90; grid.push(s); val.push(value(s) - now); }
  st.profile = { grid, val };
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
  post(sim.k, `${auto ? "Auto-hedge " : ""}${done > 0 ? "bought" : "sold"} ${nf0.format(Math.abs(done))} sh at ${sim.S.toFixed(2)}, cost $${cost.toFixed(0)}`, "");
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
  if (choice === "pass") { post(sim.k, `Passed on the client's ${what}.`, ""); stamp("passed"); }
  else if (res.filled) { post(sim.k, `Filled: ${q.side === "buy" ? "sold" : "bought"} ${what} at ${res.price.toFixed(2)} (σ ${pct(res.sigma)}).`, "good"); stamp("filled"); }
  else { post(sim.k, `Client walked from your ${choice} quote on ${what}.`, "bad"); stamp("walked"); }
  recompute(false);
  render(false);
}

let stampT = null;
function stamp(kind) {
  const el = $("#stamp");
  el.textContent = kind;
  el.className = `stamp ${kind}`;
  void el.offsetWidth;
  el.className = `stamp on ${kind}`;
  clearTimeout(stampT);
  stampT = setTimeout(() => (el.className = `stamp off ${kind}`), 2400);
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
    if (e.tick === k) {
      const j = m.jump[k];
      post(k, `${e.name}: spot ${j >= 0 ? "+" : MINUS}${pct(Math.abs(j))} on the print.`, "ev");
      st.flash = { k, t0: performance.now(), txt: `${j >= 0 ? "+" : MINUS}${pct(Math.abs(j))}`, up: j >= 0 };
      shake();
    }
  }
  if (k > 1 && (k - 1) % TICKS_PER_DAY === 0) {
    const gap = Math.log(m.S[k] / m.S[k - 1]);
    post(k, `Day ${clock(k).day} open: ${gap >= 0 ? "+" : MINUS}${pct(Math.abs(gap), 2)} from yesterday's close.`, "");
  }
  for (const q of m.rfqs) if (q.tick === k) post(k, `Phone's ringing: a client wants ${q.qty}× ${q.K} ${q.type}.`, "ev");
  if (k === N_TICKS) post(k, `The bell. Spot settles at ${m.S[k].toFixed(2)}; the 10-day options and the digital expire.`, "ev");
}

function shake() {
  if (reduceMotion) return;
  const d = $("#desk");
  d.classList.remove("shake");
  void d.offsetWidth;
  d.classList.add("shake");
}

function post(k, text, kind) {
  st.feed.unshift({ k, text, kind, id: ++st.feedSeq });
  if (st.feed.length > 80) st.feed.pop();
}

let toastT = null;
function unlock(id, why) {
  if (st.ach.has(id)) return;
  st.ach.add(id);
  const a = ACH.find((x) => x.id === id);
  post(st.sim.k, `${a.label}. ${why}`, "win");
  const t = $("#toast");
  t.innerHTML = `<b>${esc(a.label)}</b>${esc(why)}`;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 4200);
  renderFeed();
}

// ---------------------------------------------------------------------------
// the split-flap board
// ---------------------------------------------------------------------------

function makeCell(parent) {
  const el = document.createElement("span");
  el.className = "fl";
  el.innerHTML = '<span class="h t"><i></i></span><span class="h b"><i></i></span><span class="lf"><span class="h t"><i></i></span><span class="h b k"><i></i></span></span>';
  parent.appendChild(el);
  const q = el.querySelectorAll("i");
  const cell = { ch: " ", t: q[0], b: q[1], f: q[2], k: q[3], lf: el.querySelector(".lf") };
  cell.lf.addEventListener("animationend", () => { cell.b.textContent = cell.ch; cell.lf.classList.remove("go"); });
  return cell;
}

function flipTo(cell, c, delay = 0) {
  if (cell.ch === c) return;
  const old = cell.ch;
  cell.ch = c;
  if (reduceMotion || document.hidden) { cell.t.textContent = cell.b.textContent = c; return; }
  cell.t.textContent = c;
  cell.f.textContent = old;
  cell.b.textContent = old;
  cell.k.textContent = c;
  cell.lf.classList.remove("go");
  void cell.lf.offsetWidth;
  cell.lf.style.setProperty("--dl", `${delay}ms`);
  cell.lf.classList.add("go");
}

class Flaps {
  constructor(el, n, align = "right") {
    el.textContent = "";
    this.el = el; this.n = n; this.align = align;
    this.cells = Array.from({ length: n }, () => makeCell(el));
  }
  set(text) {
    const s = String(text);
    const t = (this.align === "right" ? s.padStart(this.n) : s.padEnd(this.n)).slice(0, this.n);
    [...t].forEach((c, i) => flipTo(this.cells[i], c, i * 24));
  }
}

const board = {
  clock: new Flaps($("#fClock"), 9, "left"),
  spot: new Flaps($("#fSpot"), 6),
  iv: new Flaps($("#fIv"), 5),
  rv: new Flaps($("#fRv"), 5),
  pnl: new Flaps($("#fPnl"), 9),
  ghost: new Flaps($("#fGhost"), 8),
};

function titleFlaps() {
  const box = $("#titleFlaps");
  box.innerHTML = "";
  const AZ = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  ["SHORT", "GAMMA"].forEach((word, w) => {
    const row = document.createElement("div");
    row.className = "flaps";
    box.appendChild(row);
    const f = new Flaps(row, word.length);
    [...word].forEach((ch, i) => {
      if (reduceMotion) return flipTo(f.cells[i], ch);
      const spins = 6 + i * 2 + w * 4;
      for (let s = 0; s < spins; s++)
        setTimeout(() => flipTo(f.cells[i], s === spins - 1 ? ch : AZ[(Math.random() * 26) | 0]), 250 + s * 85);
    });
  });
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render(animate) {
  renderTop();
  renderBook();
  renderHedge();
  renderRfq();
  renderTape(animate);
  renderFeed();
  renderCrawl();
}

function renderTop() {
  const sim = st.sim;
  const c = clock(sim.k);
  board.clock.set(`D${c.day} ${c.label}`);
  board.spot.set(sim.S.toFixed(2));
  board.iv.set(pct(sim.iv));
  board.rv.set(sim.k >= 3 ? pct(sim.realizedVol()) : "—");
  const pnl = sim.equity();
  board.pnl.set(money(pnl));
  board.pnl.el.className = `flaps ${cls(pnl)}`;
  if (st.ghost) {
    const d = pnl - st.ghost.sim.equity();
    board.ghost.set(money(d));
    board.ghost.el.className = `flaps ${cls(d)}`;
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

// the meter: ±10,000 shares across 160 degrees
const METER = { cx: 120, cy: 120, r: 98, span: 80, full: 10000 };
const ang = (d) => clamp(d / METER.full, -1, 1) * METER.span;
function buildMeter() {
  const { cx, cy, r } = METER;
  const pt = (a, rr) => [cx + rr * Math.sin((a * Math.PI) / 180), cy - rr * Math.cos((a * Math.PI) / 180)];
  const arc = (a0, a1, rr) => {
    const [x0, y0] = pt(a0, rr), [x1, y1] = pt(a1, rr);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${rr},${rr} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
  };
  const zones = [
    [-80, -40, "rgba(255,93,80,.55)"], [-40, -16, "rgba(255,197,58,.45)"], [-16, 16, "rgba(75,204,143,.5)"],
    [16, 40, "rgba(255,197,58,.45)"], [40, 80, "rgba(255,93,80,.55)"],
  ];
  const parts = [`<path d="${arc(-82, 82, r)}" stroke="#0b0b0c" stroke-width="18" fill="none"/>`];
  for (const [a, b, c] of zones) parts.push(`<path d="${arc(a, b, r)}" stroke="${c}" stroke-width="10" fill="none"/>`);
  for (let s = -10000; s <= 10000; s += 1000) {
    const a = ang(s), major = s % 5000 === 0;
    const [x0, y0] = pt(a, r - (major ? 16 : 11)), [x1, y1] = pt(a, r - 6);
    parts.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${major ? "#a29f96" : "#4a4b52"}" stroke-width="${major ? 1.6 : 1}"/>`);
    if (major) { const [tx, ty] = pt(a, r - 28); parts.push(`<text x="${tx}" y="${ty}" text-anchor="middle" dominant-baseline="central">${s === 0 ? "0" : (s > 0 ? "+" : MINUS) + Math.abs(s / 1000) + "k"}</text>`); }
  }
  parts.push(`<g class="needle" id="needle"><path d="M116.5,120 L120,${cy - r + 4} L123.5,120 Z" fill="#eeece5"/><circle cx="120" cy="120" r="8" fill="#ffc53a"/><circle cx="120" cy="120" r="3" fill="#0b0b0c"/></g>`);
  parts.push(`<text x="20" y="136" text-anchor="start">short</text><text x="220" y="136" text-anchor="end">long</text>`);
  $("#meter").innerHTML = parts.join("");
}

function renderHedge() {
  const sim = st.sim, d = st.risk.delta;
  $("#hDelta").textContent = signed(d);
  $("#hDelta").style.color = Math.abs(d) > 5000 ? "var(--down)" : Math.abs(d) > 2000 ? "var(--jacket)" : "";
  $("#hDeltaTxt").textContent = Math.abs(d) < 1 ? "flat" : d > 0 ? "shares long delta" : "shares short delta";
  $("#needle").style.transform = `rotate(${ang(d)}deg)`;
  $("#flatBtn").classList.toggle("urge", st.started && !sim.done && Math.abs(d) > 2000);
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
      `<div class="ask">Client wants to <em>${q.side}</em> ${q.qty}× ${q.K} ${q.type}s, ${q.expiry > N_TICKS ? "30-day" : "10-day"}</div>`
      + `<p class="note">Mid ${mid.toFixed(2)} at σ ${pct(sim.iv)}. You'd ${verb} ${nf0.format(q.qty * 100)} options' worth of ${q.type === "call" ? "upside" : "downside"}.</p>`
      + `<div class="quotes">`
      + `<button class="btn" data-quote="tight"><span>Tight <kbd>1</kbd></span><small>${verb} ${px("tight").toFixed(2)} · ${EDGE.tight} vol</small></button>`
      + `<button class="btn" data-quote="wide"><span>Wide <kbd>2</kbd></span><small>${verb} ${px("wide").toFixed(2)} · ${EDGE.wide} vol</small></button>`
      + `<button class="btn" data-quote="pass"><span>Pass <kbd>3</kbd></span><small>no trade</small></button></div>`
      + `<div class="timer"><i style="width:${(100 * left) / RFQ_WINDOW}%"></i></div>`;
    return;
  }
  card.classList.remove("hot");
  const lr = st.lastRfq;
  if (lr) {
    const { q: lq, res } = lr;
    const msg = res.choice === "pass" ? "You passed." : res.filled
      ? `You ${lq.side === "buy" ? "sold" : "bought"} ${lq.qty}× ${lq.K} ${lq.type}s at ${res.price.toFixed(2)}. They're on your book now.`
      : "The client walked. Too wide for them, or they knew better.";
    $("#rfqBody").innerHTML = `<div class="ask" style="font-size:22px">${lq.qty}× ${lq.K} ${lq.type}s</div><p class="note">${msg}</p>`;
    return;
  }
  const next = sim.m.rfqs.find((x) => x.tick > sim.k);
  $("#rfqBody").innerHTML = `<p class="empty" style="margin:0">Quiet. ${next ? "When a client calls, you get three bars to quote." : "That was the last client."} Some of them know where volatility is going.</p>`;
}

function renderFeed() {
  const seen = st.feedSeen;
  $("#feedList").innerHTML = st.feed.slice(0, 60).map((f) => `<li class="${f.kind}${f.id > seen && !reduceMotion ? " in" : ""}"><time>${when(f.k)}</time><span>${esc(f.text)}</span></li>`).join("");
  st.feedSeen = st.feedSeq;
}

let crawlKey = "";
function renderCrawl() {
  const sim = st.sim, m = sim.m;
  const prev = sim.k > 0 ? m.S[sim.k - 1] : m.S[0];
  const ch = sim.S - prev;
  const items = [
    `Spot <b>${sim.S.toFixed(2)}</b> ${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch).toFixed(2)}`,
    `Implied <b>${pct(sim.iv)}</b>`,
    `Net delta <b>${signed(st.risk.delta)}</b> sh`,
  ];
  const next = m.events.find((e) => e.tick > sim.k && (e.scheduled ? sim.k >= e.announce : false));
  if (next) items.push(`Next: <b>${esc(next.name)}</b> ${when(next.tick)}`);
  for (const f of st.feed.slice(0, 6)) items.push(esc(f.text.length > 90 ? f.text.slice(0, 88) + "…" : f.text));
  const key = `${sim.k}|${st.feedSeq}`;
  if (key === crawlKey) return;
  crawlKey = key;
  const html = items.map((t) => `<span>${t}</span>`).join("");
  const el = $("#crawl");
  el.innerHTML = html + html;
  const half = el.scrollWidth / 2;
  const want = Math.max(30, half / 70);
  const cur = parseFloat(el.style.getPropertyValue("--crawl")) || 0;
  if (Math.abs(want - cur) / want > 0.25) el.style.setProperty("--crawl", `${want.toFixed(0)}s`);
}

// ---------------------------------------------------------------------------
// charts, drawn every frame
// ---------------------------------------------------------------------------

const css = getComputedStyle(document.documentElement);
const C = (n) => css.getPropertyValue(n).trim();
const COL = {};
function colors() {
  for (const n of ["--chalk", "--muted", "--dim", "--line", "--line2", "--jacket", "--up", "--down", "--ghost", "--panel2"]) COL[n] = C(n);
}

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

const segP = (now) => (reduceMotion ? 1 : clamp((now - st.seg.t0) / st.seg.dur, 0, 1));
const ease = (t) => 1 - Math.pow(1 - t, 3);

function series(arr, k, p) {
  // the path through tick k-1 plus the growing segment toward k
  const pts = [];
  for (let i = 0; i < k; i++) pts.push([i, arr[i]]);
  if (k === 0) pts.push([0, arr[0]]);
  else { const e = ease(p); pts.push([k - 1 + e, arr[k - 1] + (arr[k] - arr[k - 1]) * e]); }
  return pts;
}

function drawSpot(now) {
  const { ctx, w, h } = canvasCtx($("#spotCv"));
  const sim = st.sim, m = sim.m, k = sim.k;
  const PR = w < 520 ? 70 : 110;
  const L = 6, Rt = PR + 48, T = 22, B = 22;
  const v = st.view;
  v.lo += (v.tlo - v.lo) * 0.12; v.hi += (v.thi - v.hi) * 0.12;
  const X = (i) => L + (i / N_TICKS) * (w - L - Rt);
  const Y = (s) => T + (1 - (s - v.lo) / (v.hi - v.lo)) * (h - T - B);
  const fontM = `11px ${C("--mono")}`, fontD = `700 12px ${C("--disp")}`;
  ctx.textBaseline = "middle";

  // day bands
  for (let d = 0; d < 10; d++) {
    const x0 = X(d * TICKS_PER_DAY), x1 = X((d + 1) * TICKS_PER_DAY);
    if (d % 2 === 0) { ctx.fillStyle = "rgba(255,255,255,0.022)"; ctx.fillRect(x0, T - 8, x1 - x0, h - T - B + 8); }
    ctx.fillStyle = COL["--dim"]; ctx.font = fontD;
    ctx.fillText(x1 - x0 > 46 ? `DAY ${d + 1}` : `D${d + 1}`, x0 + 4, h - 9);
  }
  // price grid
  ctx.font = fontM;
  const step = (v.hi - v.lo) > 24 ? 5 : 2;
  for (let s = Math.ceil(v.lo / step) * step; s < v.hi; s += step) {
    const y = Y(s);
    ctx.strokeStyle = "rgba(255,255,255,0.035)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - Rt, y); ctx.stroke();
  }
  // strikes
  const strikes = [...new Set(sim.positions.filter((p) => p.settled === null).map((p) => p.K))];
  const tagY = Y(m.S[k]);
  for (const K of strikes) {
    const y = Y(K);
    if (y < T - 4 || y > h - B) continue;
    const isDig = sim.positions.some((p) => p.K === K && p.type === "digital" && p.settled === null);
    ctx.strokeStyle = isDig ? "rgba(255,93,80,0.7)" : "rgba(238,236,229,0.22)";
    ctx.setLineDash(isDig ? [6, 4] : [2, 4]); ctx.lineWidth = isDig ? 1.4 : 1;
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - Rt, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = isDig ? COL["--down"] : COL["--muted"];
    ctx.font = fontD;
    if (Math.abs(y - tagY) > 13) ctx.fillText(isDig ? `${K} DIG` : `${K}`, w - Rt + 6, y);
  }
  // scheduled news: flags on the future
  for (const e of m.events) {
    const known = e.scheduled ? k >= e.announce : k >= e.tick;
    if (!known) continue;
    const x = X(e.tick), future = e.tick > k;
    ctx.strokeStyle = future ? "rgba(255,197,58,0.65)" : "rgba(255,197,58,0.2)";
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, T - 6); ctx.lineTo(x, h - B); ctx.stroke(); ctx.setLineDash([]);
    if (future) {
      const label = e.name.replace("Headline: ", "").toUpperCase();
      ctx.font = `800 11px ${C("--disp")}`;
      const tw = ctx.measureText(label).width + 10;
      const lx = x + tw > w - Rt ? x - tw : x;
      ctx.fillStyle = COL["--jacket"];
      ctx.fillRect(lx, T - 18, tw, 15);
      ctx.fillStyle = "#0b0b0c";
      ctx.fillText(label, lx + 5, T - 10);
    }
  }
  // spot: area, line, head
  const pts = series(m.S, k, segP(now));
  const grad = ctx.createLinearGradient(0, T, 0, h - B);
  grad.addColorStop(0, "rgba(238,236,229,0.13)"); grad.addColorStop(1, "rgba(238,236,229,0)");
  ctx.beginPath();
  pts.forEach(([i, s], j) => (j ? ctx.lineTo(X(i), Y(s)) : ctx.moveTo(X(i), Y(s))));
  const [hx, hs] = pts[pts.length - 1];
  ctx.lineTo(X(hx), h - B); ctx.lineTo(X(0), h - B); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  pts.forEach(([i, s], j) => (j ? ctx.lineTo(X(i), Y(s)) : ctx.moveTo(X(i), Y(s))));
  ctx.strokeStyle = COL["--chalk"]; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
  // fills from clients
  for (const [id, r] of Object.entries(sim.rfq)) {
    if (!r.filled) continue;
    const q = m.rfqs[id], x = X(r.tick), y = Y(m.S[r.tick]);
    ctx.fillStyle = q.side === "buy" ? COL["--down"] : COL["--up"];
    ctx.beginPath();
    if (q.side === "buy") { ctx.moveTo(x, y - 6); ctx.lineTo(x - 5, y - 14); ctx.lineTo(x + 5, y - 14); }
    else { ctx.moveTo(x, y + 6); ctx.lineTo(x - 5, y + 14); ctx.lineTo(x + 5, y + 14); }
    ctx.fill();
  }
  // news flash
  if (st.flash && now - st.flash.t0 < 1400 && !reduceMotion) {
    const f = (now - st.flash.t0) / 1400, x = X(st.flash.k);
    const g = ctx.createLinearGradient(x - 40, 0, x + 40, 0);
    g.addColorStop(0, "rgba(255,197,58,0)"); g.addColorStop(0.5, `rgba(255,197,58,${0.35 * (1 - f)})`); g.addColorStop(1, "rgba(255,197,58,0)");
    ctx.fillStyle = g; ctx.fillRect(x - 40, T - 8, 80, h - T - B + 8);
    ctx.font = `900 ${28 + 10 * (1 - f)}px ${C("--disp")}`;
    ctx.fillStyle = st.flash.up ? `rgba(75,204,143,${1 - f})` : `rgba(255,93,80,${1 - f})`;
    ctx.textAlign = "center";
    ctx.fillText(st.flash.txt, clamp(x, 40, w - Rt - 40), Y(m.S[st.flash.k]) - 26 - 26 * f);
    ctx.textAlign = "left";
  }
  // head: a pulse
  const hy = Y(hs), px = X(hx);
  const ph = (now % 1600) / 1600;
  if (!reduceMotion && !sim.done) {
    ctx.strokeStyle = `rgba(255,197,58,${0.7 * (1 - ph)})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, hy, 4 + 14 * ph, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = COL["--jacket"];
  ctx.beginPath(); ctx.arc(px, hy, 4.5, 0, Math.PI * 2); ctx.fill();
  // price tag on the axis
  ctx.font = `700 12px ${C("--mono")}`;
  const tag = hs.toFixed(2), tw = ctx.measureText(tag).width + 10;
  ctx.fillStyle = COL["--jacket"];
  ctx.fillRect(w - Rt + 2, hy - 9, tw, 18);
  ctx.fillStyle = "#0b0b0c";
  ctx.fillText(tag, w - Rt + 7, hy);

  // the profile: your P&L if spot jumped to this level right now
  const P = st.profile;
  if (P) {
    const x0 = w - PR, cx = x0 + PR / 2, half = PR / 2 - 4;
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(x0, T - 8, PR, h - T - B + 8);
    const mx = Math.max(1, ...P.val.map(Math.abs));
    for (let i = 0; i < P.grid.length - 1; i++) {
      const y0 = Y(P.grid[i]), y1 = Y(P.grid[i + 1]);
      if (Math.max(y0, y1) < T - 8 || Math.min(y0, y1) > h - B) continue;
      const val = P.val[i], bw = (Math.abs(val) / mx) * half;
      ctx.fillStyle = val >= 0 ? "rgba(75,204,143,0.55)" : "rgba(255,93,80,0.55)";
      ctx.fillRect(val >= 0 ? cx : cx - bw, Math.min(y0, y1), bw, Math.max(1, Math.abs(y1 - y0) + 0.5));
    }
    ctx.strokeStyle = "rgba(238,236,229,0.25)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, T - 8); ctx.lineTo(cx, h - B); ctx.stroke();
    ctx.strokeStyle = COL["--jacket"]; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(x0, Y(sim.S)); ctx.lineTo(w, Y(sim.S)); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `700 10px ${C("--disp")}`; ctx.fillStyle = COL["--dim"]; ctx.textAlign = "center";
    ctx.fillText("IF SPOT JUMPS HERE", cx, h - 9);
    ctx.fillText(`±${money(mx).replace("+", "")}`, cx, T - 14);
    ctx.textAlign = "left";
  }
}

function drawPnl(now) {
  const { ctx, w, h } = canvasCtx($("#pnlCv"));
  const sim = st.sim, k = sim.k;
  const PR = w < 520 ? 70 : 110;
  const L = 6, Rt = PR + 48, T = 10, B = 8;
  const p = segP(now);
  const mine = series(sim.pnl, k, p);
  const ghost = st.ghost ? series(st.ghost.sim.pnl, k, p) : [];
  const all = [...mine, ...ghost].map((x) => x[1]).concat([0]);
  let lo = Math.min(...all), hi = Math.max(...all);
  const span = Math.max(6000, hi - lo); lo -= span * 0.12; hi = lo + span * 1.24;
  const X = (i) => L + (i / N_TICKS) * (w - L - Rt);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
  ctx.strokeStyle = "rgba(238,236,229,0.2)"; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(L, Y(0)); ctx.lineTo(w - Rt, Y(0)); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = `11px ${C("--mono")}`; ctx.textBaseline = "middle"; ctx.fillStyle = COL["--dim"];
  const lastV = mine[mine.length - 1][1];
  if (Math.abs(Y(0) - clamp(Y(lastV), 9, h - 9)) > 13) ctx.fillText("$0", w - Rt + 6, Y(0));
  ctx.font = `700 12px ${C("--disp")}`;
  ctx.fillText("P&L", L + 4, T + 6);
  const line = (pts, color, width, dash) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath();
    pts.forEach(([i, v], j) => (j ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.stroke(); ctx.setLineDash([]);
  };
  if (ghost.length) line(ghost, COL["--ghost"], 1.6, [5, 4]);
  // area: green above zero, red below
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, Y(0)); ctx.clip();
  ctx.beginPath(); ctx.moveTo(X(0), Y(0));
  mine.forEach(([i, v]) => ctx.lineTo(X(i), Y(v)));
  ctx.lineTo(X(mine[mine.length - 1][0]), Y(0)); ctx.closePath();
  ctx.fillStyle = "rgba(75,204,143,0.16)"; ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.rect(0, Y(0), w, h); ctx.clip();
  ctx.beginPath(); ctx.moveTo(X(0), Y(0));
  mine.forEach(([i, v]) => ctx.lineTo(X(i), Y(v)));
  ctx.lineTo(X(mine[mine.length - 1][0]), Y(0)); ctx.closePath();
  ctx.fillStyle = "rgba(255,93,80,0.16)"; ctx.fill();
  ctx.restore();
  line(mine, COL["--jacket"], 2, []);
  const [li, lv] = mine[mine.length - 1];
  ctx.fillStyle = COL["--jacket"];
  ctx.beginPath(); ctx.arc(X(li), Y(lv), 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.font = `700 12px ${C("--mono")}`;
  ctx.fillStyle = lv >= 0 ? COL["--up"] : COL["--down"];
  ctx.fillText(money(lv), w - Rt + 6, clamp(Y(lv), 9, h - 9));
}

// ---------------------------------------------------------------------------
// the tape, drawn and swept
// ---------------------------------------------------------------------------

const tapeCache = new Map();
const GLYPH = { "+": "+", "−": "−", "×": "×", "÷": "÷", neg: "−x", exp: "eˣ", ln: "ln", "√": "√", "Φ": "Φ", relu: "max", step: "1{>}", mean: "x̄", sum: "Σ", pow: "xⁿ" };
const INPUT = { S: "S", K: "K", r: "r", sigma: "σ", T: "T" };
const isZero = (v) => (v instanceof Float64Array ? v.every((x) => x === 0) : v === 0);
const short = (v) => (v instanceof Float64Array ? `[${nf0.format(v.length)}]` : Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(3));
const SVGNS = "http://www.w3.org/2000/svg";

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
        const all = ps.length ? ps : kids[i].map((c) => row[c]);
        return all.length ? all.reduce((a, b) => a + b, 0) / all.length : i;
      };
      cols[d].sort((a, b) => key(a) - key(b) || a - b);
      cols[d].forEach((i, r) => (row[i] = r));
    }
  }
  const rows = Math.max(...cols.map((c) => c.length));
  const colW = 58, rowH = 40, padL = 138, padR = 104, padT = 26;
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
    const inp = !!INPUT[op];
    const glyph = INPUT[op] || (op === "const" ? (vec ? "z" : short(tape.values[i])) : GLYPH[op] || op);
    const w = inp ? 30 : 34, hh = inp ? 24 : 22;
    parts.push(`<g class="node${vec ? " vec" : ""}${inp ? " inp" : ""}" data-n="${i}" transform="translate(${x},${y})">`
      + (vec ? `<rect class="outer" x="${-w / 2 - 4}" y="${-hh / 2 - 4}" width="${w + 8}" height="${hh + 8}" rx="6"/>` : "")
      + `<rect x="${-w / 2}" y="${-hh / 2}" width="${w}" height="${hh}" rx="4"/><text>${esc(glyph)}</text><title></title></g>`);
  }
  const inputs = [];
  for (let i = 0; i < L.n; i++) if (INPUT[tape.ops[i]]) inputs.push(i);
  for (const i of inputs) {
    const { x, y } = L.pos[i];
    parts.push(`<text class="lab" data-in="${i}" x="${x - 24}" y="${y - 6}" text-anchor="end"></text>`);
    parts.push(`<text class="lab g" data-ad="${i}" x="${x - 24}" y="${y + 8}" text-anchor="end"></text>`);
  }
  const o = L.pos[out];
  parts.push(`<text class="lab" data-out="1" x="${o.x + 24}" y="${o.y - 6}"></text>`);
  parts.push(`<text class="lab g" x="${o.x + 24}" y="${o.y + 8}">seed ∂V/∂V = 1</text>`);
  parts.push(`<text class="zpop" id="zpop">∂ = 0</text><g id="parts"></g>`);
  svg.innerHTML = parts.join("");
  const nodes = [...svg.querySelectorAll(".node")];
  const edges = [...svg.querySelectorAll(".edge")].map((el) => {
    const [p, c] = el.dataset.e.split("-").map(Number);
    return { el, p, c, len: el.getTotalLength() };
  });
  const byChild = Array.from({ length: L.n }, () => []);
  for (const e of edges) byChild[e.c].push(e);
  const entry = { key, L, nodes, edges, byChild, inputs, svg, parts: svg.querySelector("#parts"), zpop: svg.querySelector("#zpop") };
  tapeCache.set("current", entry);
  return entry;
}

let sweep = null;
const particles = [];

function renderTape(animate) {
  const live = st.risk.rows;
  if (!live.some((r) => r.pos.id === st.tapePos) && live.length) st.tapePos = live[0].pos.id;
  $("#tapePick").innerHTML = live.map((r) => `<button class="pill" data-tape="${r.pos.id}" aria-pressed="${r.pos.id === st.tapePos}">${esc(r.pos.label)}</button>`).join("");
  $("#cSweeps").textContent = nf0.format(st.sweeps);
  $("#cGreeks").textContent = nf0.format(st.greeks);
  $("#cBump").textContent = nf0.format(st.bumpPricings) + " px";
  const row = live.find((r) => r.pos.id === st.tapePos);
  if (!row) { $("#tapeSvg").innerHTML = ""; sweep = null; return; }
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
    ? "The step node's local derivative is zero on every one of 16,384 paths, so the adjoint that reaches S is exactly zero. No NaN, no warning: the screen just says Δ = 0. Bump-check it, or switch the digital to call-spread smoothing."
    : "The forward pass records every operation and its local derivative. The reverse sweep walks the tape backwards and leaves ∂V/∂input on every input: five Greeks for roughly the cost of two pricings, however many inputs there are.";

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
  const s = { T, tape, adj, out, t0: performance.now(), dur: Math.min(1100, (TICK_MS / st.speed) * 0.85), fw: -1, rv: out + 1, zp: false };
  if (!animate || reduceMotion) { paintFwd(s, out + 1); paintRev(s, -1); sweep = null; phase(""); return; }
  paintFwd(s, -1); paintRev(s, out + 1);
  sweep = s;
}

function phase(which) {
  $("#phF").classList.toggle("on", which === "f");
  $("#phR").classList.toggle("on", which === "r");
}

function paintFwd(s, prog) {
  s.T.nodes.forEach((g, i) => g.classList.toggle("fw", i < prog));
  for (const e of s.T.edges) e.el.classList.toggle("fw", e.c < prog);
}

function paintRev(s, prog) {
  const { T, tape, adj } = s;
  T.nodes.forEach((g, i) => {
    const hit = i >= prog, z = isZero(adj[i]);
    g.classList.toggle("lit", hit && !z);
    g.classList.toggle("zero", hit && z && T.edges.some((e) => e.p === i && !isZero(adj[e.c])));
  });
  for (const e of T.edges) {
    const on = e.c >= prog && !isZero(adj[e.c]);
    const local = tape.parents[e.c].find(([p]) => p === e.p)[1];
    e.el.classList.toggle("lit", on && !isZero(local));
    e.el.classList.toggle("dead", on && isZero(local));
  }
}

function spawn(T, e, kind, dur, now) {
  const c = document.createElementNS(SVGNS, "circle");
  c.setAttribute("r", kind === "fwd" ? "2" : "3");
  c.setAttribute("class", `pt ${kind}`);
  T.parts.appendChild(c);
  particles.push({ el: c, e, kind, t0: now, dur, T });
}

function runSweep(now) {
  const s = sweep;
  if (!s) return;
  const f = (now - s.t0) / s.dur;
  const FW = 0.3;
  if (f < FW) {
    phase("f");
    const prog = Math.floor((f / FW) * (s.out + 1));
    for (let i = s.fw + 1; i <= Math.min(prog, s.out); i++)
      for (const e of s.T.byChild[i]) spawn(s.T, e, "fwd", s.dur * 0.12, now);
    s.fw = Math.max(s.fw, prog);
    paintFwd(s, prog);
  } else {
    phase(f < 1.05 ? "r" : "");
    if (s.fw <= s.out) { paintFwd(s, s.out + 1); s.fw = s.out + 1; }
    const g = Math.min(1, (f - FW) / (1 - FW));
    const prog = Math.ceil(s.out - g * (s.out + 1));
    for (let c = s.rv - 1; c >= Math.max(prog, 0); c--) {
      if (isZero(s.adj[c])) continue;
      for (const e of s.T.byChild[c]) {
        const local = s.tape.parents[e.c].find(([p]) => p === e.p)[1];
        spawn(s.T, e, isZero(local) ? "dead" : "", s.dur * 0.22, now);
      }
    }
    s.rv = Math.min(s.rv, Math.max(prog, 0));
    paintRev(s, prog);
  }
  if (f > 1.3) { sweep = null; phase(""); }
}

function runParticles(now) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    const u = (now - p.t0) / p.dur;
    if (u >= 1 || !p.el.isConnected) {
      if (p.kind === "dead" && p.el.isConnected) {
        const n = p.T.L.pos[p.e.p];
        const z = p.T.zpop;
        z.setAttribute("x", n.x); z.setAttribute("y", n.y - 20);
        z.classList.remove("on"); void z.getBBox(); z.classList.add("on");
      }
      p.el.remove();
      particles.splice(i, 1);
      continue;
    }
    // forward particles run parent→child, reverse ones child→parent
    const along = p.kind === "fwd" ? u : 1 - u;
    const pt = p.e.el.getPointAtLength(p.e.len * along);
    p.el.setAttribute("cx", pt.x.toFixed(1));
    p.el.setAttribute("cy", pt.y.toFixed(1));
    if (p.kind === "dead" && u > 0.6) p.el.setAttribute("r", (3 * (1 - (u - 0.6) / 0.4)).toFixed(2));
  }
}

function frame(now) {
  if (st.sim && !document.hidden) {
    drawSpot(now);
    drawPnl(now);
    runSweep(now);
    runParticles(now);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// the close
// ---------------------------------------------------------------------------

let botCache = { seed: null, res: null };
function botsFor(seed) {
  if (botCache.seed === seed) return botCache.res;
  const m = st.sim && seed === st.sim.m.seed ? st.sim.m : makeMarket(seed);
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
    return `<div class="bar"><span>${labels[k]}</span><span class="t"><i style="left:${v >= 0 ? 50 : 50 - w}%;width:${w}%;background:${v >= 0 ? "var(--inkup)" : "var(--inkdown)"}"></i></span><span class="v ${cls(v)}">${money(v)}</span></div>`;
  }).join("");

  const days = Array.from({ length: 10 }, (_, d) => {
    const a = d * TICKS_PER_DAY, b = (d + 1) * TICKS_PER_DAY;
    let iv = 0; for (let k = a; k < b; k++) iv += m.iv[k];
    return { d: d + 1, rv: sim.realizedVol(a, b), iv: iv / TICKS_PER_DAY, regime: REGIMES[m.regime[d]].name };
  });
  const vmax = Math.max(...days.map((x) => Math.max(x.rv, x.iv)));
  const dayRows = days.map((x) => `<div class="bar"><span>D${x.d} ${x.regime}</span><span class="t vb">`
    + `<i style="left:0;width:${(x.iv / vmax) * 100}%;background:rgba(28,38,32,.25);top:0;bottom:6px"></i>`
    + `<i style="left:0;width:${(x.rv / vmax) * 100}%;background:var(--ink);top:7px;bottom:0"></i></span>`
    + `<span class="v">${pct(x.rv, 0)} / ${pct(x.iv, 0)}</span></div>`).join("");

  const clients = m.rfqs.map((q) => {
    const r = sim.rfq[q.id] || { choice: "missed" };
    const pos = r.position != null ? sim.positions[r.position] : null;
    const pl = pos ? pos.flow + (pos.settled ?? sim.mark(pos)) : 0;
    return `<tr><td>${when(q.tick)}</td><td>${q.side} ${q.qty}× ${q.K}${q.type[0].toUpperCase()}</td><td>${q.informed ? '<span class="down">knew vol</span>' : '<span class="dim">no edge</span>'}</td>`
      + `<td>${r.choice}${r.filled ? ", filled" : ""}</td><td class="${cls(pl)}">${pos ? money(pl) : "—"}</td></tr>`;
  }).join("");

  const lesson = smoothShare > 0.5
    ? `You ran the digital on call-spread smoothing for ${pct(smoothShare, 0)} of the game. The pathwise tape would have shown <strong>Δ = 0</strong> the whole time. The true delta peaked at <strong>${nf0.format(peak)} shares</strong> at ${when(peakK)}.`
    : `For ${pct(1 - smoothShare, 0)} of the game your screen said the digital had <strong>zero delta</strong>. The tape was faithful to the program: a step payoff has zero derivative almost everywhere. The true delta peaked at <strong>${nf0.format(peak)} shares</strong> at ${when(peakK)}. That is the "Where it loses" table in the README, with money on it.`;

  const ghostLine = st.ghost ? `<p>${esc(st.ghost.name)}'s ghost closed at <span class="${cls(st.ghost.sim.equity())}">${money(st.ghost.sim.equity())}</span>. You finished ${pnl >= st.ghost.sim.equity() ? "ahead" : "behind"} by ${money(Math.abs(pnl - st.ghost.sim.equity())).replace("+", "")}.</p>` : "";

  $("#endSheet").innerHTML = `
    <div class="ticket">
      <div class="hdr"><h4>Short Gamma desk · daily P&amp;L statement</h4><h4>${st.mode === "daily" ? `today's market ${DAILY}` : `practice ${esc(st.seed)}`} · D10 16:00</h4></div>
      <div class="final ${cls(pnl)}" id="finalNum">$0</div>
      <p>Spot closed at ${m.S[N_TICKS].toFixed(2)}. Realized vol ran ${pct(sim.realizedVol(0, N_TICKS))} against an average implied of ${pct(m.iv.reduce((a, b) => a + b, 0) / m.iv.length)}. ${tradeCount} hedge trades, $${nf0.format(sim.tcost)} in costs.</p>
      ${ghostLine}
      <div class="lesson">${lesson}</div>
      <div class="two">
        <div><h3>Where the money came from</h3><div class="bars">${bars}</div></div>
        <div><h3>Same market, three bots</h3><div class="bars" id="botBars"><p class="note">Running the bots on your market…</p></div></div>
      </div>
      <div class="two">
        <div><h3>Realized vs implied, by day</h3><div class="bars">${dayRows}</div><p class="note">Dark is what the market did, light is what it charged. The regime was hidden from you.</p></div>
        <div><h3>Achievements</h3><div class="ach" id="achList"></div><p class="note" id="postNote"></p></div>
      </div>
      <h3 style="margin-top:20px">Your clients, unmasked</h3>
      <div class="tbl clients"><table><thead><tr><th>When</th><th>Client</th><th>Knew?</th><th>You</th><th>P&amp;L</th></tr></thead><tbody>${clients}</tbody></table></div>
    </div>
    <div class="endcta">
      <button class="btn primary" id="againBtn">Practice a new market</button>
      ${st.mode === "daily" ? "" : '<button class="btn" id="dailyBtn">Trade today\'s market</button>'}
      <button class="btn" id="deskBtn">Back to the desk</button>
    </div>`;
  $("#endOv").hidden = false;
  $("#endOv").scrollTop = 0;
  renderAch();
  countUp($("#finalNum"), pnl, reduceMotion ? 0 : 1300, reduceMotion ? 0 : 700);
  setTimeout(() => {
    const bots = botsFor(st.seed);
    const tape = bots.find((b) => b.id === "aad");
    if (pnl > tape.pnl) unlock("beat", `You beat the bot that trusts the pathwise tape by ${money(pnl - tape.pnl).replace("+", "")}.`);
    const all = [...bots, { name: "You", blurb: "", pnl, me: true }].sort((a, b) => b.pnl - a.pnl);
    const mx = Math.max(1, ...all.map((b) => Math.abs(b.pnl)));
    $("#botBars").innerHTML = all.map((b) => {
      const w = (Math.abs(b.pnl) / mx) * 50;
      return `<div class="bar" title="${esc(b.blurb)}"><span style="${b.me ? "font-weight:600" : ""}">${esc(b.name)}</span><span class="t"><i style="left:${b.pnl >= 0 ? 50 : 50 - w}%;width:${w}%;background:${b.me ? "var(--jacket)" : "rgba(28,38,32,.45)"}"></i></span><span class="v ${cls(b.pnl)}">${money(b.pnl)}</span></div>`;
    }).join("") + `<p class="note">"Trusted the tape" delta-hedges every bar with the screen's Greeks, digital zero included. "Smoothed" does the same with h = 1.</p>`;
    renderAch();
    renderBoard();
  }, 80);
  saveRun(pnl);
  pushPresence();
}

function countUp(el, to, dur, delay) {
  if (!dur) { el.textContent = money(to); return; }
  const t0 = performance.now() + delay;
  const stepf = (now) => {
    const f = clamp((now - t0) / dur, 0, 1);
    el.textContent = money(to * ease(f));
    if (f < 1) requestAnimationFrame(stepf);
  };
  requestAnimationFrame(stepf);
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
      + `<span class="num ${cls(pr.pnl || 0)}">${pr.status === "lobby" ? "" : money(pr.pnl || 0)}</span></div>`;
  });
  const box = $("#peers");
  box.hidden = html.length === 0;
  box.innerHTML = html.length ? `<div class="peerhead">On the desk now · ${html.length}</div>` + html.join("") : "";
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

let boardRows = [];
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
  boardRows = rows;
  $("#boardRows").innerHTML = rows.map((r, i) => `<tr class="${r.bot ? "bot" : r.me ? "me" : ""}"><td>${i + 1}</td><td>${esc(r.name)}${r.bot ? ' <span class="dim">bot</span>' : ' <span class="badge">✓ replayed</span>'}</td>`
    + `<td class="num ${cls(r.pnl)}">${money(r.pnl)}</td><td>${r.log && !r.me ? `<button class="btn" data-ghost="${i}">Race</button>` : ""}</td></tr>`).join("")
    || `<tr><td class="empty">No runs posted for ${DAILY} yet. Finish today's market to post the first.</td></tr>`;
  const humans = rows.filter((r) => !r.bot).slice(0, 5);
  $("#startBoard").innerHTML = humans.length
    ? `<div class="tbl lb"><table><tbody>${humans.map((r, i) => `<tr class="${r.me ? "me" : ""}"><td>${i + 1}</td><td>${esc(r.name)}</td><td class="num ${cls(r.pnl)}">${money(r.pnl)}</td></tr>`).join("")}</tbody></table></div>`
    : `No runs posted for ${DAILY} yet.`;
  $("#startBoard").className = humans.length ? "" : "empty";
}

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
    } catch {
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
    all[run.seed] = (all[run.seed] || []).concat([{ pnl: run.pnl, log: run.log, at: run.at }]).sort((a, b) => b.pnl - a.pnl).slice(0, 5);
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

new ResizeObserver(() => document.documentElement.style.setProperty("--topH", `${$("#top").offsetHeight}px`)).observe($("#top"));

// keep a game across a republish: the run is (seed, log), so restore is a replay
function snapshot() {
  return st.sim && st.started ? { mode: st.mode, seed: st.seed, log: st.sim.log, k: st.sim.k, digital: st.digital, finished: st.finished } : {};
}

function boot(data) {
  colors();
  buildMeter();
  titleFlaps();
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
    st.view = null;
    $("#startOv").hidden = true;
    post(sim.k, "The page updated under you. Your game is restored from its trade log; press Resume.", "win");
    recompute(false);
    render(false);
    setRunning(false);
  }
  requestAnimationFrame(frame);
  connectOnline();
  setTimeout(() => { botsFor(DAILY); renderBoard(); }, 600);
}

const hot = window.claude?.hot;
if (hot && typeof hot.snapshot === "function") hot.snapshot(snapshot);
if (hot && typeof hot.ready === "function") hot.ready(boot);
else boot(hot?.data ?? {});
