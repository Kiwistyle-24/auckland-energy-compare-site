import { rankOffers, verdictFor, EFFECTIVELY_BEST_DOLLARS, annualKwh, MONTH_NAMES, round2, inclGst, AVG_DAYS_PER_MONTH, isStale, STALE_DAYS, compareLowStandard, variantPairs, costOffer } from './calc.js';
import { validatePlan, validateUsageFile } from './schema.js';
import { parseGenesisInvoice, mergeInvoices, InvoiceError } from './genesis-invoice.js';
import { parseHourlyCsv, mergeHourly, hourlyCoverage, planSharesFromHourly, looksLikeHourlyCsv, HourlyError, seasonCoverage, DEFAULT_WINTER_WEIGHTS, MON } from './hourly.js';

const LS = { state: 'aec.state.v1', scenarios: 'aec.scenarios.v1', manual: 'aec.manualPlans.v1', usage: 'aec.myUsage.v1', hourly: 'aec.hourlyUsage.v1' };
// 'dev' when served by `npm run dev`; the public build (npm run build) rewrites this to 'public'.
const BUILD = document.querySelector('meta[name=aec-build]')?.content || 'public';
let USAGE_FROM = null; // 'file' (dev auto-load) | 'browser' (loaded by you, kept in localStorage)
const MY_BILLS = 'My bills';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n) => (n < 0 ? '−' : '') + '$' + Math.round(Math.abs(n)).toLocaleString('en-NZ');
const fmtDate = (iso) => { if (!iso) return '—'; const d = new Date(iso); return Number.isNaN(+d) ? esc(iso) : d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Pacific/Auckland' }); };
const fmtDateTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); if (Number.isNaN(+d)) return esc(iso); return /T/.test(iso) ? d.toLocaleString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Pacific/Auckland', timeZoneName: 'short' }) : fmtDate(iso); };
const staleTag = (iso) => (isStale(iso) ? ` <span class="tag stale" title="More than ${STALE_DAYS} days old">STALE</span>` : '');
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let DATA = null;      // plans.json
let USAGE = null;     // my-usage.json
let state = null;     // current inputs
let selectedId = null;
let HOURLY = [];      // hourly kWh rows from Genesis hourly CSVs (this browser only)

const defaultPrefs = () => ({ fuels: 'both', userType: 'any', pricing: 'any', term: 'any', dualFuel: 'keep', promptPay: true, oneOffCredits: true, unconfirmedCredits: false, allow: [] });

function billsScenario() {
  const d = USAGE?.default || { mode: 'average', elecKwh: 0, gasKwh: 0, shares: { night: 0.3, peak: 0.3, free: 1 / 7 } };
  return {
    name: MY_BILLS,
    mode: USAGE?.months ? d.mode || 'seasonal' : 'average',
    elecKwh: d.elecKwh, gasKwh: d.gasKwh,
    months: (USAGE?.months || Array.from({ length: 12 }, () => ({ elecKwh: d.elecKwh, gasKwh: d.gasKwh }))).map((m) => ({ elecKwh: m.elecKwh, gasKwh: m.gasKwh })),
    shares: { ...d.shares }, sharesFromBills: !!d.sharesFromBills,
    prefs: defaultPrefs(),
  };
}

const allPlans = () => [...(DATA?.plans || []), ...load(LS.manual, []).map((p) => ({ ...p, origin: 'browser' }))];
const winterWeights = (s) => (Array.isArray(s.winterWeights) && s.winterWeights.length === 12 ? s.winterWeights : DEFAULT_WINTER_WEIGHTS);
/** The scenario used for costing: adds per-plan time-of-use splits from your hourly data (unless turned off). */
function costScenario(s) {
  if (!HOURLY.length || s.useHourly === false) return s;
  return { ...s, planShares: planSharesFromHourly([...allPlans(), ...(baseline()?.electricity ? [baseline().electricity] : [])], HOURLY, { winterWeights: winterWeights(s) }) };
}
const baseline = () => (USAGE?.currentPlan?.electricity ? { electricity: USAGE.currentPlan.electricity, gas: USAGE.currentPlan.gas || null } : null);

async function init() {
  const [plans, devUsage] = await Promise.all([
    fetch('data/plans.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    // Only the local dev server has data/my-usage.json. The public build never ships or requests it.
    BUILD === 'dev' ? fetch('data/my-usage.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
  ]);
  DATA = plans || { plans: [], providers: [], networkCharges: {}, notes: [] };
  const stored = load(LS.usage, null);
  // Bills you loaded in this browser win over the dev auto-load file.
  if (stored) { USAGE = stored; USAGE_FROM = 'browser'; }
  else if (devUsage) { USAGE = devUsage; USAGE_FROM = 'file'; }
  HOURLY = load(LS.hourly, []);
  if (!Array.isArray(HOURLY)) HOURLY = [];
  bindBills();
  renderBillsSummary();
  state = load(LS.state, null) || billsScenario();
  // v2: default free-hours share is 1/7 (free Sundays); move the old untouched 10% default over once.
  if (state.shares && !state.freeShareV2) { if (state.shares.free === 0.1) state.shares.free = 1 / 7; state.freeShareV2 = true; }
  state.prefs = { ...defaultPrefs(), ...(state.prefs || {}) };
  // v3: default gas pairing is "keep my current gas" (or the power retailer's own gas); move the old default over once.
  if (!state.prefsV3) { if (state.prefs.dualFuel === 'any') state.prefs.dualFuel = 'keep'; state.prefsV3 = true; }
  renderBanner();
  bindInputs();
  bindForm();
  renderProvidersList();
  renderSources();
  renderAll();
}

function renderBanner() {
  const b = $('banner');
  if (!DATA.generatedAt) { b.className = 'banner warn'; b.textContent = 'Could not load data/plans.json. Run "npm run fetch".'; return; }
  const ne = DATA.networkCharges?.electricity, ng = DATA.networkCharges?.gas;
  const errs = (DATA.fetchErrors || []).length;
  b.className = 'banner' + (errs ? ' warn' : '');
  const stale = isStale(DATA.generatedAt);
  if (stale) b.className = 'banner warn';
  const fetched = (DATA.plans || []).filter((p) => p.source?.method === 'automatic');
  const snaps = (DATA.plans || []).filter((p) => p.source?.method === 'snapshot');
  const okRetailers = new Set(fetched.map((p) => p.retailerId)).size;
  const quotes = allPlans().filter((p) => p.source?.method === 'manual').length;
  b.innerHTML = `<strong>Prices last refreshed: ${fmtDateTime(DATA.generatedAt)}</strong>${stale ? ` <span class="tag stale">STALE: over ${STALE_DAYS} days old, run the refresh workflow</span>` : ''} · ${fetched.length} plan(s) fetched from ${okRetailers} retailer website(s) · ${DATA.providers.length} retailers checked${snaps.length ? ` · ${snaps.length} plan(s) from dated quote snapshots` : ''}${quotes ? ` · ${quotes} quote(s) you entered` : ''}` +
    (errs ? ` · ⚠ ${errs} source(s) failed on the last run; older values kept` : '') +
    (USAGE?.isPlaceholder ? ' · ⚠ my-usage.json holds PLACEHOLDER values' : '');
}

// ---------- inputs ----------
function bindInputs() {
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => { state.mode = r.value; changed(); }));
  $('elecKwh').addEventListener('input', (e) => { state.elecKwh = +e.target.value || 0; changed(); });
  $('gasKwh').addEventListener('input', (e) => { state.gasKwh = +e.target.value || 0; changed(); });
  [['shareNight', 'night'], ['sharePeak', 'peak'], ['shareFree', 'free']].forEach(([id, k]) =>
    $(id).addEventListener('input', (e) => { state.shares[k] = Math.max(0, Math.min(100, +e.target.value || 0)) / 100; changed(); }));
  [['prefFuels', 'fuels'], ['prefUserType', 'userType'], ['prefPricing', 'pricing'], ['prefTerm', 'term'], ['prefDual', 'dualFuel']].forEach(([id, k]) =>
    $(id).addEventListener('change', (e) => { state.prefs[k] = e.target.value; changed(true); }));
  $('prefPrompt').addEventListener('change', (e) => { state.prefs.promptPay = e.target.checked; changed(); });
  $('prefCredits').addEventListener('change', (e) => { state.prefs.oneOffCredits = e.target.checked; changed(); });
  $('prefUnconfirmed').addEventListener('change', (e) => { state.prefs.unconfirmedCredits = e.target.checked; changed(); });
  [['prefBroadband', 'broadband'], ['prefEv', 'ev']].forEach(([id, k]) => $(id).addEventListener('change', (e) => {
    const set = new Set(state.prefs.allow || []); if (e.target.checked) set.add(k); else set.delete(k); state.prefs.allow = [...set]; changed();
  }));
  [['segFuels', 'fuels'], ['segUser', 'userType']].forEach(([id, k]) => $(id).querySelectorAll('button').forEach((btn) =>
    btn.addEventListener('click', () => { state.prefs[k] = btn.dataset.v; changed(true); })));
  $('scaleSeasonal').addEventListener('click', () => {
    const t = annualKwh({ ...state, mode: 'seasonal' });
    const fe = t.elec ? (state.elecKwh * 12) / t.elec : 1, fg = t.gas ? (state.gasKwh * 12) / t.gas : 1;
    state.months = state.months.map((m) => ({ elecKwh: Math.round(m.elecKwh * fe), gasKwh: Math.round(m.gasKwh * fg) }));
    state.mode = 'seasonal';
    changed(true);
  });
  $('scenarioSelect').addEventListener('change', (e) => {
    const name = e.target.value;
    state = name === MY_BILLS ? billsScenario() : structuredClone(load(LS.scenarios, {})[name]);
    changed(true);
  });
  $('saveScenario').addEventListener('click', () => {
    const name = (prompt('Name this scenario (e.g. "Heat pump in winter", "EV at night")', state.name && state.name !== MY_BILLS ? state.name : '') || '').trim();
    if (!name) return;
    if (name === MY_BILLS) { alert('"My bills" is reserved for the figures from your bills. Pick another name.'); return; }
    const all = load(LS.scenarios, {});
    state.name = name;
    all[name] = structuredClone(state);
    save(LS.scenarios, all);
    changed(true);
  });
  $('deleteScenario').addEventListener('click', () => {
    if (!state.name || state.name === MY_BILLS) return;
    if (!confirm(`Delete scenario "${state.name}"?`)) return;
    const all = load(LS.scenarios, {}); delete all[state.name]; save(LS.scenarios, all);
    state = billsScenario(); changed(true);
  });
  $('resetBills').addEventListener('click', () => { state = billsScenario(); changed(true); });
  [['quickElec', 'elecKwh'], ['quickGas', 'gasKwh']].forEach(([id, k]) => $(id).addEventListener('input', (e) => {
    state[k] = Math.max(0, +e.target.value || 0); state.mode = 'average'; changed(); $(k).value = state[k];
  }));
  $('showAll').addEventListener('click', () => { showAll = !showAll; renderResults(); });
  // links that point into a closed panel open it first (e.g. "not yet priced", "sources")
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-open]'); if (!a) return;
    a.dataset.open.split(',').forEach((id) => { const d = $(id); if (d && 'open' in d) d.open = true; });
  });
  if (location.hash) { const t = document.querySelector(location.hash); const d = t?.closest('details'); if (d) d.open = true; }
}

function changed(full = false) {
  // Keep an edited "My bills" scenario as an unsaved working copy.
  if (state.name && state.name !== MY_BILLS) {
    const all = load(LS.scenarios, {});
    if (all[state.name]) { all[state.name] = structuredClone(state); save(LS.scenarios, all); }
  }
  save(LS.state, state);
  if (full) renderInputs(); else renderInputSummary();
  renderResults();
  renderScenarioCompare();
}

function renderInputs() {
  const sel = $('scenarioSelect');
  const names = [MY_BILLS, ...Object.keys(load(LS.scenarios, {}))];
  sel.innerHTML = names.map((n) => `<option ${n === (state.name || MY_BILLS) ? 'selected' : ''}>${esc(n)}</option>`).join('');
  $('deleteScenario').disabled = !state.name || state.name === MY_BILLS;
  document.querySelectorAll('input[name=mode]').forEach((r) => (r.checked = r.value === state.mode));
  $('elecKwh').value = state.elecKwh; $('gasKwh').value = state.gasKwh;
  $('shareNight').value = Math.round((state.shares.night || 0) * 100);
  $('sharePeak').value = Math.round((state.shares.peak || 0) * 100);
  $('shareFree').value = Math.round((state.shares.free || 0) * 1000) / 10;
  $('prefUserType').value = state.prefs.userType; $('prefPricing').value = state.prefs.pricing;
  $('prefTerm').value = state.prefs.term; $('prefDual').value = state.prefs.dualFuel; $('prefPrompt').checked = state.prefs.promptPay !== false;
  $('prefFuels').value = state.prefs.fuels || 'both'; $('prefCredits').checked = state.prefs.oneOffCredits !== false; $('prefUnconfirmed').checked = !!state.prefs.unconfirmedCredits; $('prefBroadband').checked = (state.prefs.allow || []).includes('broadband'); $('prefEv').checked = (state.prefs.allow || []).includes('ev');
  [['segFuels', 'fuels', 'both'], ['segUser', 'userType', 'any']].forEach(([id, k, d]) => $(id).querySelectorAll('button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.v === (state.prefs[k] || d)))));
  $('sharesNote').textContent = USAGE?.default?.sharesNote || 'These shares are assumptions. Edit them to match your habits.';
  renderHourlyInfo();
  const u = USAGE;
  const from = USAGE_FROM === 'file' ? ' (auto-loaded from data/my-usage.json, local dev mode)' : USAGE_FROM === 'browser' ? (USAGE?.pdfImport ? ` (read from ${USAGE.pdfImport.invoices.length} PDF bill(s) in this browser, saved here only)` : ' (loaded from your file, saved in this browser)') : '';
  $('usageSource').innerHTML = u
    ? (u.isPlaceholder ? '⚠ <strong>Placeholder usage</strong>: fill in my-usage.json from your bills.' : `"My bills" uses figures from your ${esc(u.provider || 'energy')} bills${from}. ${esc(u.coverage?.months || '')}`)
    : '<strong>No bills file loaded.</strong> Click <em>Load my bills</em> (your Genesis PDF bills or a my-usage.json file) to use your own usage and current plan, or type your usage below.';
  $('forgetBills').hidden = USAGE_FROM !== 'browser' && !HOURLY.length;
  { const c = hourlyCoverage(HOURLY); if (c) $('usageSource').innerHTML += ` Hourly usage: ${esc(c.text)} (saved in this browser only).`; }
  // seasonal table
  const t = $('seasonalTable');
  t.innerHTML = `<thead><tr><th>Month</th>${MONTH_NAMES.map((m) => `<th>${m}</th>`).join('')}</tr></thead><tbody>
    <tr><th>Power kWh</th>${state.months.map((m, i) => `<td><input type="number" min="0" data-i="${i}" data-k="elecKwh" value="${m.elecKwh}"></td>`).join('')}</tr>
    <tr><th>Gas kWh</th>${state.months.map((m, i) => `<td><input type="number" min="0" data-i="${i}" data-k="gasKwh" value="${m.gasKwh}"></td>`).join('')}</tr></tbody>`;
  t.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => { state.months[+inp.dataset.i][inp.dataset.k] = +inp.value || 0; state.mode = 'seasonal'; document.querySelector('input[name=mode][value=seasonal]').checked = true; changed(); }));
  $('seasonalBox').open = state.mode === 'seasonal' && !!state._openMonths;
  renderInputSummary();
}

function renderInputSummary() {
  const a = annualKwh(state);
  $('annualSummary').textContent = state.mode === 'seasonal'
    ? `Month-by-month: ${Math.round(a.elec).toLocaleString()} kWh power and ${Math.round(a.gas).toLocaleString()} kWh gas a year (the monthly boxes above are only used in "Same every month" mode).`
    : `${Math.round(a.elec).toLocaleString()} kWh power and ${Math.round(a.gas).toLocaleString()} kWh gas a year.`;
}

// ---------- results ----------
function sourceCell(p) {
  if (!p) return '';
  const tag = p.isExample ? '<span class="tag example">EXAMPLE DATA</span>' : p.source?.method === 'bill' ? '<span class="tag bill">your bill</span>'
    : p.source?.method === 'automatic' ? '<span class="tag auto">fetched</span>' : p.source?.method === 'snapshot' ? '<span class="tag manual">quote snapshot</span>' : '<span class="tag manual">your quote</span>';
  const link = p.source?.url ? `<a href="${esc(p.source.url)}" target="_blank" rel="noopener" title="${esc(p.source.url)}">${esc(shortUrl(p.source.url))}</a>` : esc(p.source?.note || 'from your bills (no URL)');
  return `${tag} ${link}<br>retrieved ${fmtDateTime(p.source?.retrievedAt)}${staleTag(p.source?.retrievedAt)}${p.effectiveFrom ? `<br>effective from ${fmtDate(p.effectiveFrom)}` : ''}`;
}
function shortUrl(u) { try { const x = new URL(u); return x.host.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.slice(0, 28) + (x.pathname.length > 28 ? '…' : '') : ''); } catch { return u; } }
function userTag(p) { return p.userType === 'low' ? '<span class="tag">LOW USER</span>' : p.userType === 'standard' ? '<span class="tag">STANDARD USER</span>' : ''; }
function planDesc(p) {
  if (!p) return '';
  const r = Object.entries(p.rates).map(([k, v]) => `${k} ${round2(inclGst(v, p.gstInclusive))}c`).join(', ');
  return `<div><strong>${esc(p.fuel === 'gas' ? 'Gas' : 'Power')}:</strong> ${esc(p.provider)} – ${esc(p.name)} ${userTag(p)}<br><span class="muted small">${round2(inclGst(p.dailyCents, p.gstInclusive))}c/day, ${r} (incl. GST)</span></div>`;
}

function effectiveCell(p) {
  if (!p) return '';
  if (p.effectiveFrom) return `effective from ${fmtDate(p.effectiveFrom)}`;
  if (p.pricesUpdated) return `effective from: not shown (page says prices last updated ${fmtDate(p.pricesUpdated)})`;
  if (p.source?.method === 'automatic' || p.source?.method === 'snapshot') return 'effective from: not shown on the page';
  return '';
}
function offerSource(p) {
  if (!p) return '';
  const tag = p.source?.method === 'bill' ? '<span class="tag bill">your bill</span>' : p.source?.method === 'automatic' ? '<span class="tag auto">retailer website</span>' : p.source?.method === 'snapshot' ? '<span class="tag manual">quote snapshot</span>' : '<span class="tag manual">your quote</span>';
  const link = p.source?.url ? `<a href="${esc(p.source.url)}" target="_blank" rel="noopener">${esc(shortUrl(p.source.url))}</a>` : esc(p.source?.note || 'from your bills (no URL)');
  return `<div class="src">${tag} ${link}<br>${p.source?.method === 'snapshot' ? `quote snapshot, retrieved ${fmtDate(p.source?.retrievedAt)} (${(DATA.providers || []).find((x) => x.id === p.retailerId)?.manualSnapshot ? 'retrieved by hand in a browser; never fetched automatically' : 'no longer fetched automatically'})` : `prices retrieved ${fmtDateTime(p.source?.retrievedAt)}`}${staleTag(p.source?.retrievedAt)}${p.stale ? ' <span class="tag stale">last fetch failed: older prices</span>' : ''}${effectiveCell(p) ? `<br>${esc(effectiveCell(p))}` : ''}</div>`;
}
function conditionsList(o) {
  const items = [];
  for (const p of [o.elecPlan, o.gasPlan]) {
    if (!p) continue;
    const c = Array.isArray(p.conditions) ? p.conditions : p.conditions ? [p.conditions] : [];
    if (p.fixedTerm === true) items.push(`${p.provider}: fixed term${p.exitFee ? `, exit fee ${p.exitFee}` : ''}.`);
    else if (p.fixedTerm === false) items.push(`${p.provider}: no fixed term.`);
    const d = p.discounts || {};
    if (d.promptPaymentPct) items.push(`${d.promptPaymentPct}% prompt-payment discount${state.prefs.promptPay === false ? ' (not applied: you unticked it)' : ' (applied)'}.`);
    if (d.monthlyCreditDollars) items.push(`$${d.monthlyCreditDollars}/month credit (applied).`);
    if (d.bundle?.noDiscount) items.push(`Dual fuel: ${d.bundle.note}${o.bundle ? '' : ' (not paired here)'}.`);
    else if (d.bundle) items.push(`Dual-fuel credit${d.bundle.monthlyCreditDollars ? ` $${d.bundle.monthlyCreditDollars}/month` : ''}${d.bundle.dailyCreditCents ? ` ${d.bundle.dailyCreditCents}c/day` : ''}${d.bundle.pct ? ` ${d.bundle.pct}%` : ''}${d.bundle.unconfirmed && !state.prefs.unconfirmedCredits ? ' (not counted: its conditions are not shown)' : o.bundle ? ' (applied)' : ' (not applied: needs both fuels from the same retailer)'}.`);
    if (d.oneOffCreditDollars) items.push(`One-off $${d.oneOffCreditDollars} sign-up credit${state.prefs.oneOffCredits === false ? ' (not counted: you unticked it)' : ' (counted, spread over year 1)'}.`);
    if (p.exitFee && p.fixedTerm !== true) items.push(`${p.provider}: exit fee: ${p.exitFee}.`);
    items.push(...c.filter((x) => !/^Low-user plan:/.test(x)));
  }
  return [...new Set(items)];
}
function rateLine(p) {
  if (!p) return '';
  const names = { anytime: 'anytime', day: 'day', night: 'night', peak: 'peak', offpeak: 'off-peak' };
  const r = Object.entries(p.rates).map(([k, v]) => `${names[k] || k} ${round2(inclGst(v, p.gstInclusive)).toFixed(2)}c/kWh`).join(' · ');
  let extra = '';
  if (Array.isArray(p.monthlyRates)) {
    const all = p.monthlyRates.flatMap((m) => Object.values(m || {}));
    extra = `<br><span class="muted small">Seasonal: ${Math.min(...all).toFixed(2)}–${Math.max(...all).toFixed(2)}c/kWh across the year (rates shown are this month's)</span>`;
  }
  if (p.timeBands) extra += `<br><span class="muted small">Time bands: ${esc(Object.entries(p.timeBands).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join('; '))}</span>`;
  if (p.levyCentsPerKwh || p.levyCentsPerDay) extra += `<br><span class="muted small">Plus ${[p.levyCentsPerKwh ? `EA levy ${round2(inclGst(p.levyCentsPerKwh, p.gstInclusive) * 1000) / 1000}c/kWh` : '', p.levyCentsPerDay ? `GIC levy ${round2(inclGst(p.levyCentsPerDay, p.gstInclusive) * 1000) / 1000}c/day` : ''].filter(Boolean).join(' and ')} (incl. GST), included in the cost</span>`;
  if (p.requiresOtherService?.length) extra += `<br><span class="tag manual">needs ${esc(p.requiresOtherService.join(', ').replace(/, ([^,]*)$/, ' or $1'))} with ${esc(p.provider)}</span>`;
  if (p.cardFlag) extra += `<br><span class="tag stale">${esc(p.cardFlag)}</span>`;
  if (p.requires?.length) extra += `<br><span class="tag manual">needs ${esc(p.requires.map((x) => (x === 'ev' ? 'an EV' : 'same-retailer broadband or mobile (bundle)')).join(' + '))}</span>`;
  return `<div class="rates"><strong>${p.fuel === 'gas' ? 'Gas' : 'Power'}:</strong> ${esc(p.provider)} – ${esc(p.name)} ${userTag(p)}<br><span class="muted">${(inclGst(p.dailyCents, p.gstInclusive) / 100).toFixed(2)} $/day · ${r} (incl. GST)</span>${extra}</div>`;
}

let showAll = false;

function offerWho(o) {
  const b = baseline();
  const keepGas = o.gasPlan && b?.gas && o.gasPlan === b.gas && o.elecPlan !== b.electricity;
  const retailer = o.isBaseline ? `Your current plan (${[...new Set([o.elecPlan?.provider, o.gasPlan?.provider].filter(Boolean))].join(' + ')})` : (o.elecPlan || o.gasPlan).provider + (o.gasPlan && !keepGas && o.gasPlan.provider !== o.elecPlan?.provider && o.elecPlan ? ` + ${o.gasPlan.provider} gas` : '');
  const plan = [o.elecPlan?.name, o.gasPlan && o.elecPlan ? (keepGas ? `keep your ${o.gasPlan.provider} gas` : o.bundle ? `${o.gasPlan.name} (dual fuel)` : o.gasPlan.name) : o.gasPlan?.name].filter(Boolean).join(' · ');
  return { retailer, plan, short: o.elecPlan ? `${o.elecPlan.name} (${o.elecPlan.provider})` : `${o.gasPlan.name} (${o.gasPlan.provider})` };
}

function termLine(p) {
  if (!p) return '';
  const t = p.fixedTerm === true ? `fixed term${p.termMonths ? ` (${p.termMonths} months)` : ''}${p.exitFee ? `, exit fee ${p.exitFee}` : ', exit fee not stated'}` : p.fixedTerm === false ? `no fixed term${p.exitFee ? ` (exit fee: ${p.exitFee})` : ''}` : 'term and exit fees not shown in the source';
  return `<div class="small"><strong>${esc(p.provider)} ${p.fuel === 'gas' ? 'gas' : 'power'}:</strong> ${esc(t)}</div>`;
}

/** "With/without" figures for one-off costs and credits whose conditions aren't shown. */
function altLines(o) {
  const plans = [o.elecPlan, o.gasPlan].filter(Boolean);
  const sc = costScenario(state);
  const f = state.prefs.fuels;
  const scen = f === 'electricity' ? { ...sc, gasKwh: 0, months: sc.months.map((m) => ({ ...m, gasKwh: 0 })) } : f === 'gas' ? { ...sc, elecKwh: 0, months: sc.months.map((m) => ({ ...m, elecKwh: 0 })) } : sc;
  const base = { promptPay: state.prefs.promptPay !== false, oneOffCredits: state.prefs.oneOffCredits !== false, unconfirmedCredits: !!state.prefs.unconfirmedCredits };
  const cost = (extra) => costOffer({ elecPlan: o.elecPlan, gasPlan: o.gasPlan }, scen, { ...base, ...extra }).annual;
  const out = [];
  const up = plans.find((p) => p.upfrontCostDollars);
  if (up) out.push(`Without the one-off ${up.upfrontCostNote || `$${up.upfrontCostDollars} cost`} (from year 2): <strong>${money0(cost({ upfrontCosts: false }))}/yr</strong>`);
  const unc = plans.find((p) => p.discounts?.bundle?.unconfirmed);
  if (unc && o.elecPlan && o.gasPlan && (o.elecPlan.bundleGroup || o.elecPlan.provider) === (o.gasPlan.bundleGroup || o.gasPlan.provider)) {
    out.push(base.unconfirmedCredits ? `Without the $${unc.discounts.bundle.monthlyCreditDollars}/month credit (conditions not shown): <strong>${money0(cost({ unconfirmedCredits: false }))}/yr</strong>` : `With the $${unc.discounts.bundle.monthlyCreditDollars}/month credit (conditions not shown, not counted above): <strong>${money0(cost({ unconfirmedCredits: true }))}/yr</strong>`);
  }
  return out.length ? `<div class="small alt">${out.join('<br>')}</div>` : '';
}

function renderVerdict(offers, raw) {
  const head = $('verdictHead'), body = $('verdictBody');
  const hasGas = raw.gas > 0;
  const fuels = state.prefs.fuels || 'both';
  $('segFuels').hidden = !hasGas && fuels === 'both';
  $('segFuels').querySelector('[data-v=gas]').hidden = fuels !== 'gas';
  const noUsage = raw.elec + raw.gas === 0;
  $('quickUsage').hidden = !!USAGE && !noUsage;
  if (!$('quickUsage').hidden && document.activeElement?.closest?.('#quickUsage') == null) { $('quickElec').value = state.elecKwh || ''; $('quickGas').value = state.gasKwh || ''; }
  const fig = (label, v, cls = '') => `<div class="fig ${cls}"><span class="fig-label">${label}</span><span class="fig-value">${money0(v)}<span class="per">/yr</span></span></div>`;
  const what = { both: hasGas ? 'power and gas' : 'power', electricity: 'power', gas: 'gas' }[fuels];
  const v = verdictFor(offers, { hasUsage: !noUsage });
  const { base, alt, diff } = v;
  const who = alt ? offerWho(alt).short : '';
  body.dataset.kind = v.kind;
  if (v.kind === 'no-usage') {
    head.textContent = 'Are you on the best energy plan?';
    body.innerHTML = '<p class="lead">Load your Genesis bills (PDF) or type your monthly usage to see what you\'d pay on every plan we could price. Everything stays in this browser.</p>';
  } else if (v.kind === 'no-baseline') {
    head.textContent = `Cheapest for your usage: ${offerWho(v.best).short}`;
    body.innerHTML = `<div class="figs">${fig(`Cheapest (${what})`, v.best.annual, 'best')}</div><p class="lead">Load your bills to compare it with your current plan.</p>`;
  } else if (v.kind === 'no-alternative') {
    head.textContent = 'We couldn\'t price any open alternative';
    body.innerHTML = `<div class="figs">${fig(`Your current plan (${what})`, base.annual)}</div><p class="lead">Add quotes under <a href="#notPricedPanel" data-open="notPricedPanel">Retailers not yet priced</a>.</p>`;
  } else if (v.kind === 'best') {
    head.textContent = 'You\'re on the best plan available';
    body.innerHTML = `<div class="figs">${fig(`Your current plan (${what})`, base.annual, 'best')}${fig('Next cheapest', alt.annual)}</div><p class="lead">The next cheapest, ${esc(who)}, costs ${money0(-diff)}/yr more.</p>`;
  } else if (v.kind === 'effectively-best') {
    head.textContent = 'You\'re effectively on the best plan';
    body.innerHTML = `<div class="figs">${fig(`Your current plan (${what})`, base.annual)}${fig('Cheapest available', alt.annual, 'best')}</div><p class="lead">The cheapest, ${esc(who)}, would save only ${money0(diff)}/yr (under ${money0(EFFECTIVELY_BEST_DOLLARS)}/yr), so switching isn't worth it for price alone.</p>`;
  } else {
    head.textContent = `You could save ${money0(diff)}/yr by switching to ${who}`;
    body.innerHTML = `<div class="figs">${fig(`Your current plan (${what})`, base.annual)}${fig('Cheapest available', alt.annual, 'best')}</div>`;
  }
  const pick = v.kind === 'no-baseline' ? v.best : v.kind === 'save' || v.kind === 'effectively-best' ? alt : null;
  if (pick?.assumptionDependent) body.innerHTML += `<p class="caveat small">${pick.splitFromHourly ? 'Its cost uses the time-of-use split from your hourly data.' : 'It\'s a time-of-use plan: its cost depends on when you use power (an assumed split). Load your hourly usage CSVs for a better estimate.'} <a href="#howPanel" data-open="howPanel">How this is calculated</a></p>`;
}

function renderFreshness() {
  const used = (DATA.plans || []).filter((p) => ['automatic', 'snapshot'].includes(p.source?.method) && !p.closedToNewCustomers && p.source?.retrievedAt);
  const oldest = used.map((p) => p.source.retrievedAt).sort()[0];
  const priced = new Set(allPlans().filter((p) => p.source?.method !== 'bill' && !p.closedToNewCustomers && !p.isExample).map((p) => p.provider)).size;
  const notPriced = quoteTodo().filter((p) => !p.partial).length;
  const stale = oldest && isStale(oldest);
  $('freshness').innerHTML = `${oldest ? `Prices from retailers' own sites, oldest retrieved ${fmtDate(oldest)}${stale ? ` <span class="tag stale">STALE</span>` : ''}` : 'No retailer prices loaded'} · ${priced} retailer${priced === 1 ? '' : 's'} priced · <a href="#notPricedPanel" data-open="notPricedPanel">${notPriced} not yet priced</a> · <a href="#sources" data-open="howPanel,sources">sources</a>`;
  $('notPricedSummary').textContent = `${notPriced} retailer(s) need a quote from their own site · add a quote`;
}

function renderResults() {
  const prefs = state.prefs;
  const offers = rankOffers(allPlans(), costScenario(state), prefs, baseline());
  const fuelsLabel = { both: 'power + gas', electricity: 'power only', gas: 'gas only' }[prefs.fuels || 'both'];
  const raw = annualKwh(state);
  const a = prefs.fuels === 'electricity' ? { elec: raw.elec, gas: 0 } : prefs.fuels === 'gas' ? { elec: 0, gas: raw.gas } : raw;
  $('resultsFor').textContent = a.elec + a.gas ? `(${fuelsLabel}; ${[a.elec && `${Math.round(a.elec).toLocaleString('en-NZ')} kWh power`, a.gas && `${Math.round(a.gas).toLocaleString('en-NZ')} kWh gas`].filter(Boolean).join(' and ')} a year)` : '';
  const comparable = offers.filter((o) => !o.incomplete && !o.ineligible);
  const ranked = comparable.filter((o) => !o.closed);
  const best = ranked[0] || comparable[0];
  const base = offers.find((o) => o.isBaseline);
  const alt = ranked.find((o) => !o.isBaseline);
  renderBaselineCheck();
  renderVerdict(offers, raw);
  renderFreshness();
  $('best').innerHTML = best ? esc(best.label) : '';

  const noUsage = raw.elec + raw.gas === 0;
  const rest = offers.filter((o) => !ranked.includes(o));
  let shown = showAll ? [...ranked, ...rest] : ranked.slice(0, 5);
  if (!showAll && base && !shown.includes(base)) shown.push(base);
  if (noUsage) shown = [];
  $('results').hidden = noUsage;
  const ref = base || best;
  $('offerList').innerHTML = shown.map((o) => {
    const v = ref && o !== ref ? round2(o.annual - ref.annual) : null;
    const pos = ranked.indexOf(o);
    const diff = o.isBaseline ? 'current' : v == null ? 'cheapest' : Math.abs(v) < 0.5 ? 'same' : v < 0 ? `saves ${money0(-v)}` : `+${money0(v)}`;
    const ut = o.elecPlan?.userType || o.gasPlan?.userType;
    const cond = conditionsList(o);
    const w = offerWho(o);
    const tags = [ut === 'low' ? 'LOW USER' : ut === 'standard' ? 'STANDARD USER' : o.elecPlan?.userTypeNote ? 'USER TYPE NOT CONFIRMED (low or standard)' : '', o.bundle ? 'dual fuel' : '', o.closed ? 'CLOSED TO NEW CUSTOMERS' : '', o.splitFromHourly ? 'split from your hourly data' : o.assumptionDependent ? 'depends on your usage split' : '', o.elecPlan?.prepay ? 'prepay' : '', [o.elecPlan, o.gasPlan].some((p) => p?.source?.method === 'snapshot') ? 'quote snapshot' : ''].filter(Boolean);
    return `<li class="offer ${o === best ? 'best-row' : ''} ${o.isBaseline ? 'baseline-row' : ''} ${o.closed ? 'closed' : ''} ${o.ineligible || o.incomplete ? 'dim' : ''}" data-id="${esc(o.id)}">
      <details>
        <summary class="line">
          <span class="rank" aria-label="${pos >= 0 ? `rank ${pos + 1}` : 'not ranked'}">${pos >= 0 ? pos + 1 : '–'}</span>
          <span class="who"><span class="retailer">${esc(w.retailer)}</span><span class="plan">${esc(w.plan)}</span>${[o.elecPlan, o.gasPlan].filter((p) => p?.cardFlag).map((p) => `<span class="flag">${esc(p.cardFlag)}</span>`).join('')}</span>
          <span class="cost">${money0(o.annual)}<span class="per">/yr</span></span>
          <span class="diff ${o.isBaseline ? 'cur' : v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${esc(diff)}</span>
          <span class="chev" aria-hidden="true"></span><span class="sr">Learn more</span>
        </summary>
        <div class="more">
          ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
          <p class="small muted">${money(o.monthlyAvg)} a month on average${o.vsBaselineAnnual != null && !o.isBaseline ? ` · ${o.vsBaselineAnnual < 0 ? `${money(-o.vsBaselineAnnual)} a year less than your current plan` : `${money(o.vsBaselineAnnual)} a year more than your current plan`}` : ''}</p>
          ${rateLine(o.elecPlan)}${o.gasPlan && o.gasPlan !== o.elecPlan ? rateLine(o.gasPlan) : ''}
          ${altLines(o)}
          ${termLine(o.elecPlan)}${o.gasPlan && o.gasPlan !== o.elecPlan ? termLine(o.gasPlan) : ''}
          ${o.warnings.length ? `<div class="warn-text">${o.warnings.map(esc).join('<br>')}</div>` : ''}
          ${o.assumptions.length ? `<div class="assume"><strong>How it's costed:</strong><ul>${o.assumptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
          ${cond.length ? `<div class="cond"><strong>Conditions and credits (${cond.length}):</strong><ul>${cond.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
          <div class="srcs">${offerSource(o.elecPlan)}${o.gasPlan && o.gasPlan !== o.elecPlan ? offerSource(o.gasPlan) : ''}</div>
          <button type="button" class="ghost small" data-chart="${esc(o.id)}">Month-by-month chart</button>
        </div>
      </details>
    </li>`;
  }).join('');
  const total = offers.length;
  $('showAll').hidden = noUsage || total <= shown.length && !showAll;
  $('showAll').textContent = showAll ? 'Show top 5 only' : `Show all ${total} options`;
  $('showAll').setAttribute('aria-expanded', String(showAll));
  $('offerList').querySelectorAll('[data-chart]').forEach((b) => b.addEventListener('click', () => {
    selectedId = b.dataset.chart; renderMonthChart(offers.find((o) => o.id === selectedId), base);
    $('howPanel').open = true; document.querySelector('#howPanel details.charts').open = true;
    $('monthChart').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  renderUnavailable();
  renderLowStd();
  renderBarChart(comparable.slice(0, 12), best);
  const sel = offers.find((o) => o.id === selectedId) || best;
  renderMonthChart(sel, base);
}

function quoteTodo() {
  // Retailers that are open to new customers but need a manual quote (whole retailer, or some fuels/plans).
  return (DATA.providers || []).filter((p) => p.status !== 'closed' && !p.closedToNewCustomers && p.openToNewCustomers !== false && !p.notComparable)
    .filter((p) => !(p.planCount > 0) || p.manualQuote || (p.manualSnapshot && isStale(p.snapshotRetrievedAt)))
    .map((p) => ({ ...p, quoteUrl: p.manualQuote?.url || p.refreshUrl || p.url, partial: p.planCount > 0 }));
}
function renderUnavailable() {
  const statusText = { not_available_automatically: 'Needs manual quote', needs_review: 'Needs review', automatic: 'Partly priced' };
  const rows = quoteTodo();
  $('unavailableList').innerHTML = rows.map((p) => `<li><div><strong>${esc(p.name)}</strong> <span class="tag">${esc(p.snapshot ? `Snapshot only (${p.planCount} plans, retrieved ${new Date(p.snapshotRetrievedAt).toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland' })}) – needs a manual quote` : p.partial ? `Partly priced (${p.planCount} plans) – rest needs a manual quote` : p.manualStatus ? `Not priced: ${p.manualStatus}` : statusText[p.status] || p.status)}</span> <span class="small muted">${esc((p.fuels || []).join(' + '))}</span></div>
    <div class="small">${esc(p.reason || '')}</div>
    <div class="small"><a href="${esc(p.quoteUrl)}" target="_blank" rel="noopener">${esc(p.name)} quote page ↗</a>${p.quoteUrl !== p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">pricing page ↗</a>` : ''} <span class="muted">· checked ${fmtDateTime(p.checkedAt)}</span></div></li>`).join('') || '<li class="muted small">None.</li>';
  const closed = (DATA.providers || []).filter((p) => p.status === 'closed' || p.closedToNewCustomers);
  const nc = (DATA.providers || []).filter((p) => p.notComparable && !closed.includes(p));
  $('excludedNote').innerHTML = (closed.length ? `Excluded (closed to new customers or no longer selling, never ranked): ${closed.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.reason || '')}">${esc(p.name)}</a>`).join(', ')}.` : '')
    + (nc.length ? ` Not compared: ${nc.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.reason || '')}">${esc(p.name)}</a> (${esc(p.notComparable)})`).join(', ')}.` : '');
}

/** Does a published retailer plan match the rates printed on your bill? (Runs only in your browser.) */
function renderBaselineCheck() {
  const el = $('baselineCheck');
  const b = baseline()?.electricity;
  if (!b) { el.innerHTML = ''; return; }
  const same = (x, y) => Math.abs(x - y) < 0.006;
  const bi = (v) => inclGst(v, b.gstInclusive);
  const m = (DATA.plans || []).find((p) => p.fuel === 'electricity' && p.userType === b.userType && same(inclGst(p.dailyCents, p.gstInclusive), bi(b.dailyCents))
    && Object.keys(b.rates).length === Object.keys(p.rates).length && Object.entries(b.rates).every(([k, v]) => p.rates[k] !== undefined && same(inclGst(p.rates[k], p.gstInclusive), bi(v))));
  el.innerHTML = m
    ? `<div class="rec small">✔ <strong>Bill check:</strong> your current electricity rates (${(bi(b.dailyCents) / 100).toFixed(2)} $/day + ${Object.values(b.rates).map((v) => bi(v).toFixed(2) + 'c/kWh').join(', ')} incl. GST) exactly match <strong>${esc(m.provider)} – ${esc(m.name)} (${esc(m.userType)} user)</strong> ${m.source.method === 'snapshot' ? 'in its quote snapshot from' : 'as published on'} <a href="${esc(m.source.url)}" target="_blank" rel="noopener">${esc(shortUrl(m.source.url))}</a> (retrieved ${fmtDateTime(m.source.retrievedAt)}${m.source.method === 'snapshot' ? '; no longer fetched automatically' : ''}).</div>`
    : `<div class="rec small warnbox">⚠ <strong>Bill check:</strong> no published retailer plan matches the rates on your bill exactly. Your retailer may have changed prices since that bill, or doesn't publish them.</div>`;
}

function renderBarChart(offers, best) {
  const el = $('chart');
  if (!offers.length) { el.innerHTML = ''; return; }
  const W = 640, rowH = 26, left = 210, H = offers.length * rowH + 10;
  const max = Math.max(...offers.map((o) => o.annual)) * 1.1;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Annual cost by option">${offers.map((o, i) => {
    const w = ((W - left - 70) * o.annual) / max, y = i * rowH + 5;
    return `<text x="${left - 6}" y="${y + 15}" text-anchor="end">${esc(o.label.slice(0, 32))}</text>
      <rect class="bar ${o === best ? 'best' : ''} ${o.isBaseline ? 'base' : ''}" x="${left}" y="${y}" width="${Math.max(1, w)}" height="${rowH - 8}" rx="3"></rect>
      <text x="${left + w + 5}" y="${y + 15}">${money0(o.annual)}</text>`;
  }).join('')}</svg>`;
}

function renderMonthChart(sel, base) {
  const el = $('monthChart');
  if (!sel) { el.innerHTML = ''; return; }
  $('seasonalLabel').textContent = `(${sel.label}${base && base !== sel ? ' vs your current plan' : ''}; click a row above to change)` + (state.mode === 'seasonal' ? '' : ' Switch to month-by-month usage to see seasonal changes.');
  const series = [sel, ...(base && base !== sel ? [base] : [])];
  const W = 640, H = 220, pad = 34, bw = (W - pad * 2) / 12;
  const max = Math.max(...series.flatMap((s) => s.months.map((m) => m.total))) * 1.15 || 1;
  const n = series.length;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H + 20}" role="img" aria-label="Monthly cost">
    ${[0, 0.5, 1].map((f) => `<text x="2" y="${H - (H - 20) * f + 4}">${money0(max * f)}</text>`).join('')}
    ${series.map((s, si) => s.months.map((m, i) => {
      const h = ((H - 20) * m.total) / max, x = pad + i * bw + 4 + (si * (bw - 8)) / n;
      return `<rect class="bar ${si === 0 && !s.isBaseline ? 'best' : 'base'}" x="${x}" y="${H - h}" width="${(bw - 8) / n - 1}" height="${h}" rx="2"><title>${MONTH_NAMES[i]}: ${money(m.total)} (${s.label}) · ${Math.round(m.elecKwh)} kWh power, ${Math.round(m.gasKwh)} kWh gas</title></rect>`;
    }).join('')).join('')}
    ${MONTH_NAMES.map((mn, i) => `<text x="${pad + i * bw + bw / 2}" y="${H + 14}" text-anchor="middle">${mn}</text>`).join('')}
  </svg><p class="small muted">${series.map((s, i) => `<span class="tag">${i === 0 && !s.isBaseline ? '■ green' : '■ grey'}</span> ${esc(s.label)}: ${money0(s.annual)}/yr`).join(' · ')}</p>`;
}

function renderScenarioCompare() {
  const scen = [{ ...billsScenario() }, ...Object.values(load(LS.scenarios, {}))];
  const rows = scen.map((s) => {
    const o = rankOffers(allPlans(), costScenario(s), s.prefs || state.prefs, baseline());
    const best = o.find((x) => !x.incomplete && !x.ineligible && !x.closed), base = o.find((x) => x.isBaseline), a = annualKwh(s);
    return `<tr><td><strong>${esc(s.name)}</strong>${s.name === (state.name || MY_BILLS) ? ' <span class="tag">showing</span>' : ''}</td><td class="num">${Math.round(a.elec).toLocaleString()}</td><td class="num">${Math.round(a.gas).toLocaleString()}</td>
      <td class="num">${base ? money0(base.annual) : '—'}</td><td>${best ? esc(best.label) : '—'}</td><td class="num">${best ? money0(best.annual) : '—'}</td>
      <td class="num">${best && base ? money0(base.annual - best.annual) : '—'}</td></tr>`;
  });
  $('scenarioTable').innerHTML = `<thead><tr><th>Scenario</th><th class="num">Power kWh/yr</th><th class="num">Gas kWh/yr</th><th class="num">Current plan /yr</th><th>Cheapest open option</th><th class="num">Best /yr</th><th class="num">Saving /yr</th></tr></thead><tbody>${rows.join('')}</tbody>`;
}

// ---------- manual quotes ----------
/** Date input (YYYY-MM-DD, NZ) -> ISO timestamp. Today's date -> now; other dates -> noon NZ time that day. */
function dateToIso(d) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
  if (d === today) return new Date().toISOString();
  return new Date(`${d}T12:00:00+12:00`).toISOString();
}
function bindForm() {
  $('fDate').value = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
  const showRates = () => {
    const s = $('fStructure').value, gas = $('fFuel').value === 'gas';
    if (gas) $('fStructure').value = 'anytime';
    const want = gas || s === 'anytime' ? ['anytime'] : s === 'daynight' ? ['day', 'night'] : ['peak', 'offpeak', 'night'];
    document.querySelectorAll('#planForm [data-r]').forEach((l) => (l.style.display = want.includes(l.dataset.r) ? '' : 'none'));
    $('fStructure').disabled = gas;
  };
  const showOther = () => {
    const gas = $('fFuel').value === 'gas';
    $('fBoth').disabled = gas || $('fUserType').value === 'any';
    if ($('fBoth').disabled) $('fBoth').checked = false;
    $('otherVariant').hidden = !$('fBoth').checked;
    $('otherLabel').textContent = `Other version: ${$('fUserType').value === 'low' ? 'STANDARD' : 'LOW'} user (same structure, discounts and source)`;
  };
  ['fStructure', 'fFuel', 'fUserType', 'fBoth'].forEach((id) => $(id).addEventListener('change', () => { showRates(); showOther(); }));
  showRates(); showOther();
  $('planForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const num = (id) => ($(id).value === '' ? undefined : Number($(id).value));
    const fuel = $('fFuel').value, s = fuel === 'gas' ? 'anytime' : $('fStructure').value;
    const keys = s === 'anytime' ? ['anytime'] : s === 'daynight' ? ['day', 'night'] : ['peak', 'offpeak', 'night'];
    const rates = {};
    for (const k of keys) { const v = num('f' + k[0].toUpperCase() + k.slice(1)); if (v !== undefined) rates[k] = v; }
    const rates2 = {};
    for (const k of keys) { const v = num('f2' + k[0].toUpperCase() + k.slice(1)); if (v !== undefined) rates2[k] = v; }
    const provider = $('fProvider').value.trim();
    const bundle = {};
    if (num('fBundlePct')) bundle.pct = num('fBundlePct');
    if (num('fBundleCredit')) bundle.monthlyCreditDollars = num('fBundleCredit');
    const plan = {
      id: `manual-${Date.now().toString(36)}`, provider, name: $('fName').value.trim(), fuel,
      userType: fuel === 'gas' ? 'any' : $('fUserType').value, gstInclusive: $('fGst').value === 'true',
      dailyCents: num('fDaily'), rates, freeHours: $('fFree').checked || undefined,
      fixedTerm: $('fTerm').value === '' ? null : $('fTerm').value === 'true',
      discounts: { ...(num('fPrompt') ? { promptPaymentPct: num('fPrompt') } : {}), ...(num('fCredit') ? { monthlyCreditDollars: num('fCredit') } : {}), ...(Object.keys(bundle).length ? { bundle } : {}) },
      bundleGroup: provider.toLowerCase(),
      conditions: [$('fNotes').value.trim(), $('fBands').value.trim() ? `Time bands: ${$('fBands').value.trim()}` : ''].filter(Boolean),
      ...($('fBands').value.trim() ? { timeBands: { note: $('fBands').value.trim() } } : {}),
      ...($('fEffective').value ? { effectiveFrom: $('fEffective').value } : {}),
      source: { method: 'manual', url: $('fUrl').value.trim(), retrievedAt: dateToIso($('fDate').value) },
    };
    const toAdd = [plan];
    if ($('fBoth').checked) {
      const other = { ...plan, id: plan.id + '-v2', userType: plan.userType === 'low' ? 'standard' : 'low', dailyCents: num('f2Daily'), rates: rates2 };
      plan.variantGroup = other.variantGroup = plan.id;
      toAdd.push(other);
    }
    const errs = toAdd.flatMap((p, i) => validatePlan(p, i ? `${p.userType} version` : 'quote'));
    if (errs.length) { $('formMsg').innerHTML = `<span class="pos">${errs.map(esc).join('<br>')}</span>`; return; }
    const list = load(LS.manual, []); list.push(...toAdd); save(LS.manual, list);
    $('formMsg').textContent = `Added ${plan.provider} – ${plan.name} (${toAdd.map((p) => p.userType + ' user').join(' and ')}).`;
    renderManual(); renderBanner(); renderResults(); renderScenarioCompare(); renderSourcesTable();
  });
  $('exportPlans').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ plans: [...(DATA.plans || []).filter((p) => p.origin === 'manual').map(({ origin, ...p }) => p), ...load(LS.manual, [])] }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'manual-plans.json'; a.click();
  });
  $('importPlans').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const plans = Array.isArray(j) ? j : j.plans;
      const bad = plans.flatMap((p, i) => validatePlan(p, `plan ${i + 1}`));
      if (bad.length) throw new Error(bad.slice(0, 5).join('\n'));
      const list = load(LS.manual, []); const ids = new Set(list.map((p) => p.id));
      save(LS.manual, [...list, ...plans.filter((p) => !ids.has(p.id))]);
      renderManual(); renderBanner(); renderResults(); renderScenarioCompare();
    } catch (err) { alert('Import failed:\n' + err.message); }
    e.target.value = '';
  });
  renderManual();
  renderQuoteTodo();
}

function renderQuoteTodo() {
  const rows = quoteTodo();
  $('quoteTodo').innerHTML = rows.length ? `<thead><tr><th>Retailer</th><th>What's missing</th><th>Quote page</th><th></th></tr></thead><tbody>${rows.map((p) => `<tr>
    <td>${esc(p.name)}</td><td class="small">${esc(p.partial ? (p.manualQuote?.what || []).join(', ') || 'see reason' : (p.fuels || []).join(' + '))}</td>
    <td class="small"><a href="${esc(p.quoteUrl)}" target="_blank" rel="noopener">${esc(shortUrl(p.quoteUrl))} ↗</a></td>
    <td><button type="button" class="ghost small" data-fill="${esc(p.id)}">Fill form</button></td></tr>`).join('')}</tbody>` : '<tbody><tr><td class="muted">None.</td></tr></tbody>';
  $('quoteTodo').querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => {
    const p = rows.find((x) => x.id === b.dataset.fill);
    $('fProvider').value = p.name.replace(/\s*\(.*\)$/, ''); $('fUrl').value = p.quoteUrl; $('fName').focus();
  }));
}

function renderManual() {
  const list = load(LS.manual, []), repo = (DATA.plans || []).filter((p) => p.origin === 'manual');
  const row = (p, removable) => `<tr><td>${esc(p.provider)}</td><td>${esc(p.name)}</td><td>${esc(p.fuel)}</td><td>${userTag(p) || 'n/a'}</td>
    <td class="small">${round2(inclGst(p.dailyCents, p.gstInclusive))}c/day; ${Object.entries(p.rates).map(([k, v]) => `${k} ${round2(inclGst(v, p.gstInclusive))}c`).join(', ')}</td>
    <td class="small">${sourceCell(p)}</td><td>${removable ? `<button class="ghost small" data-del="${esc(p.id)}">Remove</button>` : '<span class="muted small">in repo</span>'}</td></tr>`;
  $('manualTable').innerHTML = list.length + repo.length
    ? `<thead><tr><th>Provider</th><th>Plan</th><th>Fuel</th><th>User</th><th>Rates (incl. GST)</th><th>Source</th><th></th></tr></thead><tbody>${repo.map((p) => row(p, false)).join('')}${list.map((p) => row(p, true)).join('')}</tbody>`
    : '<tbody><tr><td class="muted">No quotes yet.</td></tr></tbody>';
  $('manualTable').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    save(LS.manual, load(LS.manual, []).filter((p) => p.id !== b.dataset.del)); renderManual(); renderBanner(); renderResults(); renderScenarioCompare();
  }));
}

function renderProvidersList() {
  $('providerList').innerHTML = (DATA.providers || []).filter((p) => p.status !== 'closed').map((p) => `<option value="${esc(p.name)}">`).join('');
}

function renderSources() {
  const statusText = { not_available_automatically: 'Not available automatically', closed: 'Closed / not selling', needs_review: 'Needs review', automatic: 'Fetched automatically' };
  $('providerTable').innerHTML = `<thead><tr><th>Retailer</th><th>Fuels</th><th>Status</th><th class="num">Plans</th><th>Why</th><th>Checked</th></tr></thead><tbody>${
    (DATA.providers || [])
      .map((p) => `<tr><td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a></td><td class="small">${esc((p.fuels || []).join(', '))}</td><td class="small">${esc(statusText[p.status] || p.status)}</td><td class="num">${p.planCount || 0}</td><td class="small">${esc(p.reason || 'Rates fetched from the retailer\'s own website.')}</td><td class="small">${fmtDateTime(p.checkedAt)}${staleTag(p.checkedAt)}</td></tr>`).join('')}</tbody>`;
  const ne = DATA.networkCharges?.electricity, ng = DATA.networkCharges?.gas;
  const row = (r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.userType)} · ${esc(r.meter)} · ${esc(r.control)}</td><td class="num">${round2(r.dailyCentsExGst * 1.15)}c</td><td class="num">${r.anytimeCentsExGst != null ? round2(r.anytimeCentsExGst * 1.15) + 'c' : `${round2(r.offpeakCentsExGst * 1.15)}c / ${round2(r.peakCentsExGst * 1.15)}c`}</td></tr>`;
  let lines = '';
  if (ne) {
    const anyLow = ne.rows.find((r) => r.code === 'ARNLU');
    const est = anyLow ? (AVG_DAYS_PER_MONTH * anyLow.dailyCentsExGst + state.elecKwh * anyLow.anytimeCentsExGst) * 1.15 / 100 : null;
    lines += `<h3>Vector electricity lines charges (context only, not a retail price)</h3>
      <p class="small">These are what Vector charges retailers to deliver power on the Auckland network. They are included in every retailer's price, so they aren't a plan you can buy, but they show how much of a bill is fixed by the network.
      ${est ? `For your average month on a low-user anytime connection that's about <strong>${money(est)}</strong> of your power bill.` : ''}
      Effective from ${fmtDate(ne.effectiveFrom)} · <a href="${esc(ne.source.url)}" target="_blank" rel="noopener">${esc(ne.source.url)}</a> · retrieved ${fmtDateTime(ne.source.retrievedAt)}${staleTag(ne.source.retrievedAt)}${ne.stale ? ' · ⚠ stale (last fetch failed)' : ''}</p>
      <div class="table-wrap"><table class="compact"><thead><tr><th>Code</th><th>Type</th><th class="num">Daily (incl. GST)</th><th class="num">Per kWh (anytime, or off-peak / peak)</th></tr></thead><tbody>${ne.rows.map(row).join('')}</tbody></table></div>
      <p class="small muted">Vector peak periods (from 1 Apr 2026): May and Sep 5–10pm; Jun–Aug 7–11am and 5–10pm; Oct–Apr no peak.</p>`;
  }
  if (ng) {
    const g = ng.rows[0];
    lines += `<h3>Vector gas distribution charges (context only, not a retail price)</h3><p class="small">Residential (${esc(g.code)}): ${round2(g.dailyCentsExGst * 1.15)}c/day incl. GST, ${round2(g.variableCentsExGst * 1.15)}c/kWh. Effective from ${fmtDate(ng.effectiveFrom)} · <a href="${esc(ng.source.url)}" target="_blank" rel="noopener">${esc(ng.source.url)}</a> · retrieved ${fmtDateTime(ng.source.retrievedAt)}${staleTag(ng.source.retrievedAt)}${ng.stale ? ' · ⚠ stale' : ''}</p>`;
  }
  renderSourcesTable();
  $('networkInfo').innerHTML = lines + `<ul class="small">${(DATA.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
}

function renderAll() { renderInputs(); renderResults(); renderScenarioCompare(); }

init();

// ---------- low vs standard ----------
function renderLowStd() {
  const lfc = DATA.lowFixedCharge;
  $('lfcNote').innerHTML = lfc
    ? `<p>⚠ <strong>Being phased out:</strong> ${esc(lfc.summary)} Source: <a href="${esc(lfc.source.url)}" target="_blank" rel="noopener">MBIE</a>${lfc.checkedManually ? `, <a href="${esc(lfc.checkedManually.urls[1])}" target="_blank" rel="noopener">NZ Legislation</a>` : ''} (${lfc.autoVerified ? 'verified automatically' : 'checked by hand; the MBIE site blocks automated fetches'} ${fmtDateTime(lfc.source.retrievedAt)}).</p>`
    : '';
  const a = annualKwh(state).elec;
  const parts = [];
  const scen = costScenario({ ...state, gasKwh: 0, months: state.months.map((m) => ({ ...m, gasKwh: 0 })) });
  // Real fetched data: Vector's own low vs standard lines charges.
  const ne = DATA.networkCharges?.electricity;
  const vl = ne?.rows.find((r) => r.code === 'ARNLU'), vs = ne?.rows.find((r) => r.code === 'ARNSU');
  if (vl && vs) {
    const mk = (r, t) => ({ id: r.code, provider: 'Vector', name: r.code, fuel: 'electricity', userType: t, gstInclusive: false, dailyCents: r.dailyCentsExGst, rates: { anytime: r.anytimeCentsExGst }, source: {} });
    const c = compareLowStandard(mk(vl, 'low'), mk(vs, 'standard'), scen);
    parts.push(`<p class="small">Example from real data, Vector's <em>lines charges only</em> (anytime meter): low ${round2(vl.dailyCentsExGst * 1.15)}c/day + ${round2(vl.anytimeCentsExGst * 1.15)}c/kWh vs standard ${round2(vs.dailyCentsExGst * 1.15)}c/day + ${round2(vs.anytimeCentsExGst * 1.15)}c/kWh (incl. GST) break even at <strong>${c.breakEvenKwh?.toLocaleString() ?? '—'} kWh a year</strong>.</p>`);
  }
  const pairs = variantPairs([...allPlans(), ...(baseline()?.electricity ? [baseline().electricity] : [])]);
  const rows = pairs.map((g) => {
    if (g.low && g.standard) {
      const c = compareLowStandard(g.low, g.standard, scen);
      const rec = c.cheaper === 'same' ? 'About the same' : c.cheaper === 'low' ? '<strong>Low user</strong> is cheaper' : '<strong>Standard user</strong> is cheaper';
      return `<tr><td>${esc(g.low.provider)} – ${esc(g.low.name.replace(/\s*\(.*\)$/, ''))}</td><td class="num">${money0(c.lowAnnual)}</td><td class="num">${money0(c.stdAnnual)}</td><td class="num">${c.breakEvenKwh ? c.breakEvenKwh.toLocaleString() + ' kWh' : 'n/a'}</td><td>${rec} at ${Math.round(a).toLocaleString()} kWh/yr (${money0(Math.abs(c.diff))} a year difference)</td></tr>`;
    }
    const have = g.low || g.standard;
    const own = have.source?.method === 'bill';
    const cost = costOffer({ elecPlan: { ...have, discounts: {} } }, scen).annual;
    return `<tr><td>${esc(have.provider)} – ${esc(have.name)}${own ? ' <span class="tag bill">current</span>' : ''}</td><td class="num">${g.low ? money0(cost) : '—'}</td><td class="num">${g.standard ? money0(cost) : '—'}</td><td class="num">—</td>
      <td class="small">Only the ${have.userType}-user version is in the data. ${own ? `Your bills only show your current low-user rates. Get the ${have.provider} standard-user rates for your address from the retailer's own website and add them with "Also enter the other user-type version" to see the break-even.` : 'Add the other version of this quote to see the break-even.'}</td></tr>`;
  });
  const verdict = a <= 8000
    ? `<div class="rec">At <strong>${Math.round(a).toLocaleString()} kWh a year</strong> you are under the 8,000 kWh low-user threshold, so a <strong>low-user plan is likely cheaper</strong> for you while the rules still apply. Check the table below for the actual figures for each quote. After 1 April 2027 retailers can change or drop low-user plans, so check again then.</div>`
    : `<div class="rec">At <strong>${Math.round(a).toLocaleString()} kWh a year</strong> you are over 8,000 kWh, so a <strong>standard-user plan is likely cheaper</strong> (and low-user plans are meant for homes using less than that).</div>`;
  $('lowStdBody').innerHTML = verdict + parts.join('') +
    `<div class="table-wrap"><table><thead><tr><th>Plan</th><th class="num">Low user /yr</th><th class="num">Standard user /yr</th><th class="num">Break-even</th><th>For your usage</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="5" class="muted">No plans yet.</td></tr>'}</tbody></table></div>
    <p class="small muted">Electricity only, before bundle credits and prompt-payment discounts. For time-of-use plans the break-even uses your night/peak shares.</p>`;
}

function renderSourcesTable() {
  const rows = [
    ...(DATA.sources || []),
    ...load(LS.manual, []).map((p) => ({ url: p.source.url, label: `${p.provider} – ${p.name} (quote saved in this browser)`, retrievedAt: p.source.retrievedAt, status: 'manual' })),
  ];
  $('sourcesTable').innerHTML = `<thead><tr><th>Source</th><th>URL</th><th>Status</th><th>Retrieved</th></tr></thead><tbody>${rows.map((r) => `<tr>
      <td class="small">${esc(r.label || '')}</td>
      <td class="small"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></td>
      <td class="small"><span class="tag ${r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'failed' : 'manual'}">${esc(r.status)}</span>${r.httpStatus ? ` HTTP ${r.httpStatus}` : ''}${r.note ? ` <span class="muted">${esc(r.note)}</span>` : ''}</td>
      <td class="small">${fmtDateTime(r.retrievedAt)}${staleTag(r.retrievedAt)}</td></tr>`).join('')}
    <tr><td class="small">Your energy bills</td><td class="small muted">no URL. Usage and current-plan rates come from your my-usage.json file (loaded in your browser; not part of this site)</td><td class="small"><span class="tag manual">manual</span></td><td class="small">${USAGE?.currentPlan?.electricity?.source?.retrievedAt ? 'latest bill ' + fmtDate(USAGE.currentPlan.electricity.source.retrievedAt) : '—'}</td></tr></tbody>`;
}

// ---------- your bills (Genesis PDFs or a my-usage.json file), kept in this browser only ----------
function useBills(obj, msg = '✔ Bills file loaded and saved in this browser.') {
  const errs = validateUsageFile(obj);
  if (errs.length) throw new InvoiceError(`The bill figures did not pass the checks (${errs.slice(0, 4).join('; ')}).`, 'invalid');
  save(LS.usage, obj);
  USAGE = obj; USAGE_FROM = 'browser';
  state = billsScenario();
  showBillsMsg([{ text: msg }]);
  $('pasteBox').hidden = true;
  changed(true); renderBanner(); renderSources(); renderBillsSummary();
}

function showBillsMsg(items) {
  $('billsMsg').innerHTML = items.length ? `<ul>${items.map((m) => `<li class="${m.bad ? 'bad' : m.warn ? 'warn' : ''}">${esc(m.text)}</li>`).join('')}</ul>` : '';
}

const startsWithPdf = (buf) => /%PDF-/.test(new TextDecoder('latin1').decode(new Uint8Array(buf.slice(0, 1024))));
const isCsv = (f, buf) => !startsWithPdf(buf) && (/\.csv$/i.test(f.name || '') || /^text\/csv/i.test(f.type || '') || looksLikeHourlyCsv(new TextDecoder().decode(new Uint8Array(buf.slice(0, 200)))));
const looksJson = (f, buf) => /\.json$/i.test(f.name) || /json/i.test(f.type) || /^\s*[{[]/.test(new TextDecoder().decode(new Uint8Array(buf.slice(0, 64))));

/** Read the chosen / dropped files: Genesis PDF bills (parsed here, in the browser) and/or a my-usage.json file. */
async function importBillFiles(files) {
  files = [...files];
  if (!files.length) return;
  const msgs = [], parsed = [], csvRows = [];
  let json = null, csvFiles = 0;
  showBillsMsg([{ text: `Reading ${files.length} file(s) in this browser…` }]);
  $('usagePanel').open = true;
  for (const f of files) {
    let buf;
    try { buf = await f.arrayBuffer(); } catch { msgs.push({ bad: true, text: `${f.name}: the file could not be opened.` }); continue; }
    if (isCsv(f, buf)) {
      try { csvRows.push(...parseHourlyCsv(new TextDecoder().decode(buf)).rows); csvFiles++; }
      catch (e) { msgs.push({ bad: true, text: `${f.name}: ${e instanceof HourlyError ? e.message : 'this CSV could not be read as Genesis hourly usage.'}` }); }
    } else if (startsWithPdf(buf)) {
      try {
        const { pdfPages } = await import('./pdf-text.js');
        parsed.push({ name: f.name, inv: parseGenesisInvoice(await pdfPages(buf)) });
      } catch (e) {
        msgs.push({ bad: true, text: `${f.name}: ${e instanceof InvoiceError ? e.message : 'this PDF could not be read as a Genesis Energy bill.'}` });
      }
    } else if (looksJson(f, buf)) {
      let obj;
      try { obj = JSON.parse(new TextDecoder().decode(buf)); } catch { msgs.push({ bad: true, text: `${f.name}: this is not a valid bills JSON file (it could not be read as JSON). Choose your Genesis PDF bills or a my-usage.json file.` }); continue; }
      const errs = validateUsageFile(obj);
      if (errs.length) { msgs.push({ bad: true, text: `${f.name}: this JSON file is not a my-usage.json bills file (${errs.slice(0, 3).join('; ')}).` }); continue; }
      json = { name: f.name, obj };
    } else {
      msgs.push({ bad: true, text: `${f.name}: not a PDF, CSV or JSON file. Choose your Genesis Energy PDF bills, Genesis hourly usage CSVs or a my-usage.json file.` });
    }
  }
  if (csvRows.length) msgs.unshift(useHourly(csvRows, csvFiles));
  try {
    if (parsed.length) {
      const prev = USAGE_FROM === 'browser' && USAGE?.pdfImport ? USAGE.pdfImport : null;
      const known = new Set((prev?.invoices || []).map((x) => x.key));
      const newKeys = new Set(parsed.map((p) => p.inv.key).filter((k) => !known.has(k)));
      const skipped = parsed.length - newKeys.size;
      const u = mergeInvoices([...(prev?.invoices || []), ...parsed.map((p) => p.inv)], { overrides: prev?.overrides });
      const n = u.pdfImport.invoices.length, t = u.pdfImport.twelveMonthTotals;
      const ok = [{ text: `✔ Read ${parsed.length} Genesis bill PDF(s)${prev ? `, merged with the ${prev.invoices.length} already in this browser` : ''}: ${n} bill(s) in use${skipped ? `, ${skipped} repeated bill(s) skipped` : ''}. Electricity ${u.coverage.electricity || 'not on these bills'}; gas ${u.coverage.gas || 'not on these bills'}. 12-month usage: ${t.elecKwh.toLocaleString()} kWh electricity, ${t.gasKwh.toLocaleString()} kWh gas. Saved in this browser only.` }];
      if (json) ok.push({ warn: true, text: `${json.name}: ignored, because PDF bills were chosen at the same time.` });
      for (const p of parsed) for (const w of p.inv.warnings) ok.push({ warn: true, text: `⚠ ${p.name}: ${w}. Check the figures below.` });
      useBills(u, '');
      showBillsMsg([...ok, ...msgs]);
      $('billsSummary').open = true;
      return;
    }
    if (json) { useBills(json.obj, ''); showBillsMsg([{ text: `✔ ${json.name} loaded and saved in this browser.` }, ...msgs]); return; }
  } catch (e) {
    msgs.push({ bad: true, text: e instanceof InvoiceError ? e.message : 'Your bills could not be combined. Please check the files and try again.' });
  }
  showBillsMsg(msgs.length ? msgs : [{ bad: true, text: 'Nothing was loaded.' }]);
}

const fmtC = (c) => (c == null ? '–' : `${Number(c).toFixed(2)}c`);
const inclC = (c) => (c == null ? '' : ` (${(c * 1.15).toFixed(2)}c incl. GST)`);

/** Table of what was read from each PDF bill, with editable kWh, include/exclude, and current-plan rates. */
function renderBillsSummary() {
  const box = $('billsSummary'), body = $('billsSummaryBody');
  const imp = USAGE_FROM === 'browser' ? USAGE?.pdfImport : null;
  if (!imp) { box.hidden = true; body.innerHTML = ''; return; }
  box.hidden = false;
  const rows = [];
  imp.invoices.forEach((inv, i) => {
    for (const fuel of ['electricity', 'gas']) {
      const f = inv.fuels[fuel]; if (!f) continue;
      const credits = fuel === 'electricity' ? (inv.credits || []).map((c) => `${c.label} $${c.amountInclGst.toFixed(2)} cr`) : [];
      const disc = [...f.discounts.map((d) => `${d.label} ${d.pct}%`), ...credits].join('; ') || '–';
      rows.push(`<tr><td>${esc(fmtDate(inv.statementDate))}</td><td>${fuel === 'electricity' ? 'Electricity' : 'Gas'}</td>
        <td>${esc(f.start || '?')} to ${esc(f.end || '?')}</td><td class="num">${f.days ?? '–'}</td>
        <td class="num"><input type="number" min="0" step="1" data-inv="${i}" data-fuel="${fuel}" class="kwhEdit" value="${f.kwhEdited ?? f.kwh}" aria-label="kWh"/>${f.kwhEdited != null ? ` <span class="tag">edited (bill: ${f.kwh})</span>` : ''}${f.gasVolumeM3 != null ? `<br><span class="muted">${f.gasVolumeM3} m³ → ${f.gasKwhFromVolume} kWh</span>` : ''}</td>
        <td class="small">${f.unitLines.map((u) => `${esc(u.label)}: ${u.kwh} kWh @ ${fmtC(u.cents)}/kWh`).join('<br>')}<br>${f.dailyLines.map((d) => `${esc(d.label)}: ${d.days} days @ ${fmtC(d.cents)}/day`).join('<br>')}<br><span class="muted">${f.gstBasis === 'excl' ? 'rates excl. GST (15% GST added on the bill)' : 'GST basis not confirmed'}</span></td>
        <td class="small">${esc(disc)}</td>
        <td class="num">$${(f.netInclGst ?? 0).toFixed(2)}</td>
        <td><input type="checkbox" class="useEdit" data-inv="${i}" data-fuel="${fuel}" ${inv.excluded?.[fuel] ? '' : 'checked'} aria-label="use this bill"/></td></tr>`);
    }
  });
  const cp = USAGE.currentPlan || {};
  const field = (id, label, v, step = '0.01') => `<label>${label}<input type="number" min="0" step="${step}" id="${id}" value="${v ?? ''}"/></label>`;
  const e = cp.electricity, g = cp.gas;
  const credit = e?.discounts?.bundle?.monthlyCreditDollars ?? g?.discounts?.bundle?.monthlyCreditDollars ?? 0;
  body.innerHTML = `
    <p class="small">${imp.invoices.length} bill(s) in use${imp.duplicatesSkipped ? `, ${imp.duplicatesSkipped} repeated bill(s) skipped` : ''}${imp.overlaps?.length ? `; ${imp.overlaps.length} overlapping period(s): the later bill was used for the overlapping days` : ''}.
      Electricity: ${esc(USAGE.coverage?.electricity || 'none')}. Gas: ${esc(USAGE.coverage?.gas || 'none')}. ${esc(USAGE.coverage?.months || '')}
      12-month usage: <strong>${imp.twelveMonthTotals.elecKwh.toLocaleString()} kWh</strong> electricity, <strong>${imp.twelveMonthTotals.gasKwh.toLocaleString()} kWh</strong> gas.</p>
    <div class="table-wrap"><table><thead><tr><th>Bill date</th><th>Fuel</th><th>Period</th><th class="num">Days</th><th class="num">kWh</th><th>Plan lines and rates</th><th>Discounts / credits</th><th class="num">Charged</th><th>Use</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <h4>Your current plan (from your latest bill${e?.source?.retrievedAt ? `, ${esc(fmtDate(e.source.retrievedAt))}` : ''}; excl. GST as printed)</h4>
    <div class="plan-edit">
      ${e ? `<strong>${esc(e.name)}</strong>${field('cpEDaily', 'Electricity daily (c/day)', e.dailyCents)}${Object.entries(e.rates).map(([k, v]) => field(`cpERate-${k}`, `Electricity ${k} (c/kWh)`, v)).join('')}` : '<span class="muted">No electricity on these bills.</span>'}
    </div>
    <div class="plan-edit">
      ${g ? `<strong>${esc(g.name)}</strong>${field('cpGDaily', 'Gas daily (c/day)', g.dailyCents)}${field('cpGRate', 'Gas (c/kWh)', g.rates.anytime)}` : '<span class="muted">No gas on these bills.</span>'}
      ${field('cpCredit', 'Monthly bundle credit ($ incl. GST)', credit)}
    </div>
    <p class="small muted">Rates incl. GST: ${e ? `electricity ${fmtC(e.rates.anytime ?? Object.values(e.rates)[0])}/kWh${inclC(e.rates.anytime ?? Object.values(e.rates)[0])}, ${fmtC(e.dailyCents)}/day${inclC(e.dailyCents)}` : ''}${g ? `; gas ${fmtC(g.rates.anytime)}/kWh${inclC(g.rates.anytime)}, ${fmtC(g.dailyCents)}/day${inclC(g.dailyCents)}` : ''}.</p>
    <button type="button" id="applyBillEdits">Apply changes</button> <button type="button" id="undoBillEdits" class="ghost">Undo my edits</button>`;
  $('applyBillEdits').addEventListener('click', applyBillEdits);
  $('undoBillEdits').addEventListener('click', () => {
    const invoices = imp.invoices.map((inv) => ({ ...inv, excluded: undefined, fuels: Object.fromEntries(Object.entries(inv.fuels).map(([k, f]) => [k, { ...f, kwhEdited: undefined }])) }));
    rebuildFromInvoices(invoices, {}, '✔ Your edits were undone; figures are as read from the bills.');
  });
}

function rebuildFromInvoices(invoices, overrides, msg) {
  try { useBills(mergeInvoices(invoices, { overrides }), msg); $('billsSummary').open = true; }
  catch (e) { showBillsMsg([{ bad: true, text: e instanceof InvoiceError ? e.message : 'Those changes could not be applied.' }]); }
}

function applyBillEdits() {
  const imp = USAGE.pdfImport;
  const invoices = imp.invoices.map((inv) => ({ ...inv, excluded: { ...(inv.excluded || {}) }, fuels: Object.fromEntries(Object.entries(inv.fuels).map(([k, f]) => [k, { ...f }])) }));
  document.querySelectorAll('#billsSummaryBody .kwhEdit').forEach((el) => {
    const f = invoices[+el.dataset.inv].fuels[el.dataset.fuel]; const v = Number(el.value);
    f.kwhEdited = el.value !== '' && Number.isFinite(v) && v >= 0 && v !== f.kwh ? v : undefined;
  });
  document.querySelectorAll('#billsSummaryBody .useEdit').forEach((el) => { invoices[+el.dataset.inv].excluded[el.dataset.fuel] = !el.checked || undefined; });
  const base = mergeInvoices(invoices, {}).currentPlan; // as read from the bills
  const num = (id) => { const el = $(id); return el && el.value !== '' && Number(el.value) >= 0 ? Number(el.value) : null; };
  const overrides = {};
  const set = (fuel, key, v, was) => { if (v != null && v !== was) (overrides[fuel] ||= {})[key] = v; };
  if (base.electricity) {
    set('electricity', 'dailyCents', num('cpEDaily'), base.electricity.dailyCents);
    const rates = {};
    for (const k of Object.keys(base.electricity.rates)) { const v = num(`cpERate-${k}`); if (v != null && v !== base.electricity.rates[k]) rates[k] = v; }
    if (Object.keys(rates).length) (overrides.electricity ||= {}).rates = rates;
  }
  if (base.gas) {
    set('gas', 'dailyCents', num('cpGDaily'), base.gas.dailyCents);
    const v = num('cpGRate'); if (v != null && v !== base.gas.rates.anytime) (overrides.gas ||= {}).rates = { anytime: v };
  }
  const credit = num('cpCredit'), wasCredit = base.electricity?.discounts?.bundle?.monthlyCreditDollars ?? base.gas?.discounts?.bundle?.monthlyCreditDollars ?? 0;
  if (credit != null && credit !== wasCredit) for (const f of ['electricity', 'gas']) if (base[f]) (overrides[f] ||= {}).monthlyCreditDollars = credit;
  rebuildFromInvoices(invoices, overrides, '✔ Your changes were applied and saved in this browser.');
}

/** Merge hourly rows into this browser's store (de-duplicated by timestamp) and return a message. */
function useHourly(rows, files) {
  const before = new Set(HOURLY.map((r) => r.key));
  const added = new Set(rows.map((r) => r.key).filter((k) => !before.has(k))).size;
  HOURLY = mergeHourly(HOURLY, rows);
  save(LS.hourly, HOURLY);
  const c = hourlyCoverage(HOURLY);
  const dup = rows.length - added;
  changed(true);
  return { text: `✔ Read ${files} Genesis hourly usage CSV(s): ${added} new hour(s)${dup ? `, ${dup} already loaded (same timestamp, replaced)` : ''}. Hourly data now covers ${c.text}, ${c.hours} hours, ${c.kwh.toLocaleString('en-NZ')} kWh${c.incompleteDays.length ? `; incomplete days: ${c.incompleteDays.join(', ')}` : ''}. The dollars column is ignored. Saved in this browser only.` };
}

function renderHourlyInfo() {
  const el = $('hourlyInfo'); if (!el) return;
  const c = hourlyCoverage(HOURLY), sc = seasonCoverage(HOURLY);
  $('useHourlyRow').hidden = !c;
  const wbox = $('winterWeights');
  wbox.hidden = !(c && sc.winter && sc.spring && state.useHourly !== false);
  if (!c) { el.innerHTML = 'Load your Genesis hourly usage CSVs (with <em>Load my bills</em>) to compute each time-of-use plan\'s split from your own hourly use.'; wbox.innerHTML = ''; return; }
  $('useHourly').checked = state.useHourly !== false;
  const seasons = [sc.winter && `winter shape from ${esc(sc.winter.text)}`, sc.spring && `spring shape from ${esc(sc.spring.text)}`].filter(Boolean).join('; ');
  el.innerHTML = `<strong>Hourly data loaded:</strong> ${c.days} days, ${c.hours} hours${c.dstDays.length ? ` (incl. daylight-saving day(s) ${c.dstDays.map(esc).join(', ')})` : ''}${c.incompleteDays.length ? `; incomplete days: ${c.incompleteDays.map(esc).join(', ')}` : ''}: ${seasons}.
    ${state.useHourly !== false ? 'Time-of-use plans with stated hours use splits from your hourly data for their own bands, applied to each month\'s kWh from your bills; the shares above apply to other plans (e.g. Powershop, whose peak hours are not stated).' : 'Not used: the shares above apply to every plan.'}
    ${!sc.winter ? '⚠ Your hourly data covers only spring, so winter heating may shift the split.' : !sc.spring ? '⚠ Your hourly data covers only winter; summer use may differ.' : 'Dec–Feb use the spring shape (no summer data).'}`;
  if (!wbox.hidden) {
    const w = winterWeights(state);
    wbox.innerHTML = `<legend class="small">Winter shape used per month (%; the rest uses the spring shape)</legend>${MON.map((m, i) => `<label class="small">${m}<input type="number" min="0" max="100" step="1" data-w="${i}" value="${Math.round(w[i] * 100)}"/></label>`).join('')} <button type="button" class="ghost small" id="resetWeights">Reset</button>`;
    wbox.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
      const ww = [...winterWeights(state)]; ww[+inp.dataset.w] = Math.max(0, Math.min(100, Number(inp.value) || 0)) / 100; state.winterWeights = ww; changed();
    }));
    $('resetWeights').addEventListener('click', () => { delete state.winterWeights; changed(true); });
  }
}

function bindBills() {
  $('useHourly').addEventListener('change', (e) => { state.useHourly = e.target.checked; changed(true); });
  $('loadBills').addEventListener('change', async (e) => { await importBillFiles(e.target.files); e.target.value = ''; });
  const drop = $('billsDrop');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); drop.classList.add('dragover'); } });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('dragover'); });
  document.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); drop.classList.remove('dragover'); importBillFiles(e.dataTransfer.files); });
  $('pasteBillsBtn').addEventListener('click', () => { $('pasteBox').hidden = !$('pasteBox').hidden; if (!$('pasteBox').hidden) $('pasteBills').focus(); });
  $('pasteBillsLoad').addEventListener('click', () => {
    let obj;
    try { obj = JSON.parse($('pasteBills').value); } catch { showBillsMsg([{ bad: true, text: 'The pasted text is not valid JSON. Paste the whole contents of your my-usage.json file.' }]); return; }
    try { useBills(obj); $('pasteBills').value = ''; } catch (err) { showBillsMsg([{ bad: true, text: err instanceof InvoiceError ? err.message : 'The pasted JSON could not be used.' }]); }
  });
  $('forgetBills').addEventListener('click', () => {
    if (!confirm('Remove your bills data (usage, hourly usage and current plan) from this browser? Saved scenarios and quotes are kept.')) return;
    localStorage.removeItem(LS.usage); localStorage.removeItem(LS.state); localStorage.removeItem(LS.hourly);
    USAGE = null; USAGE_FROM = null; HOURLY = []; state = billsScenario();
    showBillsMsg([{ text: 'Removed your bills from this browser.' }]);
    changed(true); renderBanner(); renderSources(); renderBillsSummary();
  });
}
