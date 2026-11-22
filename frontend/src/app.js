// LoanTrack frontend - plain JavaScript, no framework, no CDN.
// It only ever talks to the backend over HTTP via /api (proxied by nginx); it never sees
// a database address or a credential.
"use strict";

const API = "/api";
const STATUSES = ["PENDING", "APPROVED", "REJECTED", "DISBURSED"];
const STATUS_LABEL = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected", DISBURSED: "Disbursed" };
const STATUS_COLOR = { PENDING: "--chart-1", APPROVED: "--chart-2", REJECTED: "--chart-3", DISBURSED: "--chart-4" };
const REFRESH_MS = 10_000;

// ---------------------------------------------------------------- formatting (Indian conventions)
const inr2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const int = new Intl.NumberFormat("en-IN");
const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
const relFmt = new Intl.RelativeTimeFormat("en-IN", { numeric: "auto" });

/** 4500000 -> "45 lakh", 81300000.5 -> "8.13 crore" */
function inWords(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  const trim = (x) => x.toFixed(2).replace(/\.?0+$/, "");
  if (n >= 1e7) return `${trim(n / 1e7)} crore`;
  if (n >= 1e5) return `${trim(n / 1e5)} lakh`;
  if (n >= 1e3) return `${trim(n / 1e3)} thousand`;
  return `${trim(n)} rupees`;
}

/** Short money for KPI tiles: ₹8.13 Cr, ₹45 L */
function compactINR(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const trim = (x) => x.toFixed(2).replace(/\.?0+$/, "");
  if (n >= 1e7) return `₹${trim(n / 1e7)} Cr`;
  if (n >= 1e5) return `₹${trim(n / 1e5)} L`;
  return inr0.format(n);
}

function relativeTime(iso) {
  const diffSec = (new Date(iso).getTime() - Date.now()) / 1000;
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, secs] of units) {
    if (Math.abs(diffSec) >= secs) return relFmt.format(Math.round(diffSec / secs), unit);
  }
  return "just now";
}

// ---------------------------------------------------------------- tiny DOM helper (textContent only, never innerHTML)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "style") Object.assign(el.style, value);
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
const SVG_NS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
// Theme tokens are stored as bare HSL components ("38 92% 50%"), shadcn-style.
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const statusColor = (st) => `hsl(${cssVar(STATUS_COLOR[st])})`;
function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

// ---------------------------------------------------------------- tabs with a sliding indicator
// Positions the pill behind the selected trigger; CSS transitions make it glide between tabs.
function moveIndicator(list) {
  const indicator = list.querySelector(".tabs-indicator");
  const active = list.querySelector('[aria-selected="true"]');
  if (!indicator || !active) return;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.transform = `translateX(${active.offsetLeft}px)`;
}

// Roving tabindex + arrow keys, as in the WAI-ARIA tabs pattern.
function tabKeyboard(list, onSelect) {
  list.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    onSelect(tabs[next]);
  });
}

function selectToolTab(tab) {
  const list = $("#tool-tabs");
  const hash = tab.id === "tab-replicas" ? "#served-by" : "";
  if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname + location.search);
  for (const t of list.querySelectorAll('[role="tab"]')) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  }
  moveIndicator(list);
}

// ---------------------------------------------------------------- card spotlight (cursor-following glow)
function initSpotlight() {
  for (const card of document.querySelectorAll(".spotlight")) {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  }
}

// ---------------------------------------------------------------- state
const state = {
  status: null,
  q: "",
  sort: "newest",
  loans: [],
  stats: null,
  knownIds: null,      // ids seen on the previous load, to highlight rows added elsewhere
  highlightId: null,   // id created from this browser
  replicas: new Map(), // backend instance -> number of responses
  kpi: { total: 0, count: 0, approval: 0, average: 0 },
};

// ---------------------------------------------------------------- API client
class ApiError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "Cannot reach the API");
  }
  trackReplica(response.headers.get("X-Served-By"), response.headers.get("X-App-Version"));
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.detail ?? response.statusText);
  return data;
}

// ---------------------------------------------------------------- animated bars
// Bars are rebuilt on every refresh; remembering each bar's last width lets it glide from
// there to the new value instead of collapsing to 0 and regrowing every 10 seconds.
const barWidths = new Map();
function barFill(key, percent) {
  const fill = h("span", { class: "fill", style: { width: `${barWidths.get(key) ?? 0}%` } });
  barWidths.set(key, percent);
  requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = `${percent}%`)));
  return fill;
}

// ---------------------------------------------------------------- replica tracker
function trackReplica(name, version) {
  if (!name) return;
  state.replicas.set(name, (state.replicas.get(name) ?? 0) + 1);
  const pill = $("#served-by");
  pill.textContent = version ? `${name} · ${version}` : name;
  pill.title = `Last response came from ${name}`;
  renderReplicas();
}

function renderReplicas() {
  const list = $("#replica-bars");
  const entries = [...state.replicas.entries()].sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0) || 1;
  list.replaceChildren(
    ...entries.map(([name, n]) => {
      const fill = barFill(`replica:${name}`, (n / total) * 100);
      return h("li", {}, h("span", { class: "name", title: name }, name), h("span", { class: "track" }, fill), h("span", { class: "amount" }, `${n} · ${Math.round((n / total) * 100)}%`));
    }),
  );
  if (!entries.length) list.append(h("li", { class: "hint" }, "No requests yet."));
}

// ---------------------------------------------------------------- toasts & banner
function toast(message, kind = "info") {
  const el = h("li", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, icon(kind === "error" ? "alert" : "check"), h("span", {}, message));
  $("#toasts").append(el);
  setTimeout(() => {
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, 4000);
}

function setBanner(message) {
  const banner = $("#error-banner");
  banner.hidden = !message;
  banner.querySelector(".alert-text").textContent = message ?? "";
}

// ---------------------------------------------------------------- readiness pill
async function checkReady() {
  const pill = $("#api-status");
  try {
    await api("/readyz");
    pill.dataset.state = "up";
    pill.querySelector(".label").textContent = "API ready";
    return true;
  } catch (err) {
    pill.dataset.state = "down";
    pill.querySelector(".label").textContent = err.status === 503 ? "Database unreachable" : "API unreachable";
    return false;
  }
}

// ---------------------------------------------------------------- KPIs with count-up
function animateNumber(el, from, to, format, ms = 700) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === to) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = format(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderKpis(stats) {
  const count = (st) => stats.by_status.find((b) => b.status === st)?.count ?? 0;
  const decided = count("APPROVED") + count("DISBURSED") + count("REJECTED");
  const approval = decided ? ((count("APPROVED") + count("DISBURSED")) / decided) * 100 : 0;
  const next = {
    total: Number(stats.total_amount),
    count: stats.total_count,
    approval,
    average: Number(stats.average_amount),
  };
  animateNumber($("#kpi-total"), state.kpi.total, next.total, compactINR);
  animateNumber($("#kpi-count"), state.kpi.count, next.count, (v) => int.format(Math.round(v)));
  animateNumber($("#kpi-approval"), state.kpi.approval, next.approval, (v) => `${v.toFixed(0)}%`);
  animateNumber($("#kpi-average"), state.kpi.average, next.average, compactINR);
  $("#kpi-total-words").textContent = inr2.format(next.total);
  $("#kpi-average-words").textContent = `≈ ${inWords(next.average)} per loan`;
  $("#kpi-pending").textContent = `${count("PENDING")} awaiting decision`;
  $("#kpi-approval-bar").style.width = `${approval}%`;
  state.kpi = next;
}

// ---------------------------------------------------------------- status donut, legend, chips
function renderStatusChart(stats) {
  const svg = $("#status-donut");
  const total = stats.total_count || 1;
  const r = 45;
  const circumference = 2 * Math.PI * r;
  const group = s("g", { transform: "rotate(-90 60 60)" });
  group.append(s("circle", { cx: 60, cy: 60, r, fill: "none", stroke: `hsl(${cssVar("--muted")})`, "stroke-width": 14 }));

  let offset = 0;
  for (const st of STATUSES) {
    const bucket = stats.by_status.find((b) => b.status === st);
    const n = bucket?.count ?? 0;
    if (!n) continue;
    const len = (n / total) * circumference;
    const slice = s("circle", {
      class: `slice${state.status === st ? " active" : ""}`,
      cx: 60, cy: 60, r,
      stroke: statusColor(st),
      "stroke-dasharray": `${Math.max(len - 1.5, 0.5)} ${circumference}`,
      "stroke-dashoffset": -offset,
      tabindex: 0,
      role: "button",
      "aria-label": `${STATUS_LABEL[st]}: ${n} loans`,
    });
    const title = s("title");
    title.textContent = `${STATUS_LABEL[st]} — ${n} loans, ${inr0.format(Number(bucket.total_amount))}`;
    slice.append(title);
    slice.addEventListener("click", () => setStatusFilter(state.status === st ? null : st));
    slice.addEventListener("keydown", (e) => e.key === "Enter" && setStatusFilter(state.status === st ? null : st));
    group.append(slice);
    offset += len;
  }
  const value = s("text", { x: 60, y: 60, "text-anchor": "middle", class: "center-value" });
  value.textContent = int.format(stats.total_count);
  const label = s("text", { x: 60, y: 73, "text-anchor": "middle", class: "center-label" });
  label.textContent = "loans";
  svg.replaceChildren(group, value, label);
  svg.classList.toggle("filtered", Boolean(state.status));

  $("#status-legend").replaceChildren(
    ...STATUSES.map((st) => {
      const bucket = stats.by_status.find((b) => b.status === st);
      return h(
        "li",
        { onclick: () => setStatusFilter(state.status === st ? null : st), title: "Filter the table" },
        h("span", { class: "swatch", style: { background: statusColor(st) } }),
        STATUS_LABEL[st],
        h("span", { class: "val" }, `${bucket?.count ?? 0} · ${compactINR(bucket?.total_amount ?? 0)}`),
      );
    }),
  );

  // Status filter rendered as a pill tab list; the indicator node is kept so it can glide.
  const list = $("#status-chips");
  const tab = (st, label, n) =>
    h(
      "button",
      {
        type: "button", role: "tab", class: "tabs-trigger", "data-status": st ?? "",
        "aria-selected": String(state.status === st), tabindex: state.status === st ? 0 : -1,
        onclick: () => setStatusFilter(st),
      },
      st ? h("span", { class: "swatch", style: { background: statusColor(st) } }) : null,
      label,
      h("span", { class: "count" }, n),
    );
  const hadFocus = list.contains(document.activeElement);
  list.replaceChildren(
    list.querySelector(".tabs-indicator") ?? h("span", { class: "tabs-indicator", "aria-hidden": "true" }),
    tab(null, "All", stats.total_count),
    ...STATUSES.map((st) => tab(st, STATUS_LABEL[st], stats.by_status.find((b) => b.status === st)?.count ?? 0)),
  );
  moveIndicator(list);
  if (hadFocus) list.querySelector('[aria-selected="true"]')?.focus();
}

function renderCityBars(stats) {
  const max = Math.max(...stats.top_cities.map((c) => Number(c.total_amount)), 1);
  $("#city-bars").replaceChildren(
    ...stats.top_cities.map((c) => {
      const fill = barFill(`city:${c.city}`, (Number(c.total_amount) / max) * 100);
      return h("li", { title: `${c.count} loan(s)` }, h("span", {}, c.city), h("span", { class: "track" }, fill), h("span", { class: "amount" }, compactINR(c.total_amount)));
    }),
  );
}

// ---------------------------------------------------------------- loans table
function avatarColor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return `hsl(${hash % 360} 52% 44%)`;
}
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");

function statusSelect(loan) {
  const select = h(
    "select",
    { class: `status-select status-${loan.status}`, "aria-label": `Status for ${loan.borrower_name}` },
    ...STATUSES.map((st) => h("option", { value: st, selected: st === loan.status }, STATUS_LABEL[st])),
  );
  select.addEventListener("change", () => changeStatus(loan, select));
  return select;
}

function loanRow(loan) {
  const created = new Date(loan.created_at);
  const row = h(
    "tr",
    { "data-id": loan.id },
    h(
      "td",
      {},
      h(
        "div",
        { class: "borrower" },
        h("span", { class: "avatar", style: { background: avatarColor(loan.borrower_name) }, "aria-hidden": "true" }, initials(loan.borrower_name)),
        h("div", {}, h("div", { class: "name" }, loan.borrower_name), h("div", { class: "city" }, loan.property_city ?? "City not given")),
      ),
    ),
    h("td", { class: "num" }, h("div", { class: "amount-main" }, inr2.format(Number(loan.loan_amount))), h("div", { class: "amount-words" }, inWords(loan.loan_amount))),
    h("td", {}, statusSelect(loan)),
    h("td", { class: "when", title: `${dateFmt.format(created)}, ${timeFmt.format(created)} IST` }, dateFmt.format(created), h("small", {}, relativeTime(loan.created_at))),
    h("td", { class: "num" }, h("button", { type: "button", class: "btn btn-outline btn-sm", onclick: () => useInEmi(loan), title: "Open in EMI calculator" }, icon("calc"), "EMI")),
  );
  const isNewElsewhere = state.knownIds && !state.knownIds.has(loan.id);
  if (loan.id === state.highlightId || isNewElsewhere) row.classList.add("fresh");
  return row;
}

function renderSkeleton() {
  $("#loan-rows").replaceChildren(
    ...Array.from({ length: 5 }, () => h("tr", { class: "skeleton" }, ...Array.from({ length: 5 }, () => h("td", {}, h("div")))))
  );
}

function renderLoans() {
  $("#loan-rows").replaceChildren(...state.loans.map(loanRow));
  $("#empty-state").hidden = state.loans.length > 0;
  $("#loan-count").textContent = `(${state.loans.length})`;
}

// ---------------------------------------------------------------- loading
let loadSeq = 0;
async function loadLoans() {
  const seq = ++loadSeq;
  const params = new URLSearchParams({ sort: state.sort });
  if (state.status) params.set("status", state.status);
  if (state.q) params.set("q", state.q);
  const data = await api(`/loans?${params}`);
  if (seq !== loadSeq) return; // a newer request (faster typing) already won
  state.loans = data.items;
  renderLoans();
  state.knownIds = new Set([...(state.knownIds ?? []), ...data.items.map((l) => l.id)]);
  state.highlightId = null;
}

async function loadStats() {
  state.stats = await api("/stats");
  renderKpis(state.stats);
  renderStatusChart(state.stats);
  renderCityBars(state.stats);
}

let refreshing = false;
async function refresh({ quiet = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  const button = $("#refresh");
  button.classList.add("spinning");
  try {
    await Promise.all([loadLoans(), loadStats()]);
    setBanner(null);
  } catch (err) {
    setBanner(err.status === 503 ? "The database is not reachable right now — showing the last data we had. Retrying automatically." : `Could not load loans: ${err.message}`);
    if (!quiet) toast(err.message, "error");
  } finally {
    refreshing = false;
    button.classList.remove("spinning");
    checkReady();
  }
}

function setStatusFilter(status) {
  state.status = status;
  if (state.stats) renderStatusChart(state.stats);
  loadLoans().catch((err) => toast(err.message, "error"));
}

async function changeStatus(loan, select) {
  const previous = loan.status;
  const next = select.value;
  select.className = `status-select status-${next}`;
  select.disabled = true;
  try {
    const updated = await api(`/loans/${loan.id}`, { method: "PATCH", body: { status: next } });
    Object.assign(loan, updated);
    toast(`${loan.borrower_name}: ${STATUS_LABEL[previous]} → ${STATUS_LABEL[next]}`);
    await loadStats();
    if (state.status && state.status !== next) await loadLoans();
  } catch (err) {
    select.value = previous;
    select.className = `status-select status-${previous}`;
    toast(`Could not update status: ${err.message}`, "error");
  } finally {
    select.disabled = false;
  }
}

// ---------------------------------------------------------------- EMI calculator
function emi(principal, annualRate, years) {
  const r = annualRate / 12 / 100;
  const n = years * 12;
  if (r === 0) return principal / n;
  const f = (1 + r) ** n;
  return (principal * r * f) / (f - 1);
}

function renderEmi() {
  const amount = Number($("#emi-amount").value);
  const rate = Number($("#emi-rate").value);
  const years = Number($("#emi-years").value);
  const monthly = emi(amount, rate, years);
  for (const slider of document.querySelectorAll("#emi-form .slider")) {
    const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
    slider.style.setProperty("--fill", `${pct}%`);
  }
  const total = monthly * years * 12;
  const interest = total - amount;
  $("#emi-amount-out").textContent = `${inr0.format(amount)} (${inWords(amount)})`;
  $("#emi-rate-out").textContent = `${rate.toFixed(2)}% p.a.`;
  $("#emi-years-out").textContent = `${years} ${years === 1 ? "year" : "years"}`;
  $("#emi-monthly").textContent = inr0.format(monthly);
  $("#emi-principal").textContent = compactINR(amount);
  $("#emi-interest").textContent = compactINR(interest);
  $("#emi-total").textContent = compactINR(total);
  $("#emi-split").style.width = `${(amount / total) * 100}%`;
  $("#emi-split").parentElement.title = `Principal ${Math.round((amount / total) * 100)}% · Interest ${Math.round((interest / total) * 100)}%`;
}

function useInEmi(loan) {
  const slider = $("#emi-amount");
  const amount = Math.min(Number(slider.max), Math.max(Number(slider.min), Number(loan.loan_amount)));
  slider.value = String(amount);
  $("#emi-for").textContent = `Showing EMI for ${loan.borrower_name} (${inr0.format(Number(loan.loan_amount))}).`;
  selectToolTab($("#tab-emi"));
  renderEmi();
  $("#tool-tabs").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------------------------------------------------------------- new-loan drawer
const dialog = $("#new-loan-dialog");
const form = $("#new-loan-form");

function normaliseAmount(raw) {
  const cleaned = raw.replace(/[₹,\s]/g, "");
  return /^\d+(\.\d{1,2})?$/.test(cleaned) ? cleaned : null;
}

function setFieldError(name, message) {
  const input = form.elements[name];
  const slot = form.querySelector(`[data-error-for="${name}"]`);
  if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
  if (slot) slot.textContent = message ?? "";
}

function validate() {
  let ok = true;
  const name = form.elements.borrower_name.value.trim().replace(/\s+/g, " ");
  if (name.length < 2) {
    setFieldError("borrower_name", "Enter the borrower's full name.");
    ok = false;
  } else setFieldError("borrower_name", null);
  const amount = normaliseAmount(form.elements.loan_amount.value);
  if (!amount || Number(amount) <= 0) {
    setFieldError("loan_amount", "Enter an amount in rupees, e.g. 56,00,000.");
    ok = false;
  } else if (amount.split(".")[0].length > 12) {
    setFieldError("loan_amount", "That is more than ₹1 lakh crore - please check the amount.");
    ok = false;
  } else setFieldError("loan_amount", null);
  return ok ? { borrower_name: name, loan_amount: amount } : null;
}

function openNewLoan() {
  form.reset();
  ["borrower_name", "loan_amount"].forEach((f) => setFieldError(f, null));
  $("#form-error").textContent = "";
  $("#amount-preview").textContent = " ";
  dialog.showModal();
  form.elements.borrower_name.focus();
}

function buildStatusSegment() {
  $("#status-segment").replaceChildren(
    ...STATUSES.map((st, i) =>
      h("label", { class: `status-${st}` }, h("input", { type: "radio", name: "status", value: st, checked: i === 0 }), STATUS_LABEL[st]),
    ),
  );
}

form.elements.loan_amount.addEventListener("input", (e) => {
  const amount = normaliseAmount(e.target.value);
  $("#amount-preview").textContent = amount && Number(amount) > 0 ? `${inr2.format(Number(amount))} · ${inWords(amount)}` : " ";
});
form.elements.loan_amount.addEventListener("blur", (e) => {
  const amount = normaliseAmount(e.target.value);
  if (amount) e.target.value = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(amount));
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const valid = validate();
  if (!valid) return;
  const payload = {
    ...valid,
    property_city: form.elements.property_city.value.trim() || null,
    status: form.elements.status.value || "PENDING",
  };
  const submit = $("#submit-loan");
  submit.disabled = true;
  submit.textContent = "Creating…";
  $("#form-error").textContent = "";
  try {
    const created = await api("/loans", { method: "POST", body: payload });
    dialog.close();
    state.highlightId = created.id;
    toast(`Loan for ${created.borrower_name} created — ${inr2.format(Number(created.loan_amount))}`);
    await refresh({ quiet: true });
  } catch (err) {
    if (err.status === 422 && Array.isArray(err.detail)) {
      for (const issue of err.detail) setFieldError(issue.loc?.at(-1), issue.msg);
      $("#form-error").textContent = "Please fix the highlighted fields.";
    } else {
      $("#form-error").textContent = err.message;
    }
  } finally {
    submit.disabled = false;
    submit.textContent = "Create loan";
  }
});

dialog.addEventListener("click", (e) => {
  if (e.target === dialog || e.target.closest("[data-close]")) dialog.close();
});

// ---------------------------------------------------------------- theme
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  if (state.stats) renderStatusChart(state.stats); // colours come from CSS variables
}
function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("loantrack-theme", next); } catch { /* storage may be blocked */ }
}

// ---------------------------------------------------------------- wiring
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function init() {
  try { applyTheme(localStorage.getItem("loantrack-theme")); } catch { /* ignore */ }
  buildStatusSegment();
  initSpotlight();
  const toolTabs = $("#tool-tabs");
  toolTabs.querySelectorAll('[role="tab"]').forEach((t) => t.addEventListener("click", () => selectToolTab(t)));
  tabKeyboard(toolTabs, selectToolTab);
  tabKeyboard($("#status-chips"), (t) => setStatusFilter(t.dataset.status || null));
  // Deep link: /#served-by opens the replica tracker (handy when demoing scaling).
  const openFromHash = () => selectToolTab(location.hash === "#served-by" ? $("#tab-replicas") : $("#tab-emi"));
  addEventListener("hashchange", openFromHash);
  requestAnimationFrame(openFromHash);
  addEventListener("resize", () => document.querySelectorAll(".tabs-list").forEach(moveIndicator));
  renderReplicas();
  renderEmi();
  renderSkeleton();

  $("#search").addEventListener("input", debounce((e) => {
    state.q = e.target.value.trim();
    loadLoans().catch((err) => toast(err.message, "error"));
  }, 250));
  $("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    loadLoans().catch((err) => toast(err.message, "error"));
  });
  $("#refresh").addEventListener("click", () => refresh());
  $("#open-new-loan").addEventListener("click", openNewLoan);
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#replica-reset").addEventListener("click", () => { state.replicas.clear(); renderReplicas(); });
  ["#emi-amount", "#emi-rate", "#emi-years"].forEach((id) => $(id).addEventListener("input", () => {
    if (id === "#emi-amount") $("#emi-for").textContent = "Drag the sliders, or press EMI on any row.";
    renderEmi();
  }));

  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest("input, select, textarea") || dialog.open;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
    else if (e.key.toLowerCase() === "n") { e.preventDefault(); openNewLoan(); }
    else if (e.key.toLowerCase() === "r") refresh();
    else if (e.key.toLowerCase() === "t") toggleTheme();
  });

  setInterval(() => {
    if ($("#auto-refresh").checked && document.visibilityState === "visible" && !dialog.open) refresh({ quiet: true });
  }, REFRESH_MS);

  refresh();
}

init();
