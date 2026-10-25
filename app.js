// Sortation & staging dashboard. Reads the STAGE sheet's tabs as public CSV and redraws every minute.
const SHEET_ID = "1NbAiRe6nfL54G_c0MmYiEUlPMY3KgVodw9IYkLoUWZ0";
const csvUrl = (gid) => `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
const TABS = {
  batch: "0",
  xdock: "979906507",
  staging: [
    ["mc_staging", "341797853"],
    ["mc_pending_staging", "1185436744"],
    ["mc_staging_summary", "1274872084"],
    ["mc_staging_history", "1490472776"],
  ],
};
// Names come from the NIM attendance sheet (CAIID01 tab): its IDs (MAK01980M) share their first 8 characters with the
// system usernames (mak01980mus), so that prefix links a username to a person.
const STAFF_URL = "https://docs.google.com/spreadsheets/d/1GaMh4GIfanzEvJYpbtvuVLpawERz_-kRzSrWyqovpXs/export?format=csv&gid=11379924";
const REFRESH_MS = 60000;
const ROW_LIMIT = 500;

const PAGE_TITLES = { batch: "السورتنج باتش", xdock: "السورتشن اكس دوك", staging: "الاستيدج", hourly: "تقرير بالساعة" };
const STATUS_LABELS = { pending: "بندينج", in_progress: "إن بروجرس", closed: "كلوز" };
const SHIFT_LABELS = { night: "ليل", morning: "صباحي", middle: "ميدل" };

const state = {
  batch: [],
  xdock: [],
  staging: [],
  staff: new Map(),
  loadedAt: null,
  batchWh: "main",
  batchShift: "all",
  batchStatus: "all",
  batchSearch: "",
  stagingWh: "all",
  hourlyWh: "main",
  hourlyDay: "",
  hourlyFrom: 0,
  hourlyTo: 23,
  ippKind: "batch",
  stagingSearch: "",
  xdockWh: "all",
  xdockDay: "all",
  xdockFrom: "",
  xdockTo: "",
  xdockStatus: "all",
  xdockSearch: "",
};

const $ = (id) => document.getElementById(id);
const fmt = (value) => new Intl.NumberFormat("en-US").format(Math.round(value || 0));
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (value) => {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// ---------- CSV ----------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Turns CSV rows into objects keyed by header, skipping the table's untitled "Column N" columns and blank rows.
function toRecords(rows) {
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const keep = headers.map((h, i) => (h && !/^Column \d+$/.test(h) ? i : -1)).filter((i) => i >= 0);
  const records = rows.slice(1)
    .filter((r) => keep.some((i) => (r[i] || "").trim() !== ""))
    .map((r) => Object.fromEntries(keep.map((i) => [headers[i], (r[i] || "").trim()])));
  return { headers: keep.map((i) => headers[i]), records };
}

// ---------- Time (all times are Cairo wall-clock, stored as UTC-based ms so the viewer's timezone never shifts them) ----------
function parseTime(text) {
  const s = String(text || "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +(m[6] || 0));
  return null;
}
function cairoNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
}
const hourOf = (ms) => new Date(ms).getUTCHours();
const clock = (ms) => (ms == null ? "" : new Date(ms).toISOString().slice(11, 16));
const dayClock = (ms) => (ms == null ? "" : `${new Date(ms).toISOString().slice(5, 10).replace("-", "/")} ${clock(ms)}`);
// Night 02–08, morning 08–17, middle 17–02 (by the time the work happened).
function shiftOf(ms) {
  const h = hourOf(ms);
  if (h >= 2 && h < 8) return "night";
  if (h >= 8 && h < 17) return "morning";
  return "middle";
}
function duration(minutes) {
  if (!(minutes > 0)) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h}س ${m}د` : `${m}د`;
}

// ---------- Load ----------
async function fetchCsv(gid) {
  const response = await fetch(`${csvUrl(gid)}&_=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (/^\s*<!doctype html|<html/i.test(text)) throw new Error("الشيت مش متاح للقراءة (لازم Anyone with the link — Viewer)");
  return toRecords(parseCsv(text));
}

function mapBatch(r) {
  return {
    job: r.job_nr, status: r.job_status, sortingType: r.sorting_type, wh: r.source_warehouse, pickingType: r.picking_type,
    zone: r.picking_zone, container: r.picking_container, pickingJob: r.picking_job_nr, sorter: r.sorter,
    total: num(r.total_qty), sorted: num(r.sorted_qty), pending: num(r.pending_qty), missing: num(r.missing_qty), skipped: num(r.skipped_qty),
    created: parseTime(r.job_created_at), started: parseTime(r.job_started_at), completed: parseTime(r.job_completed_at), target: parseTime(r.target_shipped_at),
    destCount: num(r.destination_containers), stores: (r.destination_stores || "").split("|").map((s) => s.trim()).filter(Boolean),
  };
}
function mapXdock(r) {
  const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    job: r.jobNr, container: r.container_barcode, asn: r.asn, wh: r.inbound_warehouse, status: r.job_status,
    created: parseTime(r.job_created_at), user: r.username, pbarcode: r.pbarcodes_in_job, started: parseTime(r.job_started_at),
    total: num(r.total_lines), notPut: num(r.not_put_away_lines), put: num(r.put_away_lines), skipped: num(r.skipped_lines),
    destContainers: list(r.destination_containers), pallets: list(r.destination_pallets), stores: num(r.stores_sorted_against),
  };
}

async function load() {
  const button = $("refreshButton");
  button.classList.add("spin");
  try {
    if (!state.staff.size) loadStaff();
    const [batch, xdock, ...staging] = await Promise.all([
      fetchCsv(TABS.batch),
      fetchCsv(TABS.xdock),
      ...TABS.staging.map(([, gid]) => fetchCsv(gid).catch((error) => ({ headers: [], records: [], error }))),
    ]);
    state.batch = batch.records.filter((r) => r.job_nr).map(mapBatch);
    state.xdock = xdock.records.filter((r) => r.jobNr).map(mapXdock);
    state.staging = TABS.staging.map(([name], i) => ({ name, ...staging[i] }));
    state.loadedAt = new Date();
    $("errorBanner").hidden = true;
    $("sourceDot").className = "source-dot ok";
    render();
  } catch (error) {
    $("errorBanner").hidden = false;
    $("errorBanner").textContent = `مقدرتش أقرا الشيت: ${error.message}. آخر داتا اتحملت لسه ظاهرة.`;
    $("sourceDot").className = "source-dot bad";
  } finally {
    button.classList.remove("spin");
    $("syncText").textContent = state.loadedAt
      ? `آخر تحديث ${state.loadedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
      : "مفيش داتا";
  }
}

// The staff list loads on its own so a slow attendance sheet never holds up the numbers; names fill in when it arrives.
async function loadStaff() {
  try {
    const response = await fetch(STAFF_URL, { cache: "no-store" });
    if (!response.ok) return;
    const rows = parseCsv(await response.text());
    const staff = new Map();
    for (const row of rows.slice(2)) {
      const id = String(row[0] || "").trim();
      if (!/^[A-Za-z]{3}\d{5}/.test(id)) continue;
      staff.set(id.slice(0, 8).toLowerCase(), { name: String(row[1] || "").trim().replace(/\s+/g, " "), sub: String(row[8] || "").trim(), shift: String(row[9] || "").trim() });
    }
    if (staff.size) { state.staff = staff; render(); }
  } catch (error) {}
}
const staffOf = (user) => state.staff.get(String(user || "").slice(0, 8).toLowerCase());
// A person's name with their username under it; the username alone when the attendance sheet does not have them.
const who = (user) => {
  if (!user) return "—";
  const person = staffOf(user);
  return person ? `<b>${esc(person.name)}</b><small class="who">${esc(user)}${person.sub ? ` · ${esc(person.sub)}` : ""}</small>` : `<b class="mono">${esc(user)}</b>`;
};

// ---------- Shared bits ----------
const kpi = (label, value, note, accent, fill) => `
  <div class="kpi" style="--accent:${accent}">
    <span>${label}</span><strong>${value}</strong><small>${note}</small>
    ${fill == null ? "" : `<div class="bar"><i style="width:${Math.min(100, fill).toFixed(1)}%"></i></div>`}
  </div>`;
// A card in Minutes Central's style: label, big number with an optional % pill, small chips, optional detail lines.
const mcCard = (label, value, percent, tone, chips = [], details = []) => `
  <div class="mc-card">
    <span class="mc-label">${label}</span>
    <div class="mc-value"><strong>${value}</strong>${percent == null ? "" : `<em class="mc-pill ${tone}">${Math.round(percent)}%</em>`}</div>
    ${chips.length ? `<div class="mc-chips">${chips.map((c) => `<span>${c}</span>`).join("")}</div>` : ""}
    ${details.length ? `<div class="mc-details">${details.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")}</div>` : ""}
  </div>`;
const badge = (status) => `<span class="badge ${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;
const pctCell = (value) => `<span class="pct"><i><b style="width:${Math.min(100, value).toFixed(0)}%"></b></i>${value.toFixed(0)}%</span>`;
const emptyRow = (cols, text = "مفيش داتا") => `<tbody><tr><td class="empty" colspan="${cols}">${text}</td></tr></tbody>`;
const head = (cells) => `<thead><tr>${cells.map((c) => (Array.isArray(c) ? `<th class="num">${c[0]}</th>` : `<th>${c}</th>`)).join("")}</tr></thead>`;

function downloadCsv(name, headers, rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = "﻿" + [headers, ...rows].map((r) => r.map(cell).join(",")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------- Sorting batch ----------
// Minutes Central's own selection (CAIID01, 02, 06) is the default view.
const MAIN_WH = ["CAIID01", "CAIID02", "CAIID06"];
function batchJobs() {
  return state.batch.filter((j) => state.batchWh === "all" || (state.batchWh === "main" ? MAIN_WH.includes(j.wh) : j.wh === state.batchWh));
}
const inShift = (ms) => ms != null && (state.batchShift === "all" || shiftOf(ms) === state.batchShift);

function renderBatch() {
  const select = $("batchWh");
  const warehouses = [...new Set(state.batch.map((j) => j.wh))].sort();
  if (state.batchWh !== "main" && !warehouses.includes(state.batchWh)) state.batchWh = "all";
  select.innerHTML = `<option value="main">${MAIN_WH.join("، ")}</option><option value="all">كل المخازن</option>${warehouses.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join("")}`;
  select.value = state.batchWh;

  const jobs = batchJobs();
  const by = (status) => jobs.filter((j) => j.status === status);
  const qty = (list) => list.reduce((s, j) => s + j.total, 0);
  const total = qty(jobs);
  const [pending, progress, closed] = ["pending", "in_progress", "closed"].map(by);

  // Same four cards as Minutes Central's Sorting Summary (PBs = picking containers).
  $("batchKpis").innerHTML = [
    mcCard("Pending Sorting Qty", total ? fmt(qty(pending)) : "0", pct(qty(pending), total), "bad", [`PBs: ${fmt(pending.length)}`]),
    mcCard("In Progress Qty", fmt(qty(progress)), null, "", [`PBs: ${fmt(progress.length)}`]),
    mcCard("Completed Qty", fmt(qty(closed)), pct(qty(closed), total), "good", [`PBs: ${fmt(closed.length)}`]),
    mcCard("Total Qty", fmt(total), null, "", [`PBs: ${fmt(jobs.length)}`]),
  ].join("");

  // Per warehouse
  const groups = new Map();
  for (const j of state.batch) {
    if (!groups.has(j.wh)) groups.set(j.wh, []);
    groups.get(j.wh).push(j);
  }
  const whRows = [...groups.entries()].sort((a, b) => qty(b[1]) - qty(a[1])).map(([wh, list]) => {
    const s = (status) => list.filter((j) => j.status === status);
    const t = qty(list);
    return { wh, count: list.length, t, p: s("pending"), ip: s("in_progress"), c: s("closed"), loss: list.reduce((a, j) => a + j.missing + j.skipped, 0),
      sorters: new Set(list.map((j) => j.sorter).filter(Boolean)).size, stores: new Set(list.flatMap((j) => j.stores)).size };
  });
  const cell = (list) => `${fmt(qty(list))} <span class="muted">(${list.length})</span>`;
  $("batchWhTable").innerHTML = whRows.length
    ? head(["المخزن", ["الكونتينرات"], ["الإجمالي"], ["بندينج"], ["إن بروجرس"], ["كلوز"], ["نسبة الإنجاز"], ["ناقص + سكيب"], ["سورترز"], ["فروع"]])
      + `<tbody>${whRows.map((r) => `<tr${r.wh === state.batchWh ? ' style="background:var(--row-hover)"' : ""}><td><b>${esc(r.wh)}</b></td><td class="num">${fmt(r.count)}</td><td class="num">${fmt(r.t)}</td>
        <td class="num">${cell(r.p)}</td><td class="num">${cell(r.ip)}</td><td class="num">${cell(r.c)}</td><td class="num">${pctCell(pct(qty(r.c), r.t))}</td>
        <td class="num">${fmt(r.loss)}</td><td class="num">${fmt(r.sorters)}</td><td class="num">${fmt(r.stores)}</td></tr>`).join("")}</tbody>`
      + `<tfoot><tr><td>الإجمالي</td><td class="num">${fmt(state.batch.length)}</td><td class="num">${fmt(qty(state.batch))}</td>
        <td class="num">${fmt(whRows.reduce((a, r) => a + qty(r.p), 0))}</td><td class="num">${fmt(whRows.reduce((a, r) => a + qty(r.ip), 0))}</td>
        <td class="num">${fmt(whRows.reduce((a, r) => a + qty(r.c), 0))}</td><td class="num">${pctCell(pct(whRows.reduce((a, r) => a + qty(r.c), 0), qty(state.batch)))}</td>
        <td class="num">${fmt(whRows.reduce((a, r) => a + r.loss, 0))}</td><td class="num">${fmt(new Set(state.batch.map((j) => j.sorter).filter(Boolean)).size)}</td>
        <td class="num">${fmt(new Set(state.batch.flatMap((j) => j.stores)).size)}</td></tr></tfoot>`
    : emptyRow(10);

  renderBatchHourly(jobs);
  renderBatchAging(jobs);
  renderBatchSorters(jobs);
  renderBatchList(jobs);
}

function renderBatchHourly(jobs) {
  const hours = new Map();
  for (const j of jobs) {
    if (j.status !== "closed" || !inShift(j.completed)) continue;
    const h = hourOf(j.completed);
    hours.set(h, (hours.get(h) || 0) + j.sorted);
  }
  if (!hours.size) { $("batchHourly").innerHTML = `<div class="empty" style="width:100%">مفيش جوبز اتقفلت في الشيفت ده</div>`; return; }
  const keys = [...hours.keys()];
  const from = Math.min(...keys);
  const to = Math.max(...keys);
  const max = Math.max(...hours.values());
  let html = "";
  for (let h = from; h <= to; h++) {
    const v = hours.get(h) || 0;
    const ms = Date.UTC(2000, 0, 1, h);
    html += `<div class="bar-col" title="${String(h).padStart(2, "0")}:00 — ${fmt(v)} قطعة"><em>${v ? fmt(v) : ""}</em><i class="${shiftOf(ms)}" style="height:${(v / max) * 85}%"></i><span>${String(h).padStart(2, "0")}</span></div>`;
  }
  $("batchHourly").innerHTML = html;
}

function renderBatchAging(jobs) {
  const now = cairoNow();
  const buckets = [["أقل من 30د", 0, 30], ["30–60د", 30, 60], ["1–2 ساعة", 60, 120], ["2–4 ساعات", 120, 240], ["أكتر من 4 ساعات", 240, Infinity]];
  const pending = jobs.filter((j) => j.status === "pending" && j.created != null);
  const groups = new Map();
  for (const j of pending) {
    if (!groups.has(j.wh)) groups.set(j.wh, { units: buckets.map(() => 0), oldest: Infinity });
    const g = groups.get(j.wh);
    const age = (now - j.created) / 60000;
    g.units[buckets.findIndex(([, a, b]) => age >= a && age < b)] += j.total;
    g.oldest = Math.min(g.oldest, j.created);
  }
  if (!groups.size) { $("batchAging").innerHTML = emptyRow(buckets.length + 2, "مفيش بندينج 👌"); return; }
  const cls = (i) => (i >= 3 ? "age-hot" : i === 2 ? "age-warm" : "");
  $("batchAging").innerHTML = head(["المخزن", ...buckets.map(([label]) => [label]), ["أقدم جوب"]])
    + `<tbody>${[...groups.entries()].sort((a, b) => a[1].oldest - b[1].oldest).map(([wh, g]) => `<tr><td><b>${esc(wh)}</b></td>
      ${g.units.map((u, i) => `<td class="num ${u ? cls(i) : "muted"}">${u ? fmt(u) : "—"}</td>`).join("")}
      <td class="num">${duration((now - g.oldest) / 60000)}</td></tr>`).join("")}</tbody>`;
}

function renderBatchSorters(jobs) {
  const people = new Map();
  const get = (name) => {
    if (!people.has(name)) people.set(name, { name, wh: new Set(), jobs: 0, units: 0, loss: 0, minutes: 0, first: Infinity, last: -Infinity, active: 0 });
    return people.get(name);
  };
  for (const j of jobs) {
    if (!j.sorter) continue;
    if (j.status === "in_progress") { get(j.sorter).active += 1; get(j.sorter).wh.add(j.wh); continue; }
    if (j.status !== "closed" || !inShift(j.completed)) continue;
    const p = get(j.sorter);
    p.wh.add(j.wh);
    p.jobs += 1;
    p.units += j.sorted;
    p.loss += j.missing + j.skipped;
    if (j.started != null && j.completed >= j.started) p.minutes += (j.completed - j.started) / 60000;
    p.first = Math.min(p.first, j.started ?? j.completed);
    p.last = Math.max(p.last, j.completed);
  }
  const rows = [...people.values()].sort((a, b) => b.units - a.units || b.active - a.active);
  if (!rows.length) { $("batchSorters").innerHTML = emptyRow(10); return; }
  $("batchSorters").innerHTML = head(["#", "السورتر", "المخزن", ["جوبز مقفولة"], ["قطع اتفرزت"], ["قطعة/ساعة"], ["وقت الشغل"], ["متوسط الجوب"], ["ناقص + سكيب"], "أول ← آخر", ["شغال دلوقتي"]])
    + `<tbody>${rows.map((p, i) => `<tr><td class="muted">${i + 1}</td><td>${who(p.name)}</td><td>${esc([...p.wh].sort().join("، "))}</td>
      <td class="num">${fmt(p.jobs)}</td><td class="num"><b>${fmt(p.units)}</b></td><td class="num">${p.minutes > 0 ? fmt(p.units / (p.minutes / 60)) : "—"}</td>
      <td class="num">${duration(p.minutes)}</td><td class="num">${p.jobs ? duration(p.minutes / p.jobs) : "—"}</td><td class="num ${p.loss ? "age-warm" : "muted"}">${fmt(p.loss)}</td>
      <td class="mono muted">${p.jobs ? `${clock(p.first)} ← ${clock(p.last)}` : "—"}</td><td class="num">${p.active ? `<span class="badge in_progress">${p.active}</span>` : "—"}</td></tr>`).join("")}</tbody>`;
}

const BATCH_COLUMNS = [
  ["الجوب", (j) => j.job], ["الحالة", (j) => j.status], ["المخزن", (j) => j.wh], ["نوع السورتنج", (j) => j.sortingType], ["البيكينج", (j) => j.pickingType],
  ["الزون", (j) => j.zone], ["كونتينر البيك", (j) => j.container], ["جوب البيك", (j) => j.pickingJob], ["السورتر", (j) => j.sorter],
  ["الإجمالي", (j) => j.total], ["اتفرز", (j) => j.sorted], ["باقي", (j) => j.pending], ["ناقص", (j) => j.missing], ["سكيب", (j) => j.skipped],
  ["كونتينرات الفروع", (j) => j.destCount], ["الفروع", (j) => j.stores.join(" | ")],
  ["اتعمل", (j) => dayClock(j.created)], ["بدأ", (j) => dayClock(j.started)], ["اتقفل", (j) => dayClock(j.completed)],
];
function filteredBatchList(jobs) {
  const q = state.batchSearch.toLowerCase();
  return jobs
    .filter((j) => state.batchStatus === "all" || j.status === state.batchStatus)
    .filter((j) => !q || [j.job, j.container, j.sorter, j.pickingJob, j.zone, ...j.stores].some((v) => String(v || "").toLowerCase().includes(q)))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
}
function renderBatchList(jobs) {
  const list = filteredBatchList(jobs);
  const shown = list.slice(0, ROW_LIMIT);
  const numeric = new Set([9, 10, 11, 12, 13, 14]);
  $("batchJobs").innerHTML = list.length
    ? head(BATCH_COLUMNS.map(([label], i) => (numeric.has(i) ? [label] : label)))
      + `<tbody>${shown.map((j) => `<tr><td class="mono">${esc(j.job)}</td><td>${badge(j.status)}</td><td>${esc(j.wh)}</td><td>${esc(j.sortingType)}</td><td>${esc(j.pickingType)}</td>
        <td>${esc(j.zone)}</td><td class="mono">${esc(j.container)}</td><td class="mono muted">${esc(j.pickingJob)}</td><td>${who(j.sorter)}</td>
        <td class="num">${fmt(j.total)}</td><td class="num">${fmt(j.sorted)}</td><td class="num">${fmt(j.pending)}</td><td class="num">${j.missing || "—"}</td><td class="num">${j.skipped || "—"}</td>
        <td class="num">${j.destCount || "—"}</td><td class="wrap muted">${esc(j.stores.join("، "))}</td>
        <td class="mono">${dayClock(j.created)}</td><td class="mono">${dayClock(j.started)}</td><td class="mono">${dayClock(j.completed)}</td></tr>`).join("")}</tbody>`
    : emptyRow(BATCH_COLUMNS.length);
  $("batchJobsFoot").textContent = list.length > ROW_LIMIT
    ? `ظاهر ${fmt(ROW_LIMIT)} من ${fmt(list.length)} جوب — نزّل Excel عشان تشوف الكل`
    : `${fmt(list.length)} جوب`;
}

// ---------- Cross dock ----------
const dayKey = (ms) => (ms == null ? "" : new Date(ms).toISOString().slice(0, 10));
// The time filter goes by when the job was created; a From later than To wraps past midnight.
function inXdockTime(j) {
  if (state.xdockDay === "all" && !state.xdockFrom && !state.xdockTo) return true;
  if (j.created == null) return false;
  if (state.xdockDay !== "all" && dayKey(j.created) !== state.xdockDay) return false;
  const t = clock(j.created);
  const from = state.xdockFrom || "00:00";
  const to = state.xdockTo || "23:59";
  return from <= to ? t >= from && t <= to : t >= from || t <= to;
}

function renderXdock() {
  const select = $("xdockWh");
  const warehouses = [...new Set(state.xdock.map((j) => j.wh))].sort();
  if (!warehouses.includes(state.xdockWh)) state.xdockWh = "all";
  select.innerHTML = `<option value="all">كل المخازن</option>${warehouses.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join("")}`;
  select.value = state.xdockWh;

  const days = [...new Set(state.xdock.map((j) => dayKey(j.created)).filter(Boolean))].sort().reverse();
  if (!days.includes(state.xdockDay)) state.xdockDay = "all";
  $("xdockDay").innerHTML = `<option value="all">كل الأيام</option>${days.map((d) => `<option value="${d}">${d.slice(5).replace("-", "/")}</option>`).join("")}`;
  $("xdockDay").value = state.xdockDay;

  const timed = state.xdock.filter(inXdockTime);
  const jobs = timed.filter((j) => state.xdockWh === "all" || j.wh === state.xdockWh);
  const sum = (list, key) => list.reduce((s, j) => s + j[key], 0);
  const lines = sum(jobs, "total");
  const put = sum(jobs, "put");

  const left = sum(jobs, "notPut");
  $("xdockKpis").innerHTML = [
    kpi("إجمالي الكمية", fmt(lines), "كل اللي وصل للاكس دوك", "var(--yellow)"),
    kpi("اتعمل", fmt(put), `${pct(put, lines).toFixed(0)}% من الإجمالي`, "var(--green)", pct(put, lines)),
    kpi("فاضل", fmt(left), `${pct(left, lines).toFixed(0)}% من الإجمالي`, "var(--amber)", pct(left, lines)),
  ].join("");

  // Per warehouse: done vs left, always for every warehouse so they can be compared side by side.
  const whGroups = new Map();
  for (const j of timed) {
    if (!whGroups.has(j.wh)) whGroups.set(j.wh, []);
    whGroups.get(j.wh).push(j);
  }
  const whRows = [...whGroups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([wh, list]) => {
    const s = (status) => list.filter((j) => j.status === status);
    return { wh, jobs: list.length, closed: s("closed").length, progress: s("in_progress").length, pending: s("pending").length,
      lines: sum(list, "total"), put: sum(list, "put"), left: sum(list, "notPut"), skipped: sum(list, "skipped") };
  });
  const whTotal = whRows.reduce((t, r) => { Object.keys(t).forEach((k) => { t[k] += r[k]; }); return t; },
    { jobs: 0, closed: 0, progress: 0, pending: 0, lines: 0, put: 0, left: 0, skipped: 0 });
  const whCells = (r) => `<td class="num">${fmt(r.lines)}</td><td class="num" style="color:var(--green)"><b>${fmt(r.put)}</b></td>
    <td class="num" style="color:var(--amber)"><b>${fmt(r.left)}</b></td><td class="num">${pctCell(pct(r.put, r.lines))}</td>`;
  $("xdockWhTable").innerHTML = whRows.length
    ? head(["المخزن", ["إجمالي الكمية"], ["اتعمل"], ["فاضل"], ["نسبة الإنجاز"]])
      + `<tbody>${whRows.map((r) => `<tr${r.wh === state.xdockWh ? ' style="background:var(--row-hover)"' : ""}><td><b>${esc(r.wh)}</b></td>${whCells(r)}</tr>`).join("")}</tbody>`
      + (whRows.length > 1 ? `<tfoot><tr><td>الإجمالي</td>${whCells(whTotal)}</tr></tfoot>` : "")
    : emptyRow(5);

  // Users
  const users = new Map();
  for (const j of jobs) {
    if (!j.user) continue;
    if (!users.has(j.user)) users.set(j.user, { user: j.user, closed: 0, active: 0, put: 0, skipped: 0, notPut: 0, first: Infinity });
    const u = users.get(j.user);
    if (j.status === "closed") u.closed += 1; else u.active += 1;
    u.put += j.put; u.skipped += j.skipped; u.notPut += j.notPut;
    if (j.started != null) u.first = Math.min(u.first, j.started);
  }
  const userRows = [...users.values()].sort((a, b) => b.put - a.put);
  $("xdockUsers").innerHTML = userRows.length
    ? head(["اليوزر", ["جوبز كلوز"], ["شغال دلوقتي"], ["لاينز اتحطت"], ["سكيب"], ["أول بداية"]])
      + `<tbody>${userRows.map((u) => `<tr><td>${who(u.user)}</td><td class="num">${fmt(u.closed)}</td>
        <td class="num">${u.active ? `<span class="badge in_progress">${u.active}</span>` : "—"}</td><td class="num"><b>${fmt(u.put)}</b></td>
        <td class="num ${u.skipped ? "age-warm" : "muted"}">${fmt(u.skipped)}</td><td class="mono">${Number.isFinite(u.first) ? dayClock(u.first) : "—"}</td></tr>`).join("")}</tbody>`
    : emptyRow(6);

  // ASN
  const asns = new Map();
  for (const j of jobs) {
    if (!asns.has(j.asn)) asns.set(j.asn, { asn: j.asn, pending: 0, progress: 0, closed: 0, lines: 0, put: 0, first: Infinity });
    const a = asns.get(j.asn);
    a[j.status === "in_progress" ? "progress" : j.status] += 1;
    a.lines += j.total; a.put += j.put;
    if (j.created != null) a.first = Math.min(a.first, j.created);
  }
  const asnRows = [...asns.values()].sort((a, b) => b.first - a.first);
  $("xdockAsn").innerHTML = asnRows.length
    ? head(["ASN", ["بندينج"], ["إن بروجرس"], ["كلوز"], ["لاينز"], ["اتحطت"], ["أول جوب"]])
      + `<tbody>${asnRows.map((a) => `<tr><td class="mono"><b>${esc(a.asn)}</b></td><td class="num">${a.pending || "—"}</td><td class="num">${a.progress || "—"}</td>
        <td class="num">${a.closed || "—"}</td><td class="num">${fmt(a.lines)}</td><td class="num">${pctCell(pct(a.put, a.lines))}</td>
        <td class="mono">${Number.isFinite(a.first) ? dayClock(a.first) : "—"}</td></tr>`).join("")}</tbody>`
    : emptyRow(7);

  // Jobs
  const q = state.xdockSearch.toLowerCase();
  const list = jobs
    .filter((j) => state.xdockStatus === "all" || j.status === state.xdockStatus)
    .filter((j) => !q || [j.job, j.container, j.asn, j.user, j.pbarcode, ...j.destContainers, ...j.pallets].some((v) => String(v || "").toLowerCase().includes(q)))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  $("xdockJobs").innerHTML = list.length
    ? head(["الجوب", "الحالة", "المخزن", "الكونتينر", "ASN", "اليوزر", "الباركود", ["لاينز"], ["اتحطت"], ["لسه"], ["سكيب"], ["كونتينرات الفروع"], ["بالتات"], ["فروع"], "اتعمل", "بدأ"])
      + `<tbody>${list.map((j) => `<tr><td class="mono">${esc(j.job)}</td><td>${badge(j.status)}</td><td>${esc(j.wh)}</td><td class="mono">${esc(j.container)}</td><td class="mono">${esc(j.asn)}</td>
        <td>${who(j.user)}</td><td class="mono muted">${esc(j.pbarcode)}</td><td class="num">${fmt(j.total)}</td><td class="num">${fmt(j.put)}</td>
        <td class="num">${j.notPut || "—"}</td><td class="num">${j.skipped || "—"}</td><td class="num" title="${esc(j.destContainers.join(", "))}">${j.destContainers.length || "—"}</td>
        <td class="num" title="${esc(j.pallets.join(", "))}">${j.pallets.length || "—"}</td><td class="num">${j.stores || "—"}</td>
        <td class="mono">${dayClock(j.created)}</td><td class="mono">${dayClock(j.started)}</td></tr>`).join("")}</tbody>`
    : emptyRow(16);
}

// ---------- Staging ----------
// From Minutes Central's Staging page: mc_staging has one row per staging location (what is already staged),
// mc_pending_staging has one row per tote still waiting in the drop zone (not staged yet).
function stagingData() {
  const [locations, pending, summary] = state.staging.map((tab) => tab.records || []);
  const wh = (r) => state.stagingWh === "all" || r.warehouse === state.stagingWh;
  return {
    summary: (summary || []).find((r) => r.scope === (state.stagingWh === "all" ? "ALL" : state.stagingWh)),
    locations: (locations || []).filter((r) => r.staging_location).map((r) => ({
      wh: r.warehouse, location: r.staging_location, store: r.darkstore_code, qty: num(r.staged_qty), totes: num(r.staged_totes),
      releaseQty: num(r.pending_release_qty), pallets: num(r.released_pallets),
    })),
    pending: (pending || []).filter((r) => r.tote).map((r) => ({
      wh: r.warehouse, tote: r.tote, store: r.darkstore_code, dropzone: r.dropzone_location, zone: r.picking_zone, by: r.dropped_by,
      at: parseTime(r.dropped_at), age: num(r.age_hours), qty: num(r.qty), suggested: r.suggested_staging_locations,
    })),
    inWh: wh,
  };
}
const qtyOf = (list) => list.reduce((s, r) => s + r.qty, 0);

function renderStaging() {
  const data = stagingData();
  const warehouses = [...new Set([...data.locations, ...data.pending].map((r) => r.wh).filter(Boolean))].sort();
  if (!warehouses.includes(state.stagingWh)) state.stagingWh = "all";
  $("stagingWh").innerHTML = `<option value="all">كل المخازن</option>${warehouses.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join("")}`;
  $("stagingWh").value = state.stagingWh;

  const locations = data.locations.filter(data.inWh);
  const pending = data.pending.filter(data.inWh);
  const done = qtyOf(locations);
  const left = qtyOf(pending);
  const total = done + left;
  // Same three cards as Minutes Central's Staging Summary, read from mc_staging_summary.
  const s = data.summary;
  const n = (key) => num(s && s[key]);
  $("stagingSummary").innerHTML = s
    ? [
      mcCard("Pending Release Qty", fmt(n("release_qty")), null, "", [`${fmt(n("release_ds"))} DS`, `${fmt(n("release_totes"))} Totes`],
        [["0–2 ساعة", fmt(n("release_0_2_qty"))], ["2–4 ساعات", fmt(n("release_2_4_qty"))], ["أكتر من 4", fmt(n("release_gt4_qty"))]]),
      mcCard("Pending Staging Qty", fmt(n("staging_qty")), null, "", [`${fmt(n("staging_ds"))} DS`, `${fmt(n("staging_totes"))} Totes`],
        [["0–2 ساعة", fmt(n("staging_0_2_qty"))], ["2–4 ساعات", fmt(n("staging_2_4_qty"))], ["أكتر من 4", fmt(n("staging_gt4_qty"))]]),
      // Staged so far today = the totes now in staging locations (Pending Release); out of those plus the ones still waiting.
      mcCard("Staged Totes · اتعمل استيدج", fmt(n("release_totes")), pct(n("release_totes"), n("release_totes") + n("staging_totes")), "good",
        [`من ${fmt(n("release_totes") + n("staging_totes"))} توت`, `فاضل ${fmt(n("staging_totes"))} توت`],
        [["اتعمل (قطع)", fmt(n("release_qty"))], ["فاضل (قطع)", fmt(n("staging_qty"))]]),
      mcCard("Expected Load", fmt(n("expected_load")), null, "", [],
        [["في السورتنج", fmt(n("load_in_sorting"))], ["في الدروب زون", fmt(n("load_in_dropzone"))], ["في البيكينج", fmt(n("load_in_picking"))]]),
    ].join("")
    : `<div class="empty">مفيش ملخص استيدج</div>`;
  $("stagingSummaryTime").textContent = s && s.updated_at ? `Minutes Central · ${s.updated_at}` : "";

  // Totes lead; quantities sit underneath. Staged totes are each location's count, left totes are one row each.
  const totesOf = (list) => list.reduce((s, r) => s + r.totes, 0);
  const doneTotes = totesOf(locations);
  const leftTotes = pending.length;
  const allTotes = doneTotes + leftTotes;
  $("stagingKpis").innerHTML = [
    kpi("إجمالي التوتات", fmt(allTotes), `${fmt(total)} قطعة · اللي اتعمل + اللي فاضل`, "var(--yellow)"),
    kpi("اتعمل استيدج (توتات)", fmt(doneTotes), `${pct(doneTotes, allTotes).toFixed(0)}% · ${fmt(done)} قطعة`, "var(--green)", pct(doneTotes, allTotes)),
    kpi("فاضل (توتات)", fmt(leftTotes), `${pct(leftTotes, allTotes).toFixed(0)}% · ${fmt(left)} قطعة`, "var(--amber)", pct(leftTotes, allTotes)),
  ].join("");

  // Per warehouse, always every warehouse so they can be compared.
  const cells = (locs, pend) => {
    const d = totesOf(locs);
    const l = pend.length;
    return `<td class="num">${fmt(d + l)}</td><td class="num" style="color:var(--green)"><b>${fmt(d)}</b></td>
    <td class="num" style="color:var(--amber)"><b>${fmt(l)}</b></td><td class="num">${pctCell(pct(d, d + l))}</td>
    <td class="num muted">${fmt(qtyOf(locs))}</td><td class="num muted">${fmt(qtyOf(pend))}</td>`;
  };
  $("stagingWhTable").innerHTML = warehouses.length
    ? head(["المخزن", ["إجمالي التوتات"], ["توتات اتعملت"], ["توتات فاضلة"], ["نسبة الإنجاز"], ["قطع اتعملت"], ["قطع فاضلة"]])
      + `<tbody>${warehouses.map((w) => `<tr${w === state.stagingWh ? ' style="background:var(--row-hover)"' : ""}><td><b>${esc(w)}</b></td>
        ${cells(data.locations.filter((r) => r.wh === w), data.pending.filter((r) => r.wh === w))}</tr>`).join("")}</tbody>`
      + (warehouses.length > 1 ? `<tfoot><tr><td>الإجمالي</td>${cells(data.locations, data.pending)}</tr></tfoot>` : "")
    : emptyRow(7, "لسه مفيش داتا استيدج");

  // Per store
  const stores = new Map();
  const store = (code) => {
    if (!stores.has(code)) stores.set(code, { code, done: 0, left: 0, oldest: 0 });
    return stores.get(code);
  };
  locations.forEach((r) => { store(r.store).done += r.qty; });
  pending.forEach((r) => { const s = store(r.store); s.left += r.qty; s.oldest = Math.max(s.oldest, r.age); });
  const storeRows = [...stores.values()].sort((a, b) => b.left - a.left || b.done - a.done);
  $("stagingStores").innerHTML = storeRows.length
    ? head(["الفرع", ["اتعمل"], ["فاضل"], ["نسبة الإنجاز"], ["أقدم فاضل"]])
      + `<tbody>${storeRows.map((s) => `<tr><td class="mono"><b>${esc(s.code)}</b></td><td class="num">${fmt(s.done)}</td>
        <td class="num" style="color:var(--amber)"><b>${s.left ? fmt(s.left) : "—"}</b></td><td class="num">${pctCell(pct(s.done, s.done + s.left))}</td>
        <td class="num ${s.oldest >= 4 ? "age-hot" : s.oldest >= 2 ? "age-warm" : ""}">${s.left ? duration(s.oldest * 60) : "—"}</td></tr>`).join("")}</tbody>`
    : emptyRow(5);

  // Pending aging, same buckets as Minutes Central's summary
  const buckets = [["أقل من ساعتين", 0, 2], ["2–4 ساعات", 2, 4], ["أكتر من 4 ساعات", 4, Infinity]];
  $("stagingAging").innerHTML = pending.length
    ? head(["المدة", ["الكمية الفاضلة"], ["النسبة"]])
      + `<tbody>${buckets.map(([label, a, b], i) => {
        const q = qtyOf(pending.filter((r) => r.age >= a && r.age < b));
        return `<tr><td>${label}</td><td class="num ${q && i === 2 ? "age-hot" : q && i === 1 ? "age-warm" : ""}"><b>${fmt(q)}</b></td><td class="num">${pctCell(pct(q, left))}</td></tr>`;
      }).join("")}</tbody>`
    : emptyRow(3, "مفيش حاجة فاضلة 👌");

  renderStagingList(pending);
}

function stagingList(pending) {
  const q = state.stagingSearch.toLowerCase();
  return pending
    .filter((t) => !q || [t.tote, t.store, t.by, t.zone, t.suggested].some((v) => String(v || "").toLowerCase().includes(q)))
    .sort((a, b) => b.age - a.age || b.qty - a.qty);
}
function renderStagingList(pending) {
  const list = stagingList(pending);
  $("stagingTotes").innerHTML = list.length
    ? head(["التوت", "المخزن", "الفرع", ["الكمية"], ["بقاله"], "اتحط في الدروب زون", "حطه", "زون البيك", "لوكيشن الاستيدج المقترح"])
      + `<tbody>${list.slice(0, ROW_LIMIT).map((t) => `<tr><td class="mono">${esc(t.tote)}</td><td>${esc(t.wh)}</td><td class="mono"><b>${esc(t.store)}</b></td>
        <td class="num"><b>${fmt(t.qty)}</b></td><td class="num ${t.age >= 4 ? "age-hot" : t.age >= 2 ? "age-warm" : ""}">${duration(t.age * 60)}</td>
        <td class="mono">${dayClock(t.at)}</td><td>${who(t.by)}</td><td class="muted">${esc(t.zone)}</td><td class="mono muted">${esc(t.suggested)}</td></tr>`).join("")}</tbody>`
    : emptyRow(9, "مفيش توتات فاضلة 👌");
  $("stagingFoot").textContent = list.length > ROW_LIMIT
    ? `ظاهر ${fmt(ROW_LIMIT)} من ${fmt(list.length)} توت — نزّل Excel عشان تشوف الكل`
    : `${fmt(list.length)} توت · ${fmt(qtyOf(list))} قطعة`;
}

// ---------- Hourly report ----------
// Sorting batch counts a closed job's sorted units in the hour it closed. The cross-dock report has no closing
// time, so its closed jobs count in the hour they started. Staging has no time per tote, so it comes from
// mc_staging_history: the hourly sync records how many totes are staged so far today, and each hour's
// staging is the rise since the previous snapshot.
const hourLabel = (h) => `${String(h).padStart(2, "0")}:00`;
const hourlyWhOk = (wh) => state.hourlyWh === "all" || (state.hourlyWh === "main" ? MAIN_WH.includes(wh) : wh === state.hourlyWh);
// The staging history is kept for Minutes Central's three warehouses, together (ALL) and one by one.
const stagingScope = () => (state.hourlyWh === "main" || state.hourlyWh === "all" ? "ALL" : MAIN_WH.includes(state.hourlyWh) ? state.hourlyWh : null);
function stagingSnapshots() {
  const scope = stagingScope();
  const history = (state.staging[3] && state.staging[3].records) || [];
  return history.filter((r) => r.scope === scope).map((r) => ({ at: parseTime(r.at), staged: num(r.staged_totes), left: num(r.pending_staging_totes) }))
    .filter((r) => r.at != null).sort((a, b) => a.at - b.at);
}
function hourlyRows() {
  const events = [
    ...state.batch.filter((j) => j.status === "closed" && j.completed != null && hourlyWhOk(j.wh))
      .map((j) => ({ at: j.completed, kind: "batch", qty: j.sorted })),
    ...state.xdock.filter((j) => j.status === "closed" && j.started != null && hourlyWhOk(j.wh))
      .map((j) => ({ at: j.started, kind: "xdock", qty: j.put })),
  ];
  const snapshots = stagingSnapshots();
  const days = [...new Set([...events.map((e) => dayKey(e.at)), ...snapshots.map((s) => dayKey(s.at))])].sort().reverse();
  if (!days.includes(state.hourlyDay)) state.hourlyDay = days[0] || "";
  const rows = Array.from({ length: 24 }, (_, h) => ({ h, batchJobs: 0, batchQty: 0, xdockJobs: 0, xdockQty: 0, staged: null, stagedTotal: null }));
  for (const e of events) {
    if (dayKey(e.at) !== state.hourlyDay) continue;
    const r = rows[hourOf(e.at)];
    if (e.kind === "batch") { r.batchJobs += 1; r.batchQty += e.qty; } else { r.xdockJobs += 1; r.xdockQty += e.qty; }
  }
  // The last snapshot in each hour is the staged-so-far count at that hour's end.
  let previous = 0;
  for (const s of snapshots.filter((x) => dayKey(x.at) === state.hourlyDay)) rows[hourOf(s.at)].stagedTotal = s.staged;
  for (const r of rows) {
    if (r.stagedTotal == null) continue;
    r.staged = Math.max(0, r.stagedTotal - previous);
    previous = r.stagedTotal;
  }
  const lo = Math.min(state.hourlyFrom, state.hourlyTo);
  const hi = Math.max(state.hourlyFrom, state.hourlyTo);
  return { days, rows: rows.filter((r) => r.h >= lo && r.h <= hi), snapshots };
}

function renderHourly() {
  const warehouses = [...new Set([...state.batch, ...state.xdock].map((j) => j.wh).filter(Boolean))].sort();
  if (state.hourlyWh !== "main" && state.hourlyWh !== "all" && !warehouses.includes(state.hourlyWh)) state.hourlyWh = "main";
  $("hourlyWh").innerHTML = `<option value="main">${MAIN_WH.join("، ")}</option><option value="all">كل المخازن</option>${warehouses.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join("")}`;
  $("hourlyWh").value = state.hourlyWh;
  const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${hourLabel(h)}</option>`).join("");
  if (!$("hourlyFrom").options.length) { $("hourlyFrom").innerHTML = hours; $("hourlyTo").innerHTML = hours; }
  $("hourlyFrom").value = state.hourlyFrom;
  $("hourlyTo").value = state.hourlyTo;

  const { days, rows, snapshots } = hourlyRows();
  $("hourlyDay").innerHTML = days.length ? days.map((d) => `<option value="${d}">${d.slice(5).replace("-", "/")}</option>`).join("") : `<option value="">—</option>`;
  $("hourlyDay").value = state.hourlyDay;

  const sum = (key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const lo = Math.min(state.hourlyFrom, state.hourlyTo);
  const hi = Math.max(state.hourlyFrom, state.hourlyTo);
  const range = lo === 0 && hi === 23 ? "اليوم كله" : `${hourLabel(lo)} → ${hourLabel((hi + 1) % 24)}`;
  $("hourlyTitle").textContent = `كل ساعة · ${range}`;

  // What is left is always the latest state; "out of" is what was done that day plus what is left.
  const batchJobs = state.batch.filter((j) => hourlyWhOk(j.wh));
  const batchOpen = batchJobs.filter((j) => j.status !== "closed");
  const batchLeft = batchOpen.reduce((s, j) => s + j.pending, 0);
  const batchDay = batchJobs.filter((j) => j.status === "closed" && dayKey(j.completed) === state.hourlyDay).reduce((s, j) => s + j.sorted, 0);
  const xdockJobs = state.xdock.filter((j) => hourlyWhOk(j.wh));
  const xdockOpen = xdockJobs.filter((j) => j.status !== "closed");
  const xdockLeft = xdockOpen.reduce((s, j) => s + j.notPut, 0);
  const xdockDay = xdockJobs.filter((j) => j.status === "closed" && dayKey(j.started) === state.hourlyDay).reduce((s, j) => s + j.put, 0);
  const latest = snapshots[snapshots.length - 1];
  const dayShots = snapshots.filter((s) => dayKey(s.at) === state.hourlyDay);
  const before = dayShots.filter((s) => hourOf(s.at) < lo).pop();
  const upTo = dayShots.filter((s) => hourOf(s.at) <= hi).pop();
  const stagedRange = upTo ? upTo.staged - (before ? before.staged : 0) : null;
  // With no snapshot before the chosen start hour, the count reaches back to midnight and cannot be split.
  const fromMidnight = upTo && !before && lo > 0;
  const stagedDay = dayShots.length ? dayShots[dayShots.length - 1].staged : 0;
  const stagingLeft = latest ? latest.left : 0;
  const card = (label, done, unit, left, dayDone, extra) => mcCard(label, done == null ? "—" : fmt(done), dayDone + left ? pct(dayDone, dayDone + left) : null, "good",
    [`فاضل دلوقتي: ${fmt(left)}`, `من ${fmt(dayDone + left)}`, range],
    [["اتعمل في الفترة", done == null ? "مفيش تسجيل" : `${fmt(done)} ${unit}`], ["اتعمل في اليوم كله", `${fmt(dayDone)} ${unit}`], ...extra]);
  $("hourlyKpis").innerHTML = [
    card("Sort Batch · قطع", sum("batchQty"), "قطعة", batchLeft, batchDay, [["PBs فاضلة", fmt(batchOpen.length)]]),
    card("Sort Cross Dock · لاينز", sum("xdockQty"), "لاين", xdockLeft, xdockDay, [["جوبز فاضلة", fmt(xdockOpen.length)]]),
    stagingScope()
      ? card("Staging · توتات", stagedRange, "توت", stagingLeft, stagedDay, [["آخر تسجيل", latest ? dayClock(latest.at) : "—"],
        ...(fromMidnight ? [["تنبيه", `محسوب من 12 بالليل، مفيش تسجيل قبل ${hourLabel(lo)}`]] : [])])
      : mcCard("Staging · توتات", "—", null, "", ["الاستيدج متسجل لـ CAIID01 و02 و06 بس"]),
  ].join("");

  const cell = (v) => (v ? fmt(v) : "—");
  $("hourlyTable").innerHTML = head(["الساعة", ["سورت باتش (قطع)"], ["PBs اتقفلت"], ["سورت اكس دوك (لاينز)"], ["جوبز اكس دوك"], ["استيدج (توتات)"], ["استيدج لحد الساعة دي"], "الشيفت"])
    + `<tbody>${rows.map((r) => `<tr><td class="mono"><b>${hourLabel(r.h)}</b></td>
      <td class="num"><b>${cell(r.batchQty)}</b></td><td class="num muted">${cell(r.batchJobs)}</td>
      <td class="num"><b>${cell(r.xdockQty)}</b></td><td class="num muted">${cell(r.xdockJobs)}</td>
      <td class="num"><b>${r.staged == null ? "—" : fmt(r.staged)}</b></td><td class="num muted">${r.stagedTotal == null ? "—" : fmt(r.stagedTotal)}</td>
      <td class="muted">${SHIFT_LABELS[shiftOf(Date.UTC(2000, 0, 1, r.h))]}</td></tr>`).join("")}</tbody>`
    + `<tfoot><tr><td>الإجمالي</td><td class="num">${fmt(sum("batchQty"))}</td><td class="num">${fmt(sum("batchJobs"))}</td>
      <td class="num">${fmt(sum("xdockQty"))}</td><td class="num">${fmt(sum("xdockJobs"))}</td><td class="num">${stagedRange == null ? "—" : fmt(stagedRange)}</td><td></td><td></td></tr></tfoot>`;
  renderIpp();
}

// IPP (items per person per hour) for the chosen day, hours and warehouse.
// Sorting batch: a person's hours are the union of their jobs' start→close spans, so jobs run side by side are not
// counted twice. Cross dock has no closing time, so each job is taken to last until the person's next job starts
// (at most 2 hours); a person's last job gets their average job length, or is left out of the hours when it is their only one.
function mergedMinutes(spans) {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let [start, end] = sorted[0] || [0, 0];
  for (const [a, b] of sorted.slice(1)) {
    if (a > end) { total += end - start; [start, end] = [a, b]; } else end = Math.max(end, b);
  }
  return sorted.length ? (total + end - start) / 60000 : 0;
}
function ippRows() {
  const whOk = (wh) => state.hourlyWh === "all" || (state.hourlyWh === "main" ? MAIN_WH.includes(wh) : wh === state.hourlyWh);
  const lo = Math.min(state.hourlyFrom, state.hourlyTo);
  const hi = Math.max(state.hourlyFrom, state.hourlyTo);
  const inRange = (ms) => ms != null && dayKey(ms) === state.hourlyDay && hourOf(ms) >= lo && hourOf(ms) <= hi;
  const people = new Map();
  const person = (name, wh) => {
    if (!people.has(name)) people.set(name, { name, wh: new Set(), jobs: 0, qty: 0, loss: 0, spans: [], first: Infinity, last: -Infinity });
    const p = people.get(name);
    p.wh.add(wh);
    return p;
  };
  if (state.ippKind === "batch") {
    for (const j of state.batch) {
      if (j.status !== "closed" || !j.sorter || !whOk(j.wh) || !inRange(j.completed)) continue;
      const p = person(j.sorter, j.wh);
      p.jobs += 1; p.qty += j.sorted; p.loss += j.missing + j.skipped;
      if (j.started != null) p.spans.push([j.started, j.completed]);
      p.first = Math.min(p.first, j.started ?? j.completed); p.last = Math.max(p.last, j.completed);
    }
  } else {
    const byUser = new Map();
    for (const j of state.xdock) {
      if (j.status !== "closed" || !j.user || j.started == null || !whOk(j.wh) || !inRange(j.started)) continue;
      if (!byUser.has(j.user)) byUser.set(j.user, []);
      byUser.get(j.user).push(j);
    }
    for (const [name, jobs] of byUser) {
      jobs.sort((a, b) => a.started - b.started);
      const gaps = jobs.slice(1).map((j, i) => j.started - jobs[i].started).filter((g) => g <= 2 * 3600000);
      const avg = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
      jobs.forEach((j, i) => {
        const p = person(name, j.wh);
        p.jobs += 1; p.qty += j.put; p.loss += j.skipped;
        const next = jobs[i + 1] ? jobs[i + 1].started : null;
        const end = next != null && next - j.started <= 2 * 3600000 ? next : j.started + avg;
        if (end > j.started) p.spans.push([j.started, end]);
        p.first = Math.min(p.first, j.started); p.last = Math.max(p.last, end);
      });
    }
  }
  return [...people.values()].map((p) => {
    const minutes = mergedMinutes(p.spans);
    return { ...p, minutes, ipp: minutes >= 5 ? p.qty / (minutes / 60) : null };
  }).sort((a, b) => (b.ipp ?? -1) - (a.ipp ?? -1) || b.qty - a.qty);
}
function renderIpp() {
  const rows = ippRows();
  const unit = state.ippKind === "batch" ? "قطع اتفرزت" : "لاينز اتحطت";
  $("ippNote").textContent = state.ippKind === "batch"
    ? "IPP = القطع اللي اتفرزت ÷ ساعات الشغل (من بداية كل جوب لقفله، من غير ما الجوبز اللي شغالة مع بعض تتحسب مرتين) · الجوبز المقفولة في الفترة المختارة"
    : "IPP تقريبي: تقرير الاكس دوك مافيهوش وقت القفل، فالجوب بيتحسب لحد ما الشخص يبدأ الجوب اللي بعده (بحد أقصى ساعتين) · الجوبز اللي بدأت في الفترة المختارة";
  const valid = rows.filter((r) => r.ipp != null);
  const totalQty = valid.reduce((s, r) => s + r.qty, 0);
  const totalHours = valid.reduce((s, r) => s + r.minutes, 0) / 60;
  $("ippTable").innerHTML = rows.length
    ? head(["#", "الشخص", "المخزن", ["جوبز"], [unit], ["ساعات الشغل"], ["IPP"], ["ناقص + سكيب"], "أول ← آخر"])
      + `<tbody>${rows.map((r, i) => `<tr><td class="muted">${i + 1}</td><td>${who(r.name)}</td><td>${esc([...r.wh].sort().join("، "))}</td>
        <td class="num">${fmt(r.jobs)}</td><td class="num">${fmt(r.qty)}</td><td class="num">${duration(r.minutes)}</td>
        <td class="num"><b style="color:var(--yellow)">${r.ipp == null ? "—" : fmt(r.ipp)}</b></td>
        <td class="num ${r.loss ? "age-warm" : "muted"}">${r.loss ? fmt(r.loss) : "—"}</td>
        <td class="mono muted">${clock(r.first)} ← ${clock(r.last)}</td></tr>`).join("")}</tbody>`
      + `<tfoot><tr><td></td><td>المتوسط</td><td></td><td class="num">${fmt(rows.reduce((s, r) => s + r.jobs, 0))}</td>
        <td class="num">${fmt(rows.reduce((s, r) => s + r.qty, 0))}</td><td class="num">${duration(totalHours * 60)}</td>
        <td class="num"><b>${totalHours ? fmt(totalQty / totalHours) : "—"}</b></td><td class="num">${fmt(rows.reduce((s, r) => s + r.loss, 0))}</td><td></td></tr></tfoot>`
    : emptyRow(9, "مفيش جوبز مقفولة في الفترة دي");
}

// ---------- Page switching & events ----------
function currentPage() {
  const page = location.hash.slice(1);
  return PAGE_TITLES[page] ? page : "batch";
}
function render() {
  const page = currentPage();
  document.querySelectorAll(".page").forEach((el) => { el.hidden = el.id !== `page-${page}`; });
  document.querySelectorAll(".nav-link").forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  $("pageTitle").textContent = PAGE_TITLES[page];
  if (page === "batch") renderBatch();
  else if (page === "xdock") renderXdock();
  else if (page === "hourly") renderHourly();
  else renderStaging();
}

function bindChips(id, key, attr) {
  $(id).addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state[key] = chip.dataset[attr];
    $(id).querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
    render();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindChips("batchShift", "batchShift", "shift");
  bindChips("batchStatus", "batchStatus", "status");
  bindChips("xdockStatus", "xdockStatus", "status");
  $("batchWh").addEventListener("change", (event) => { state.batchWh = event.target.value; render(); });
  bindChips("ippKind", "ippKind", "kind");
  $("ippExport").addEventListener("click", () => {
    downloadCsv(`ipp_${state.ippKind}_${state.hourlyDay}_${hourLabel(state.hourlyFrom)}-${hourLabel(state.hourlyTo)}.csv`.replace(/:/g, ""),
      ["person", "name", "warehouse", "jobs", state.ippKind === "batch" ? "qty_sorted" : "lines_put_away", "work_minutes", "ipp", "missing_skipped", "first", "last"],
      ippRows().map((r) => [r.name, (staffOf(r.name) || {}).name || "", [...r.wh].join(" "), r.jobs, r.qty, Math.round(r.minutes), r.ipp == null ? "" : Math.round(r.ipp), r.loss, clock(r.first), clock(r.last)]));
  });
  $("hourlyWh").addEventListener("change", (event) => { state.hourlyWh = event.target.value; render(); });
  $("hourlyDay").addEventListener("change", (event) => { state.hourlyDay = event.target.value; render(); });
  $("hourlyFrom").addEventListener("change", (event) => { state.hourlyFrom = Number(event.target.value); render(); });
  $("hourlyTo").addEventListener("change", (event) => { state.hourlyTo = Number(event.target.value); render(); });
  $("hourlyExport").addEventListener("click", () => {
    const { rows } = hourlyRows();
    downloadCsv(`hourly_${state.hourlyDay}_${hourLabel(state.hourlyFrom)}-${hourLabel(state.hourlyTo)}.csv`.replace(/:/g, ""),
      ["hour", "batch_qty_sorted", "batch_pbs_closed", "xdock_lines_put_away", "xdock_jobs", "staging_totes", "staging_totes_so_far"],
      rows.map((r) => [hourLabel(r.h), r.batchQty, r.batchJobs, r.xdockQty, r.xdockJobs, r.staged ?? "", r.stagedTotal ?? ""]));
  });
  $("stagingWh").addEventListener("change", (event) => { state.stagingWh = event.target.value; render(); });
  $("stagingSearch").addEventListener("input", (event) => {
    state.stagingSearch = event.target.value.trim();
    const data = stagingData();
    renderStagingList(data.pending.filter(data.inWh));
  });
  $("stagingExport").addEventListener("click", () => {
    const data = stagingData();
    downloadCsv(`pending_staging_${new Date().toISOString().slice(0, 10)}.csv`, ["tote", "warehouse", "store", "qty", "age_hours", "dropped_at", "dropped_by", "picking_zone", "suggested_staging_locations"],
      stagingList(data.pending.filter(data.inWh)).map((t) => [t.tote, t.wh, t.store, t.qty, t.age, dayClock(t.at), t.by, t.zone, t.suggested]));
  });
  $("xdockWh").addEventListener("change", (event) => { state.xdockWh = event.target.value; render(); });
  $("xdockDay").addEventListener("change", (event) => { state.xdockDay = event.target.value; render(); });
  $("xdockFrom").addEventListener("change", (event) => { state.xdockFrom = event.target.value; render(); });
  $("xdockTo").addEventListener("change", (event) => { state.xdockTo = event.target.value; render(); });
  $("xdockTimeReset").addEventListener("click", () => {
    state.xdockDay = "all"; state.xdockFrom = ""; state.xdockTo = "";
    $("xdockFrom").value = ""; $("xdockTo").value = "";
    render();
  });
  $("batchSearch").addEventListener("input", (event) => { state.batchSearch = event.target.value.trim(); renderBatchList(batchJobs()); });
  $("xdockSearch").addEventListener("input", (event) => { state.xdockSearch = event.target.value.trim(); renderXdock(); });
  $("batchExport").addEventListener("click", () => {
    const list = filteredBatchList(batchJobs());
    downloadCsv(`sorting_batch_${new Date().toISOString().slice(0, 10)}.csv`, BATCH_COLUMNS.map(([label]) => label), list.map((j) => BATCH_COLUMNS.map(([, get]) => get(j))));
  });
  $("xdockExport").addEventListener("click", () => {
    const cols = [["jobNr", "job"], ["inbound_warehouse", "wh"], ["container_barcode", "container"], ["asn", "asn"], ["job_status", "status"], ["username", "user"], ["pbarcodes_in_job", "pbarcode"],
      ["total_lines", "total"], ["put_away_lines", "put"], ["not_put_away_lines", "notPut"], ["skipped_lines", "skipped"], ["stores_sorted_against", "stores"]];
    downloadCsv(`sortation_xdock_${new Date().toISOString().slice(0, 10)}.csv`, [...cols.map(([h]) => h), "destination_containers", "destination_pallets", "job_created_at", "job_started_at"],
      state.xdock.filter((j) => inXdockTime(j) && (state.xdockWh === "all" || j.wh === state.xdockWh)).map((j) => [...cols.map(([, k]) => j[k]), j.destContainers.join(","), j.pallets.join(","), dayClock(j.created), dayClock(j.started)]));
  });
  $("refreshButton").addEventListener("click", load);
  $("themeButton").addEventListener("click", () => {
    const light = document.documentElement.dataset.theme !== "light";
    if (light) document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme;
    $("themeButton").textContent = light ? "☾" : "☀";
    try { localStorage.setItem("stageTheme", light ? "light" : "dark"); } catch (error) {}
  });
  if (document.documentElement.dataset.theme === "light") $("themeButton").textContent = "☾";
  window.addEventListener("hashchange", render);
  render();
  load();
  setInterval(load, REFRESH_MS);
});
