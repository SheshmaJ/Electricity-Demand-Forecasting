"use strict";
const $ = (id) => document.getElementById(id);
const all = (selector) => [...document.querySelectorAll(selector)];
const glyph = (name) => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const regions = ["California", "Texas", "New York"];
const codes = ["CAL", "TEX", "NY"];
const zones = ["Pacific time", "Central time", "Eastern time"];
const models = ["Seasonal naïve", "ETS", "ARIMA", "TSLM"];
const colors = ["#4673cf", "#168b77", "#8b59c7", "#bb6527"];
const defaults = {
  TRAIN_END: "2025-09-30", TEST_START: "2025-10-01", TEST_END: "2026-09-30",
  HORIZONS: [1, 7, 14], REGIONS: regions, CV_INITIAL: 1095, CV_STEP: 30,
  HOLDOUT_STEP: 7, HOLDOUT_LAST: "", MAX_MISSING: 1, CA_ANOMALY: false
};
const views = {
  overview: "Overview", data: "Data & cleaning", diagnostics: "Training diagnostics",
  models: "Forecast models", cv: "Cross-validation", holdout: "Final holdout",
  forecast: "Future forecasts", settings: "Shared settings", code: "Python / Quarto"
};
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => (
  {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]
));
const num = (value, digits = 1) => Number.isFinite(value) ? value.toLocaleString(undefined, {maximumFractionDigits: digits}) : "—";
const opt = (value, label = value) => '<option value="' + esc(value) + '">' + esc(label) + '</option>';
const dateText = (value) => new Date(value + "T12:00:00Z").toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric", timeZone:"UTC"});
const setOptions = (select, choices) => {
  const old = select.value;
  select.innerHTML = choices.map(value => opt(value)).join("");
  if (choices.includes(old)) select.value = old;
};
const sourceNames = new Map();
let cfg = structuredClone(defaults);
try { cfg = validate(JSON.parse(localStorage.getItem("ads506-settings") || "{}")); } catch {}
let mode = "file";
let busy = false;
let frozen = false;
let training = null;
let cv = null;
let holdout = null;
let future = null;
let codeFile = "grid_forecast.qmd";
let statusTimer;
let worker;
let nextId = 0;
const pending = new Map();
const diagnosticCache = new Map();

function validate(value) {
  const next = {...defaults, ...Object.fromEntries(Object.keys(defaults).filter(key => key in (value || {})).map(key => [key, value[key]]))};
  const isDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
  if (![next.TRAIN_END,next.TEST_START,next.TEST_END].every(isDate) ||
      !(next.TRAIN_END < next.TEST_START && next.TEST_START <= next.TEST_END))
    throw Error("Use valid dates with TRAIN_END < TEST_START ≤ TEST_END.");
  if (!Array.isArray(next.HORIZONS) || !next.HORIZONS.length ||
      next.HORIZONS.some(h => !Number.isInteger(h) || h < 1 || h > 60))
    throw Error("Enter whole-number horizons from 1 to 60.");
  next.HORIZONS = [...new Set(next.HORIZONS)].sort((a,b) => a-b);
  if (!Array.isArray(next.REGIONS) || !next.REGIONS.length || next.REGIONS.some(region => !regions.includes(region)))
    throw Error("Choose at least one supported region.");
  next.REGIONS = regions.filter(region => next.REGIONS.includes(region));
  if (next.HOLDOUT_LAST && (!isDate(next.HOLDOUT_LAST) || next.HOLDOUT_LAST < next.TRAIN_END || next.HOLDOUT_LAST >= next.TEST_END))
    throw Error("Set the latest origin from TRAIN_END through the day before TEST_END, or clear it.");
  for (const [key, min, max] of [["CV_INITIAL",56,20000],["CV_STEP",1,365],["HOLDOUT_STEP",1,365],["MAX_MISSING",0,6]]) {
    if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max)
      throw Error(key + " must be a whole number from " + min + " to " + max + ".");
  }
  next.CA_ANOMALY = next.CA_ANOMALY === true;
  return next;
}

function status(message, error = false, linger = false) {
  clearTimeout(statusTimer);
  const area = $("run-status");
  area.hidden = false;
  area.classList.toggle("error", error);
  area.textContent = message;
  if (!linger) statusTimer = setTimeout(() => { area.hidden = true; }, error ? 11000 : 4500);
}

function connectWorker() {
  worker = new Worker("worker.js");
  worker.onmessage = ({data}) => {
    if (data.progress) { status(data.progress, false, true); return; }
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(Error(data.error)); else task.resolve(data.result);
  };
  worker.onerror = () => {
    for (const {reject} of pending.values()) reject(Error("The Python worker stopped. Reload the Site to start a fresh session."));
    pending.clear();
  };
}
function send(action, params = {}, bytes = null) {
  if (!worker) connectWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    worker.postMessage({id, action, params, bytes}, bytes ? [bytes] : []);
  });
}
async function operation(message, work) {
  if (busy) return;
  busy = true;
  controls();
  status(message, false, true);
  try { await work(); }
  catch (error) { status(error.message, true); }
  finally { busy = false; controls(); }
}

function route() {
  const key = location.hash.slice(1);
  const view = Object.hasOwn(views, key) ? key : "overview";
  for (const section of all(".view")) section.hidden = section.id !== view;
  for (const link of all("[data-nav]")) {
    const active = link.dataset.nav === view;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  $("crumb").textContent = views[view];
  if (view === "code" && !$("code-content").textContent) loadCode(codeFile);
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

function fillSettings() {
  const fields = $("settings-form").elements;
  $("region-settings").innerHTML = regions.map(region => '<label class="tick"><input name="REGIONS" type="checkbox" value="' +
    esc(region) + '"' + (cfg.REGIONS.includes(region) ? " checked" : "") + '> ' + esc(region) + "</label>").join("");
  for (const [key, value] of Object.entries(cfg)) {
    if (key === "REGIONS") continue;
    if (key === "CA_ANOMALY") fields[key].checked = value;
    else fields[key].value = Array.isArray(value) ? value.join(", ") : value;
  }
  setOptions($("clean-region"), cfg.REGIONS);
  setOptions($("diag-region"), cfg.REGIONS);
  setOptions($("forecast-region"), cfg.REGIONS);
  const horizon = $("forecast-horizon");
  const previous = Number(horizon.value);
  horizon.innerHTML = cfg.HORIZONS.map(days => opt(days, days + (days === 1 ? " day" : " days"))).join("");
  horizon.value = cfg.HORIZONS.includes(previous) ? previous : cfg.HORIZONS.at(-1);
}
function updateSettings(value) {
  if (frozen || busy) return;
  cfg = validate(value);
  try { localStorage.setItem("ads506-settings", JSON.stringify(cfg)); } catch {}
  fillSettings();
  invalidate();
  controls();
}
function invalidate() {
  training = null; cv = null; holdout = null;
  clearForecast();
  diagnosticCache.clear();
  $("clean-output").hidden = true;
  $("diag-output").className = "empty";
  $("diag-output").innerHTML = 'Build daily averages in <a href="#data">Data &amp; cleaning</a> to begin.';
  $("cv-output").className = "card wide empty";
  $("cv-output").textContent = "Build daily averages, then run training CV to compare the four candidates.";
  $("holdout-output").hidden = true;
  $("freeze-confirm").checked = false;
}
function controls() {
  $("region-cards").innerHTML = regions.map((r, i) => '<div class="region-card ' + (sourceNames.has(r) ? "loaded" : "") + '"><span class="region-code">' + codes[i] + '</span><div class="region-name"><strong>' + r + '</strong><small>' + zones[i] + '</small></div><span class="tiny-dot" title="' + (sourceNames.has(r) ? "Source loaded" : "Awaiting source") + '"></span></div>').join("");
  $("sources").innerHTML = regions.map((r,i) => {
    const loaded = sourceNames.has(r);
    return '<div class="source-row"><span class="region-code">' + codes[i] + '</span><div><strong>' + r + '</strong><small>' +
      esc(sourceNames.get(r) || "Awaiting hourly input") + '</small></div><span class="badge">' +
      (cfg.REGIONS.includes(r) ? (loaded ? "Loaded" : "Required") : "Optional") + '</span></div>';
  }).join("");
  const missing = cfg.REGIONS.filter(r => !sourceNames.has(r));
  $("clean-note").textContent = missing.length ? "Still needed: " + missing.join(", ") : "Sources ready for the selected regions.";
  for (const node of all("#import-form input,#import-form select,#import-form textarea,#import-form button,#settings-form input,#settings-form button,[data-demo],#settings-import"))
    node.disabled = busy || frozen;
  $("clean-button").disabled = busy || frozen || missing.length > 0;
  $("diag-button").disabled = busy || frozen || !training;
  $("cv-button").disabled = busy || frozen || !training;
  $("gate-review").hidden = !cv || frozen;
  $("forecast-next").hidden = !holdout;
  $("forecast-gate").hidden = !!holdout;
  for (const id of ["forecast-button", "forecast-region", "forecast-horizon"])
    $(id).disabled = busy || !holdout;
  $("holdout-button").disabled = busy || !cv || (!!holdout || (!frozen && !$("freeze-confirm").checked));
  $("holdout-button").textContent = holdout ? "Evaluation complete" : frozen ? "Retry frozen evaluation" : "Freeze & evaluate";
  const label = frozen ? "Run frozen" : "Holdout sealed";
  for (const id of ["lock-state","holdout-badge"]) $(id).innerHTML = glyph("lock") + label;
  $("gate-title").textContent = holdout ? "Final evaluation complete" : frozen ? "Specifications frozen" : cv ? "Ready for final evaluation" : "Holdout is sealed";
  $("gate-description").textContent = holdout
    ? "Settings, cleaning rules, and model structures are frozen. Reload for a fresh run."
    : frozen ? "Retry uses the same configuration and model specifications."
      : cv ? "The Site keeps the CV winners and evaluates all four fixed candidates on paired targets."
        : "Run training cross-validation and review the regional winners before opening final evaluation.";
  $("protocol-dates").textContent = "Training through " + dateText(cfg.TRAIN_END) +
    " · Holdout " + dateText(cfg.TEST_START) + " – " + dateText(cfg.TEST_END) +
    " · Horizons " + cfg.HORIZONS.join(", ") + " days";
  $("cv-plan").textContent = "Initial window " + cfg.CV_INITIAL.toLocaleString() + " days · Step " + cfg.CV_STEP +
    " days · Forecast leads 1–" + cfg.HORIZONS.at(-1) + " · Selected horizons " + cfg.HORIZONS.join(", ") + " days";
  $("holdout-plan").textContent = dateText(cfg.TEST_START) + " – " + dateText(cfg.TEST_END) + " · " +
    cfg.HOLDOUT_STEP + "-day origin step · Only targets inside the window are scored.";
}
function download(name, content, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvText(rows, columns) {
  const quote = (value) => '"' + String(value ?? "").replace(/"/g, '""') + '"';
  return [columns.map(quote).join(","), ...rows.map(row => columns.map(key => quote(row[key])).join(","))].join("\n");
}

function table(container, rows, columns, limit = rows.length) {
  if (!rows.length) {
    container.innerHTML = '<div class="empty">No matching rows.</div>';
    return;
  }
  let sortKey = "", descending = false;
  const render = () => {
    const sorted = sortKey ? [...rows].sort((a,b) => {
      const x = a[sortKey], y = b[sortKey];
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x-y : String(x).localeCompare(String(y))) * (descending ? -1 : 1);
    }) : rows;
    container.innerHTML = '<div class="table-wrap"><table><thead><tr>' + columns.map(([key,label]) =>
      '<th scope="col" aria-sort="' + (sortKey === key ? (descending ? "descending" : "ascending") : "none") + '"><button type="button" data-sort="' +
      esc(key) + '">' + esc(label) + (sortKey === key ? (descending ? " ↓" : " ↑") : "") + '</button></th>').join("") +
      '</tr></thead><tbody>' + sorted.slice(0,limit).map(row => "<tr>" + columns.map(([key, , format]) =>
        "<td>" + (format ? format(row[key], row) : esc(row[key] ?? "—")) + "</td>").join("") + "</tr>").join("") +
      "</tbody></table></div>" + (rows.length > limit ? '<p class="metric-note">Showing ' + limit + ' of ' + rows.length + ' rows.</p>' : "");
    for (const button of container.querySelectorAll("[data-sort]")) button.onclick = () => {
      const key = button.dataset.sort;
      descending = sortKey === key && !descending;
      sortKey = key;
      render();
      container.querySelector('[data-sort="' + key + '"]').focus();
    };
  };
  render();
}

function chart(container, title, labels, series, options = {}) {
  if (!labels.length) { container.innerHTML = '<div class="empty">No data to plot.</div>'; return; }
  const width = 720, height = options.short ? 153 : 235;
  const left = 62, right = width - 16, top = 13, bottom = height - 28;
  const values = series.flatMap(s => s.values.filter(Number.isFinite));
  if (!values.length) { container.innerHTML = '<div class="empty">No finite values to plot.</div>'; return; }
  let minimum = Math.min(...values, ...(options.bars ? [0] : []));
  let maximum = Math.max(...values, ...(options.bars ? [0] : []));
  if (options.correlation) { minimum = -1; maximum = 1; }
  else {
    const padding = (maximum - minimum || Math.abs(maximum) || 1) * .08;
    minimum -= padding; maximum += padding;
  }
  const x = i => left + (i + (options.bars ? .5 : 0)) * (right-left) / Math.max(1, labels.length - (options.bars ? 0 : 1));
  const y = value => bottom - (value-minimum) * (bottom-top)/(maximum-minimum);
  const ticks = Array.from({length:5}, (_,i) => minimum + (maximum-minimum)*i/4);
  const xTicks = [...new Set(Array.from({length: Math.min(6, labels.length)}, (_,i,arr) => i))];
  const positions = xTicks.map(i => Math.round(i*(labels.length-1)/Math.max(1,xTicks.length-1)));
  let graph = ticks.map(v => '<line class="axis" x1="' + left + '" x2="' + right + '" y1="' + y(v) + '" y2="' + y(v) +
    '"/><text x="' + (left-7) + '" y="' + (y(v)+4) + '" text-anchor="end">' + esc(num(v, 2)) + '</text>').join("");
  if (Number.isInteger(options.forecastFrom)) {
    const boundary = x(options.forecastFrom);
    graph += '<rect x="' + boundary + '" y="' + top + '" width="' + (right-boundary) + '" height="' + (bottom-top) + '" fill="#dcf7ed" opacity=".68" stroke="none"/>';
    graph += '<line x1="' + boundary + '" x2="' + boundary + '" y1="' + top + '" y2="' + bottom + '" stroke="#527c70" stroke-dasharray="4 4"/>';
  }
  if (options.correlation) {
    for (const boundary of [-options.correlation, options.correlation])
      graph += '<line stroke="#8b9db5" stroke-dasharray="4 4" x1="' + left + '" x2="' + right + '" y1="' + y(boundary) + '" y2="' + y(boundary) + '"/>';
  }
  graph += positions.map((i,j) => '<text x="' + x(i) + '" y="' + (height-8) + '" text-anchor="' +
    (j === 0 ? "start" : j === positions.length-1 ? "end" : "middle") + '">' + esc(labels[i]) + '</text>').join("");
  for (const [sIndex, s] of series.entries()) {
    if (options.bars) {
      const group = (right-left)/labels.length, bw = Math.min(28, group*.77/series.length);
      for (const [i,value] of s.values.entries()) {
        if (!Number.isFinite(value)) continue;
        graph += '<rect stroke="none" x="' + (x(i) + (sIndex-(series.length-1)/2)*bw-bw*.43) +
          '" y="' + Math.min(y(value),y(0)) + '" width="' + (bw*.86) + '" height="' + Math.max(.55, Math.abs(y(value)-y(0))) + '" fill="' + s.color + '"/>';
      }
    } else {
      let last = false;
      const path = s.values.map((v,i) => {
        if (!Number.isFinite(v)) { last = false; return ""; }
        const point = (last ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1);
        last = true;
        return point;
      }).join("");
      graph += '<path class="line" stroke="' + s.color + '"' + (s.dashed ? ' stroke-dasharray="6 4"' : "") + ' d="' + path + '"/>';
    }
  }
  container.innerHTML = '<div class="chart"><svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' +
    esc(title) + '">' + graph + '<line class="cursor" stroke="#6d86a8" stroke-dasharray="3 4" x1="' + x(0) + '" x2="' + x(0) +
    '" y1="' + top + '" y2="' + bottom + '"/></svg><div class="chart-caption"></div><input class="chart-range" type="range" min="0" max="' +
    (labels.length-1) + '" value="0" aria-label="' + esc(title + " position") + '"></div>';
  const svg = container.querySelector("svg"), range = container.querySelector("input");
  const cursor = container.querySelector(".cursor"), caption = container.querySelector(".chart-caption");
  const highlight = (i) => {
    range.value = i;
    const detail = labels[i] + " · " + series.map(s => s.name + " " + num(s.values[i], options.digits ?? 2)).join(" · ");
    range.setAttribute("aria-valuetext", detail);
    cursor.setAttribute("x1", x(i)); cursor.setAttribute("x2", x(i));
    caption.textContent = detail;
  };
  highlight(options.forecastFrom ?? 0);
  range.oninput = () => highlight(Number(range.value));
  svg.onpointermove = event => {
    const box = svg.getBoundingClientRect();
    const offset = ((event.clientX-box.left)*width/box.width-left)/(right-left);
    const i = options.bars ? Math.floor(offset*labels.length) : Math.round(offset*(labels.length-1));
    highlight(Math.max(0,Math.min(labels.length-1,i)));
  };
}

function renderTraining() {
  if (!training) return;
  const region = $("clean-region").value;
  const data = training[region];
  const valid = data.daily.filter(([,mw]) => Number.isFinite(mw));
  $("training-stats").textContent = valid.length.toLocaleString() + " observed days · " +
    (data.daily.length-valid.length).toLocaleString() + " excluded days · " +
    dateText(valid[0][0]) + " – " + dateText(valid.at(-1)[0]);
  chart($("training-chart"), region + " training demand", data.daily.map(row => row[0]),
    [{name:"Daily mean MW",color:colors[0],values:data.daily.map(row => row[1])}]);
  renderAudit();
}
function renderAudit() {
  if (!training) return;
  const audit = training[$("clean-region").value].audit;
  const filter = $("audit-filter").value;
  const rows = audit.filter(r => filter === "All flags" ||
    (filter === "DST" && r.expected !== 24) ||
    (filter === "Missing or duplicate" && (r.missing || r.duplicates)) ||
    (filter === "Demand anomaly" && (r.reviewed || r.unusual)));
  table($("audit-table"), rows, [["date","Local date"],["expected","Expected hours"],["valid","Valid hours"],
    ["missing","Missing hours"],["invalid","Invalid"],["duplicates","Duplicates"],["conflicts","Conflicting hours"],["reviewed","CA rule"],["unusual","Unusual"],["status","Day status"]], 400);
}
function renderDiagnostics() {
  const region = $("diag-region").value;
  const data = diagnosticCache.get(region);
  const target = $("diag-output");
  if (!data || !data.dates) {
    target.className = "empty";
    target.textContent = data ? "Diagnostics need at least 28 days and a nonconstant training series." :
      "Run diagnostics for " + region + ".";
    return;
  }
  target.className = "";
  target.innerHTML = '<h3>Weekly STL · seasonal strength ' + esc(num(data.strength,3)) + '</h3>' +
    '<div class="diag-grid"><div data-plot="trend"></div><div data-plot="seasonal"></div><div data-plot="resid"></div></div>' +
    '<div class="inline-head"><div><h3>Autocorrelation and stationarity</h3><p class="muted">Dashed lines are approximate white-noise bounds. ADF and KPSS p-values use opposite null hypotheses.</p></div>' +
    '<label class="compact">Series<select data-difference>' + Object.keys(data.stationarity).map(v => opt(v)).join("") + '</select></label></div>' +
    '<div class="diag-grid"><div data-plot="acf"></div><div data-plot="pacf"></div></div><div data-tests></div>';
  for (const [key, name] of [["trend","Trend MW"],["seasonal","Weekly seasonal MW"],["resid","Remainder MW"]])
    chart(target.querySelector('[data-plot="' + key + '"]'), name, data.dates,
      [{name,color:colors[0],values:data[key]}], {short:true});
  const select = target.querySelector("[data-difference]");
  const draw = () => {
    const selected = data.stationarity[select.value];
    if (!selected) return;
    for (const name of ["acf","pacf"]) {
      const values = selected[name].slice(1);
      chart(target.querySelector('[data-plot="' + name + '"]'), name.toUpperCase(), values.map((_,i) => "Lag " + (i+1)),
        [{name:name.toUpperCase(),color:colors[name === "acf" ? 0 : 1],values}], {short:true,bars:true,correlation:1.96/Math.sqrt(selected.n)});
    }
  };
  select.onchange = draw;
  draw();
  const rows = Object.entries(data.stationarity).map(([name,v]) => ({name,...v,
    result:v.adf_p == null || v.kpss_p == null ? "Unavailable" :
      v.adf_p < .05 && v.kpss_p >= .05 ? "Consistent with stationarity" :
      v.adf_p >= .05 && v.kpss_p < .05 ? "Consistent with nonstationarity" : "Mixed evidence"}));
  const dec = v => esc(num(v,4));
  table(target.querySelector("[data-tests]"), rows, [["name","Series"],["n","Days"],["adf","ADF",dec],
    ["adf_p","ADF p",dec],["kpss","KPSS",dec],["kpss_p","KPSS p",dec],["result","Reading at 5%"]]);
}

function aggregate(rows, dimension) {
  const groups = new Map();
  for (const row of rows) {
    const value = dimension === "region" ? row.region : dimension === "target" ? row.target : row.day;
    const key = JSON.stringify([value,row.model]);
    if (!groups.has(key)) groups.set(key,{value,model:row.model,N:0,abs:0,square:0,signed:0,scaled:0,scaleN:0});
    const g = groups.get(key);
    g.N += 1; g.abs += row.absolute; g.square += row.squared; g.signed += row.error;
    if (Number.isFinite(row.scaled)) { g.scaled += row.scaled; g.scaleN += 1; }
  }
  return [...groups.values()].map(g => ({value:g.value,model:g.model,N:g.N,MAE:g.abs/g.N,
    RMSE:Math.sqrt(g.square/g.N),MASE:g.scaleN ? g.scaled/g.scaleN : null,ME:g.signed/g.N}));
}
function renderEvaluation(stage, result) {
  const panel = $(stage + "-output");
  panel.className = "card wide";
  panel.hidden = false;
  const final = stage === "holdout";
  const dimensions = {"horizon":"Configured horizon", "lead":"Forecast day (lead)", "target":"Target date", "region":"Region"};
  const metrics = ["MAE","RMSE","MASE","ME"];
  const stats = Object.entries(result.info).map(([region,info]) => {
    const notices = Object.entries(info.notices).map(([name,n]) => name + " × " + n).join(", ");
    const window = final ? " · " + info.observed_days + " observed holdout days · " + info.excluded_days + " excluded" : "";
    return {region, origins:info.origins, skipped:info.skipped, notices:notices || "—", window};
  });
  panel.innerHTML = '<div class="inline-head"><div><h2>' + (final ? "Final holdout comparison" : "Cross-validation comparison") +
    '</h2><p class="muted">Explore aggregate errors and export the paired prediction records.</p></div>' +
    '<button type="button" class="btn secondary" data-predictions>' + glyph("down") + ' Predictions CSV</button></div>' +
    '<div class="compare-controls"><label class="compact">Compare by<select data-group>' + Object.entries(dimensions).map(([v,n]) => opt(v,n)).join("") +
    '</select></label><label class="compact">Region<select data-region>' + opt("all","All selected regions") +
    cfg.REGIONS.map(r => opt(r)).join("") + '</select></label><label class="compact">Forecast day<select data-lead></select></label>' +
    '<label class="compact">Chart metric<select data-metric>' + metrics.map(m => opt(m)).join("") + '</select></label>' +
    '<button type="button" class="btn secondary" data-metrics>Metrics CSV</button></div>' +
    '<div class="legend">' + models.map((m,i) => '<span><i style="background:' + colors[i] + '"></i>' + esc(m) + '</span>').join("") + '</div>' +
    '<div data-metric-chart></div><p class="metric-note">MAE, RMSE, and ME are in MW. MASE uses the observed weekly naïve scale at each origin. Positive ME means underforecasting.</p>' +
    '<div data-metric-table></div><h3 class="results-sub">' + (final ? "CV winners carried into holdout" : "CV winners by region and horizon") +
    '</h3><p class="muted">Lowest training CV MAE on paired observations.</p><div data-winners></div>' +
    '<h3 class="results-sub">Origin coverage</h3><div data-coverage></div>' +
    (final ? '<h3 class="results-sub">Holdout quality summary</h3><div data-final-checks></div>' :
      '<div class="actions results-sub"><a class="btn dark" href="#holdout">Review holdout gate ' + glyph("arrow") + '</a></div>');
  const group = panel.querySelector("[data-group]");
  const regionSelect = panel.querySelector("[data-region]");
  const leadSelect = panel.querySelector("[data-lead]");
  const metric = panel.querySelector("[data-metric]");
  let visible = [];
  const formatted = (key) => v => esc(num(v,key === "MASE" ? 3 : 1));
  const metricColumns = metrics.map(key => [key,key,formatted(key)]);
  const render = () => {
    const dimension = group.value;
    const exact = dimension === "horizon" ? cfg.HORIZONS : Array.from({length:cfg.HORIZONS.at(-1)},(_,i) => i+1);
    const previous = leadSelect.value;
    leadSelect.innerHTML = opt("all","All shown days") + exact.map(day => opt(day, "Day " + day)).join("");
    if ([...leadSelect.options].some(o => o.value === previous)) leadSelect.value = previous;
    let selected = result.rows.filter(row => regionSelect.value === "all" || row.region === regionSelect.value);
    if (dimension === "horizon") selected = selected.filter(row => cfg.HORIZONS.includes(row.day));
    if (leadSelect.value !== "all") selected = selected.filter(row => row.day === Number(leadSelect.value));
    visible = aggregate(selected,dimension).sort((a,b) =>
      (typeof a.value === "number" ? a.value-b.value : a.value.localeCompare(b.value)) ||
      models.indexOf(a.model)-models.indexOf(b.model));
    const labels = [...new Set(visible.map(row => row.value))];
    const lookups = new Map(visible.map(row => [JSON.stringify([row.value,row.model]),row[metric.value]]));
    chart(panel.querySelector("[data-metric-chart]"), metric.value + " by " + dimensions[dimension],
      labels.map(label => typeof label === "number" ? "Day " + label : label),
      models.map((name,i) => ({name,color:colors[i],values:labels.map(label => lookups.get(JSON.stringify([label,name])))})),
      {bars:dimension !== "target",digits:metric.value === "MASE" ? 3 : 1});
    table(panel.querySelector("[data-metric-table]"), visible, [["value",dimensions[dimension]],["model","Model"],["N","N"],...metricColumns],500);
  };
  if (cfg.REGIONS.length > 1) regionSelect.value = cfg.REGIONS[0];
  for (const element of [group,regionSelect,leadSelect,metric]) element.onchange = render;
  render();
  const winners = final ? cv.winners : result.winners;
  table(panel.querySelector("[data-winners]"), [...winners].sort((a,b) => a.region.localeCompare(b.region) || a.day-b.day),
    [["region","Region"],["day","Horizon"],["model","CV winner",v => '<span class="winner">' + esc(v) + '</span>'],
      ["N","N"],...metricColumns]);
  table(panel.querySelector("[data-coverage]"), stats, [["region","Region"],["origins","Scheduled origins"],
    ["skipped","Skipped origins"],["notices","Fit warnings"]]);
  if (final) {
    const quality = Object.entries(result.info).map(([r,i]) => ({region:r,observed:i.observed_days,excluded:i.excluded_days,
      dst:i.checks.filter(row => row.expected !== 24).length,
      flagged:i.checks.filter(row => row.unusual || row.reviewed).length}));
    table(panel.querySelector("[data-final-checks]"), quality, [["region","Region"],["observed","Observed days"],
      ["excluded","Excluded days"],["dst","DST dates"],["flagged","Anomaly dates"]]);
  }
  panel.querySelector("[data-metrics]").onclick = () => {
    const rows = visible.map(r => ({...r, group:group.value, region_filter:regionSelect.value, forecast_day:leadSelect.value}));
    download("ads506-" + stage + "-metrics.csv",csvText(rows,["group","value","region_filter","forecast_day","model","N",...metrics]));
  };
  panel.querySelector("[data-predictions]").onclick = () => download("ads506-" + stage + "-predictions.csv",
    csvText(result.rows,["region","model","origin","target","day","actual","forecast","error","absolute","squared","scaled"]));
}

function clearForecast() {
  future = null;
  $("forecast-output").hidden = true;
}
function renderFuture(result) {
  const {region, model, horizon, origin, recent, predictions} = result;
  const historical = recent.map(row => row[1]);
  const labels = [...recent.map(row => row[0]), ...predictions.map(row => row.date)];
  const observed = [...historical, ...predictions.map(() => null)];
  const predicted = [...historical.map((value, i) => i === historical.length-1 ? value : null),
                     ...predictions.map(row => row.predicted_mw)];
  const source = sourceNames.get(region);
  const sample = source === "Synthetic sample · practice only" ? " · Synthetic sample" : "";
  const warning = result.fit_warning ? " · Model fit reported an optimizer warning" : "";
  $("forecast-title").textContent = region + " · " + horizon + "-day forecast";
  $("forecast-summary").textContent = model + " · Latest observation " + dateText(origin) +
    " · Training CV MAE " + num(result.cv_mae) + " MW" + sample + warning;
  $("forecast-output").hidden = false;
  chart($("forecast-chart"), region + " daily electricity demand in MW",
    labels, [{name:"Observed MW",color:colors[0],values:observed},
             {name:"Predicted MW",color:colors[1],values:predicted,dashed:true}],
    {forecastFrom:historical.length-1,digits:1});
  table($("forecast-table"), predictions, [["date","Date"],["lead","Day ahead"],
    ["predicted_mw","Predicted demand (MW)", value => esc(num(value))]]);
}

async function loadCode(name) {
  codeFile = name;
  $("download-code").href = name;
  for (const button of all("[data-code]")) {
    button.classList.toggle("active",button.dataset.code === name);
    button.setAttribute("aria-pressed", String(button.dataset.code === name));
  }
  try {
    const result = await fetch(name);
    if (!result.ok) throw Error("Could not load this file.");
    const content = await result.text();
    if (codeFile === name) $("code-content").textContent = content;
  } catch (error) { status(error.message,true); }
}

setOptions($("import-region"),regions);
for (const button of all("[data-import-mode]")) {
  button.setAttribute("aria-pressed",String(button.dataset.importMode === mode));
  button.onclick = () => {
    mode = button.dataset.importMode;
    for (const node of all("[data-import-mode]")) {
      node.classList.toggle("active",node === button);
      node.setAttribute("aria-pressed",String(node === button));
    }
    $("import-file-panel").hidden = mode !== "file";
    $("import-paste-panel").hidden = mode !== "paste";
  };
}
$("import-form").onsubmit = event => {
  event.preventDefault();
  const region = $("import-region").value;
  const file = $("hourly-file").files[0];
  const paste = $("hourly-paste").value.trim();
  if (mode === "file" && !file || mode === "paste" && !paste) {
    status("Choose an hourly file or paste a table first.",true); return;
  }
  operation("Reading hourly data for " + region + "…",async () => {
    const workbook = mode === "file" && /\.xlsx$/i.test(file.name);
    const bytes = mode === "file" ? await file.arrayBuffer() : new TextEncoder().encode(paste).buffer;
    await send("import",{region,workbook,ending:$("hour-ending").checked},bytes);
    sourceNames.set(region,mode === "file" ? file.name : "Pasted hourly rows");
    invalidate();
    $("hourly-file").value = ""; $("hourly-paste").value = "";
    status(region + " source added.");
  });
};
for (const button of all("[data-demo]")) button.onclick = () => {
  if (sourceNames.size && !confirm("Replace the session’s sources with synthetic sample data?")) return;
  operation("Preparing synthetic hourly data…",async () => {
    await send("demo");
    for (const region of regions) sourceNames.set(region,"Synthetic sample · practice only");
    invalidate();
    location.hash = "#data";
    status("Sample sources loaded. Build the training daily averages next.");
  });
};
$("clean-button").onclick = () => operation("Building training daily averages…",async () => {
  const result = await send("clean",{settings:cfg});
  invalidate();
  training = result;
  $("clean-output").hidden = false;
  renderTraining();
  status("Training daily averages are ready.");
});
$("clean-region").onchange = renderTraining;
$("audit-filter").onchange = renderAudit;
$("daily-download").onclick = () => {
  const region = $("clean-region").value;
  const rows = training[region].daily.map(([date,MW]) => ({date,MW}));
  download("ads506-" + region.toLowerCase().replaceAll(" ","-") + "-training-daily.csv",csvText(rows,["date","MW"]));
};
$("diag-region").onchange = renderDiagnostics;
$("diag-button").onclick = () => operation("Running training diagnostics…",async () => {
  const region = $("diag-region").value;
  diagnosticCache.set(region,await send("diagnose",{region}));
  renderDiagnostics();
  status("Diagnostics ready for " + region + ".");
});
$("cv-button").onclick = () => operation("Running training cross-validation…",async () => {
  cv = null;
  $("freeze-confirm").checked = false;
  $("cv-output").className = "card wide empty";
  $("cv-output").textContent = "Training cross-validation is running.";
  try {
    cv = await send("cv");
    renderEvaluation("cv",cv);
    status("Cross-validation complete. Review the results before opening holdout.");
  } catch (error) {
    $("cv-output").textContent = "Cross-validation could not complete. " + error.message;
    throw error;
  }
});
$("freeze-confirm").onchange = controls;
$("holdout-button").onclick = () => operation("Evaluating the frozen holdout run…",async () => {
  frozen = true;
  controls();
  try {
    holdout = await send("holdout");
    renderEvaluation("holdout",holdout);
    status("Final holdout evaluation complete.");
  } catch (error) {
    $("holdout-output").hidden = false;
    $("holdout-output").textContent = "Evaluation could not complete. " + error.message;
    throw error;
  }
});
$("forecast-region").onchange = clearForecast;
$("forecast-horizon").onchange = clearForecast;
$("forecast-button").onclick = () => operation("Generating future demand predictions…", async () => {
  clearForecast();
  const region = $("forecast-region").value;
  const horizon = Number($("forecast-horizon").value);
  future = await send("forecast", {region,horizon});
  renderFuture(future);
  status("Future demand forecast ready.");
});
$("forecast-download").onclick = () => {
  if (!future) return;
  const {region, model, origin, horizon, predictions} = future;
  const rows = predictions.map(row => ({region,model,origin,...row}));
  download("ads506-future-" + region.toLowerCase().replaceAll(" ", "-") + "-" + horizon + "d.csv",
    csvText(rows, ["region","model","origin","date","lead","predicted_mw"]));
};
$("settings-form").onsubmit = event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const config = Object.fromEntries(form);
  config.REGIONS = form.getAll("REGIONS");
  config.HORIZONS = config.HORIZONS.split(/[ ,]+/).filter(Boolean).map(Number);
  config.CA_ANOMALY = form.has("CA_ANOMALY");
  for (const key of ["CV_INITIAL","CV_STEP","HOLDOUT_STEP","MAX_MISSING"]) config[key] = Number(config[key]);
  try { updateSettings(config); status("Settings saved. Rebuild daily averages to use the new configuration."); }
  catch (error) { status(error.message,true); }
};
$("restore-defaults").onclick = () => {
  updateSettings(defaults);
  status("Project defaults restored.");
};
$("settings-import").onchange = async event => {
  const file = event.target.files[0];
  if (!file) return;
  try { updateSettings(JSON.parse(await file.text())); status("Project settings imported."); }
  catch (error) { status(error.message,true); }
  finally { event.target.value = ""; }
};
$("settings-download").onclick = () => download("settings.json",JSON.stringify(cfg,null,2) + "\n","application/json");
for (const button of all("[data-code]")) button.onclick = () => loadCode(button.dataset.code);
$("copy-code").onclick = async () => {
  try { await navigator.clipboard.writeText($("code-content").textContent); status("Code copied."); }
  catch { status("Clipboard unavailable. Use Download file to save the code.",true); }
};
fillSettings();
controls();
route();
