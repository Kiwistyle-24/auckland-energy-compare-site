// Read Genesis Energy PDF invoices (text already extracted by pdf.js) into usage and current-plan figures.
// Pure functions, no DOM and no network: used in the browser (the PDF never leaves it) and by the Node tests.
// Only usage, periods, plan line names, rates and credits are kept. Names, addresses, customer/statement/ICP
// numbers and meter serials are never stored.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE = '(\\d{1,2}\\s+[A-Za-z]{3}\\s+\\d{4})';
const MONEY = '([\\d,]+\\.\\d{2})';
const num = (s) => Number(String(s).replace(/,/g, ''));
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const DAY = 86400000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const tOf = (iso) => Date.parse(iso + 'T00:00:00Z');
const DIM = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** "5 Oct 2026" -> "2026-10-05" (null if not a date). */
export function parseDate(s) {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(String(s || '').trim());
  if (!m || !MONTHS[m[2].toLowerCase()]) return null;
  return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Error with a plain-language message that can be shown to the user as-is. */
export class InvoiceError extends Error {
  constructor(message, code) { super(message); this.name = 'InvoiceError'; this.code = code; }
}

/**
 * pdf.js text items of one page -> text lines (items on the same baseline joined left to right).
 * items: [{ str, transform: [a, b, c, d, x, y] }]
 */
export function itemsToLines(items) {
  const rows = [];
  for (const it of items || []) {
    if (typeof it?.str !== 'string' || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= 2);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, s: it.str });
  }
  return rows.sort((a, b) => b.y - a.y)
    .map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Is this the text of a Genesis Energy invoice? */
export function looksLikeGenesisInvoice(text) {
  return /Genesis Energy/i.test(text) && /GST Tax Invoice/i.test(text) && /Account Date/i.test(text);
}

const UNIT_LINE = /^(.*?)\s+(?:(\S+)\s+(\d+)\s+(\d+)\s+([A-Za-z]+)\s+)?(\d[\d,]*(?:\.\d+)?)\s*(?:kWh\s+)?@?\s*(\d+(?:\.\d+)?)\s+c\/unit\s+(-?[\d,]+\.\d{2})$/;
const DAILY_LINE = /^(.*?)\s+(\d+)\s+days?\s+@?\s*(\d+(?:\.\d+)?)\s+c\/day\s+(-?[\d,]+\.\d{2})$/;
const GAS_METER = /^\S+\s+\d+\s+\d+\s+[A-Za-z]+\s+(\d+(?:\.\d+)?)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+(?:\.\d+)?)$/;
const DISCOUNT_LINE = /^(.*?Discount.*?)\s+(\d+(?:\.\d+)?)%\s+([\d,]+\.\d{2})\s*cr$/i;

function section(lines, startRe, endRe) {
  const s = lines.findIndex((l) => startRe.test(l));
  if (s < 0) return null;
  let e = lines.findIndex((l, i) => i > s && endRe.test(l));
  if (e < 0) e = Math.min(lines.length - 1, s + 60);
  // The "Covers the N day period from A to B" line sits just above the usage table on the same page.
  let period = null;
  for (let i = s; i >= Math.max(0, s - 25) && !period; i--) {
    const m = new RegExp(`Covers the (\\d+) day period from ${DATE} to ${DATE}`).exec(lines[i]);
    if (m) period = { days: Number(m[1]), start: parseDate(m[2]), end: parseDate(m[3]) };
  }
  return { lines: lines.slice(s + 1, e + 1), period, totalLine: lines[e] };
}

function readFuel(sec, fuel) {
  const units = [], daily = [], discounts = [], warnings = [];
  let subtotal = null, gst = null, total = null, discountTotal = 0, volume = null;
  for (const l of sec.lines) {
    let m;
    if (fuel === 'gas' && (m = GAS_METER.exec(l))) { volume = { m3: (volume?.m3 || 0) + num(m[1]), kwh: (volume?.kwh || 0) + num(m[4]), factor: num(m[2]), calorific: num(m[3]) }; continue; }
    if ((m = DAILY_LINE.exec(l))) { daily.push({ label: m[1].trim(), days: Number(m[2]), cents: num(m[3]), amount: num(m[4]) }); continue; }
    if ((m = UNIT_LINE.exec(l))) { units.push({ label: m[1].trim(), kwh: num(m[6]), cents: num(m[7]), amount: num(m[8]), read: m[5] || null }); continue; }
    if ((m = DISCOUNT_LINE.exec(l))) { discounts.push({ label: m[1].replace(/\s+(Elec|Gas)$/i, '').trim(), pct: num(m[2]), amount: num(m[3]) }); continue; }
    if ((m = /^Total Discounts.*?([\d,]+\.\d{2})\s*cr$/i.exec(l))) { discountTotal = num(m[1]); continue; }
    if ((m = new RegExp(`^Sub Total\\s+${MONEY}$`).exec(l))) subtotal = num(m[1]);
    else if ((m = new RegExp(`^GST\\s+${MONEY}$`).exec(l))) gst = num(m[1]);
    else if ((m = new RegExp(`^Total Charges\\s+${MONEY}$`).exec(l))) total = num(m[1]);
  }
  const fin = new RegExp(`\\$\\s*${MONEY}`).exec(sec.totalLine || '');
  let kwh = r2(units.reduce((t, u) => t + u.kwh, 0));
  if (!units.length && volume) {
    // No energy line: convert the gas volume as the bill does (m3 x meter factor x calorific value).
    kwh = Math.round(volume.kwh || volume.m3 * volume.factor * volume.calorific);
  }
  if (fuel === 'gas' && volume && units.length && Math.abs(volume.kwh - kwh) > 1) warnings.push(`gas kWh on the charge lines (${kwh}) differ from the meter conversion (${volume.kwh})`);
  const charged = r2(units.reduce((t, u) => t + u.amount, 0) + daily.reduce((t, d) => t + d.amount, 0));
  const gstBasis = subtotal != null && gst != null && total != null && Math.abs(r2(subtotal + gst) - total) < 0.02 && Math.abs(charged - subtotal) < 0.05 ? 'excl' : 'unknown';
  if (subtotal != null && Math.abs(charged - subtotal) >= 0.05) warnings.push(`${fuel} charge lines add up to $${charged.toFixed(2)}, not the sub total $${subtotal.toFixed(2)}`);
  const dDays = daily.reduce((t, d) => t + d.days, 0);
  if (sec.period && dDays && dDays !== sec.period.days) warnings.push(`${fuel} daily-charge days (${dDays}) differ from the ${sec.period.days}-day period`);
  if (!sec.period) warnings.push(`${fuel} billing period not found`);
  if (!units.length && !volume) warnings.push(`no ${fuel} usage lines found`);
  return {
    start: sec.period?.start || null, end: sec.period?.end || null, days: sec.period?.days || dDays || null,
    kwh, unitLines: units.map(({ label, kwh: k, cents, amount }) => ({ label, kwh: k, cents, amount })), dailyLines: daily,
    ...(volume ? { gasVolumeM3: volume.m3, gasKwhFromVolume: volume.kwh } : {}),
    estimatedRead: units.some((u) => /estim/i.test(u.read || '')),
    subtotalExclGst: subtotal, gst, totalInclGst: total, gstBasis,
    discounts, discountTotalInclGst: discountTotal, netInclGst: fin ? num(fin[1]) : total,
    warnings,
  };
}

/**
 * Parse one Genesis invoice. pages: array of pages, each an array of text lines (see itemsToLines).
 * Throws InvoiceError with a plain message if it is not a Genesis invoice or has no usage.
 */
export function parseGenesisInvoice(pages) {
  const lines = pages.flat().map((l) => String(l).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = lines.join('\n');
  if (!looksLikeGenesisInvoice(text)) throw new InvoiceError('This PDF is not a recognised Genesis Energy bill (no Genesis tax invoice details found).', 'not_genesis');
  let statementDate = null;
  const ad = lines.findIndex((l) => /Account Date/i.test(l));
  for (let i = ad; i >= 0 && i <= ad + 3 && !statementDate; i++) {
    const m = new RegExp(`${DATE}\\s*$`).exec(lines[i].replace(/^.*Account Date/i, '')); if (m) statementDate = parseDate(m[1]);
  }
  const due = new RegExp(`Total Amount Due by ${DATE}\\s+\\$\\s*${MONEY}`).exec(text);
  const gstAll = /includes GST of \$\s*([\d,]+\.\d{2})/i.exec(text);
  const acct = /Your (.+?) Account\b/.exec(text);
  const fuels = {};
  const e = section(lines, /^Current Electricity Usage$/i, /^TOTAL CURRENT ELECTRICITY CHARGES/i);
  if (e) fuels.electricity = readFuel(e, 'electricity');
  const g = section(lines, /^Current Natural Gas Usage$/i, /^TOTAL CURRENT NATURAL GAS CHARGES/i);
  if (g) fuels.gas = readFuel(g, 'gas');
  if (!Object.keys(fuels).length) throw new InvoiceError('This looks like a Genesis Energy document, but no electricity or gas usage could be found in it.', 'no_usage');
  if (!statementDate) throw new InvoiceError('This Genesis Energy bill has no readable account date.', 'no_date');

  // Other transactions (account credits such as a monthly bundle reward or Power Shout credits), listed excl. GST.
  const credits = [];
  const os = lines.findIndex((l) => /^Other Transactions$/i.test(l));
  if (os >= 0) {
    let sub = null, gst = null, tot = null;
    for (let i = os + 1; i < lines.length && i < os + 40; i++) {
      const l = lines[i]; let m;
      if ((m = new RegExp(`^${DATE}\\s+(.+?)\\s+([\\d,]+\\.\\d{2})\\s*cr$`).exec(l))) credits.push({ date: parseDate(m[1]), label: m[2], amountExclGst: num(m[3]) });
      else if ((m = /^Sub Total\s+([\d,]+\.\d{2})\s*cr$/i.exec(l))) sub = num(m[1]);
      else if ((m = /^GST\s+([\d,]+\.\d{2})\s*cr$/i.exec(l))) gst = num(m[1]);
      else if ((m = /^TOTAL OTHER TRANSACTIONS\s+\$\s*([\d,]+\.\d{2})\s*cr$/i.exec(l))) { tot = num(m[1]); break; }
    }
    const s = sub ?? credits.reduce((t, c) => t + c.amountExclGst, 0);
    for (const c of credits) c.amountInclGst = gst != null && s ? r2(c.amountExclGst + (gst * c.amountExclGst) / s) : r2(c.amountExclGst * 1.15);
    if (tot != null && credits.length === 1) credits[0].amountInclGst = tot;
  }
  return {
    provider: 'Genesis Energy', statementDate, dueDate: due ? parseDate(due[1]) : null, totalDue: due ? num(due[2]) : null,
    gstOnInvoice: gstAll ? num(gstAll[1]) : null, accountType: acct ? acct[1] : null,
    fuels, credits,
    key: `genesis|${statementDate}|${due ? due[2] : ''}`,
    warnings: Object.values(fuels).flatMap((f) => f.warnings),
  };
}

// ---------- merging several invoices into a usage profile ----------

const SEASONS = { summer_Dec_Feb: [12, 1, 2], autumn_Mar_May: [3, 4, 5], winter_Jun_Aug: [6, 7, 8], spring_Sep_Nov: [9, 10, 11] };

/** Drop repeated invoices (same statement date and amount). Returns { invoices, duplicates }. */
export function dedupeInvoices(list) {
  const seen = new Map(), duplicates = [];
  for (const inv of list) { if (seen.has(inv.key)) duplicates.push(inv); else seen.set(inv.key, inv); }
  return { invoices: [...seen.values()].sort((a, b) => a.statementDate.localeCompare(b.statementDate)), duplicates };
}

/** Per-day kWh for one fuel; where periods overlap, the later statement wins. */
function dailyMap(invoices, fuel) {
  const d = new Map(), overlaps = [];
  for (const inv of invoices) {
    const f = inv.fuels[fuel];
    if (!f || inv.excluded?.[fuel] || !f.start || !f.end || !(f.days > 0)) continue;
    const kwh = f.kwhEdited ?? f.kwh;
    const per = kwh / f.days;
    let overlap = 0;
    for (let t = tOf(f.start); t <= tOf(f.end); t += DAY) { if (d.has(t)) overlap++; d.set(t, per); }
    if (overlap) overlaps.push({ statementDate: inv.statementDate, fuel, days: overlap });
  }
  return { d, overlaps };
}

function monthly(d) {
  const m = new Map();
  for (const [t, v] of d) { const k = isoDay(t).slice(0, 7); const x = m.get(k) || { days: 0, kwh: 0 }; x.days++; x.kwh += v; m.set(k, x); }
  return m;
}

/** Most recent 12 consecutive, fully covered calendar months (YYYY-MM keys) or null. */
export function latestFullYear(byMonth) {
  const full = [...byMonth.entries()].filter(([k, v]) => { const [y, mo] = k.split('-').map(Number); return v.days >= DIM(y, mo); }).map(([k]) => k).sort();
  for (let end = full.length - 1; end >= 11; end--) {
    const win = full.slice(end - 11, end + 1);
    const idx = (k) => { const [y, mo] = k.split('-').map(Number); return y * 12 + mo; };
    if (idx(win[11]) - idx(win[0]) === 11) return win;
  }
  return null;
}

function gaps(d) {
  const ts = [...d.keys()].sort((a, b) => a - b);
  let n = 0; for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > DAY) n++;
  return n;
}

/** Rate key for a unit-charge line label (single-rate bills -> anytime). */
function rateKey(label) {
  return /night/i.test(label) ? 'night' : /off.?peak/i.test(label) ? 'offpeak' : /peak/i.test(label) ? 'peak' : /controlled/i.test(label) ? 'controlled' : /\bday\b/i.test(label) ? 'day' : 'anytime';
}

const fmtNz = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Current plan for one fuel from the latest invoice that has it (the last-listed lines are the newest prices). */
function planFrom(invoices, fuel, overrides = {}) {
  const withFuel = invoices.filter((i) => i.fuels[fuel] && !i.excluded?.[fuel]);
  const inv = withFuel[withFuel.length - 1];
  if (!inv) return null;
  const f = inv.fuels[fuel];
  const lastUnit = f.unitLines[f.unitLines.length - 1], lastDaily = f.dailyLines[f.dailyLines.length - 1];
  if (!lastUnit || !lastDaily) return null;
  // Lines of the current tariff: same name "family" as the last line (e.g. two registers of one plan).
  const current = f.unitLines.filter((u) => u.label === lastUnit.label || (rateKey(u.label) !== 'anytime' && f.unitLines.indexOf(u) >= f.unitLines.length - 2));
  const rates = {};
  for (const u of current) rates[rateKey(u.label)] = u.cents;
  // When did these rates start? The first invoice showing them; mid-period changes use the days on the new daily line.
  let started = null;
  for (const i of withFuel) {
    const x = i.fuels[fuel];
    const k = x.dailyLines.findIndex((dl) => dl.label === lastDaily.label && dl.cents === lastDaily.cents);
    if (k < 0) continue;
    if (k > 0 && x.end) started = `~${fmtNz(isoDay(tOf(x.end) - (x.dailyLines[k].days - 1) * DAY))}`;
    else if (i !== withFuel[0] && x.start) started = fmtNz(x.start);
    break;
  }
  const ov = overrides[fuel] || {};
  const pct = (re) => f.discounts.filter((d) => re.test(d.label)).reduce((t, d) => t + d.pct, 0);
  const dualPct = pct(/dual fuel/i), payPct = pct(/ebill|credit card|direct debit|prompt/i);
  const bundleCredit = (inv.credits || []).filter((c) => /bundle\s+reward/i.test(c.label)).reduce((t, c) => t + c.amountInclGst, 0);
  const monthly = ov.monthlyCreditDollars ?? (bundleCredit ? r2(bundleCredit) : 0);
  const discounts = {};
  if (monthly || dualPct) discounts.bundle = { ...(monthly ? { monthlyCreditDollars: monthly } : {}), ...(dualPct ? { pct: dualPct } : {}), note: monthly ? 'Monthly bundle reward credit on your bill (electricity + gas).' : 'Dual-fuel discount on your bill.' };
  if (payPct) discounts.promptPaymentPct = payPct;
  const name = fuel === 'electricity'
    ? `${/low/i.test(lastUnit.label + lastDaily.label) ? 'Low user' : 'Standard user'}, ${Object.keys(rates).length > 1 ? Object.keys(rates).join('/') : 'anytime'} (bill lines: ${lastUnit.label} / ${lastDaily.label})`
    : lastUnit.label.replace(/ Variable$/i, '');
  const basis = f.gstBasis === 'excl' ? 'excl. GST' : 'GST basis not confirmed; assumed excl. GST';
  const plan = {
    id: fuel === 'electricity' ? 'current-elec' : 'current-gas', provider: inv.provider, name, fuel,
    userType: fuel === 'gas' ? 'any' : /low/i.test(lastUnit.label + lastDaily.label) ? 'low' : 'standard',
    gstInclusive: false,
    dailyCents: ov.dailyCents ?? lastDaily.cents,
    rates: ov.rates ? { ...rates, ...ov.rates } : rates,
    fixedTerm: null, discounts, bundleGroup: 'current',
    ...(fuel === 'electricity' && (inv.credits || []).some((c) => /power shout/i.test(c.label)) ? { conditions: 'Occasional Power Shout credits are not modelled.' } : {}),
    source: { method: 'bill', retrievedAt: inv.statementDate, note: `Rates printed on your ${inv.statementDate} bill (${basis}).${started ? ` These rates started ${started}.` : ''}${Object.keys(ov).length ? ' Edited by you.' : ''}` },
  };
  if (Object.values(plan.rates).some((v) => !(v > 0)) || !(plan.dailyCents > 0)) return null;
  return plan;
}

/**
 * Merge parsed invoices into a my-usage.json-style object (same shape as `npm run import-usage`).
 * opts.overrides: { electricity: { dailyCents, rates, monthlyCreditDollars }, gas: {...} } (your edits).
 */
export function mergeInvoices(list, opts = {}) {
  const { invoices, duplicates } = dedupeInvoices(list);
  if (!invoices.length) throw new InvoiceError('No Genesis Energy bills to use.', 'empty');
  const E = dailyMap(invoices, 'electricity'), G = dailyMap(invoices, 'gas');
  const eM = monthly(E.d), gM = monthly(G.d);
  const eWin = latestFullYear(eM), gWin = latestFullYear(gM);
  const avgDay = (d) => (d.size ? [...d.values()].reduce((t, v) => t + v, 0) / d.size : 0);
  let estimated = 0;
  const monthFor = (byM, win, d, mo) => {
    if (win) { const k = win.find((x) => Number(x.slice(5)) === mo); return { k, v: Math.round(byM.get(k).kwh) }; }
    // No full year: average the covered days of this calendar month; months with no bills use the overall daily average.
    const xs = [...byM.entries()].filter(([k]) => Number(k.slice(5)) === mo);
    const days = xs.reduce((t, [, x]) => t + x.days, 0), kwh = xs.reduce((t, [, x]) => t + x.kwh, 0);
    if (!d.size) return { v: 0 };
    if (days < DIM(2026, mo)) estimated++;
    return { v: Math.round((days ? kwh / days : avgDay(d)) * DIM(2026, mo)), partial: days < DIM(2026, mo) };
  };
  const months = Array.from({ length: 12 }, (_, i) => {
    const e = monthFor(eM, eWin, E.d, i + 1), g = monthFor(gM, gWin, G.d, i + 1);
    return { month: i + 1, ...(e.k ? { period: e.k } : {}), elecKwh: e.v, gasKwh: g.v, ...(e.partial || g.partial ? { note: 'estimated: not fully covered by your bills' } : {}) };
  });
  const lastEnd = Math.max(...[...E.d.keys(), ...G.d.keys()]);
  const winStart = lastEnd - 364 * DAY;
  const win = (d) => { const v = [...d.entries()].filter(([t]) => t >= winStart && t <= lastEnd).map(([, x]) => x); return { kwh: Math.round(v.reduce((t, x) => t + x, 0)), days: v.length, per30: v.length ? (v.reduce((t, x) => t + x, 0) / v.length) * 30.4 : 0 }; };
  const eW = win(E.d), gW = win(G.d);
  const season = (d) => Object.fromEntries(Object.entries(SEASONS).map(([k, ms]) => {
    const v = [...d.entries()].filter(([t]) => ms.includes(new Date(t).getUTCMonth() + 1)).map(([, x]) => x);
    return [k, v.length ? Math.round((v.reduce((t, x) => t + x, 0) / v.length) * 30.4) : null];
  }));
  const range = (d) => { if (!d.size) return null; const ts = [...d.keys()].sort((a, b) => a - b); const n = gaps(d); return `${isoDay(ts[0])} to ${isoDay(ts[ts.length - 1])}, ${n ? `${n} gap(s) between bills` : 'continuous'}`; };
  const elecPlan = planFrom(invoices, 'electricity', opts.overrides), gasPlan = planFrom(invoices, 'gas', opts.overrides);
  const provider = invoices[invoices.length - 1].provider;
  const sum = (k) => months.reduce((t, m) => t + m[k], 0);
  return {
    description: `Household usage read from your ${provider} PDF bills in this browser (usage figures and plan rates only, no personal identifiers).`,
    isPlaceholder: false,
    provider,
    coverage: {
      electricity: range(E.d), gas: range(G.d),
      months: eWin ? `Calendar-month kWh from your bills for ${eWin[0]} to ${eWin[11]} (each bill spread evenly over its days).` : `Average kWh per calendar month across your bills (no full 12 months covered${estimated ? `; ${estimated} month value(s) estimated` : ''}).`,
    },
    default: {
      mode: 'seasonal', elecKwh: Math.round(eW.per30), gasKwh: Math.round(gW.per30),
      shares: { night: 0.3, peak: 0.3, free: 0.1 }, sharesFromBills: false,
      sharesNote: 'Your bills use a single anytime rate, so there is no day/night split. The night / peak / free-hour shares are assumptions used only to cost time-of-use plans. Change them to match your habits.',
    },
    annualFromBills: { elecKwh: eW.kwh, gasKwh: gW.kwh, window: `${isoDay(winStart)} to ${isoDay(lastEnd)}`, days: { electricity: eW.days, gas: gW.days } },
    seasonalAverages: { electricity: season(E.d), gas: season(G.d) },
    months,
    billPeriods: invoices.flatMap((inv) => ['electricity', 'gas'].filter((f) => inv.fuels[f] && !inv.excluded?.[f]).map((f) => ({ fuel: f, start: inv.fuels[f].start, end: inv.fuels[f].end, days: inv.fuels[f].days, kwh: inv.fuels[f].kwhEdited ?? inv.fuels[f].kwh }))),
    currentPlan: { label: `${provider} (your current plan)`, ...(elecPlan ? { electricity: elecPlan } : {}), ...(gasPlan ? { gas: gasPlan } : {}) },
    pdfImport: {
      invoices, overrides: opts.overrides || {}, duplicatesSkipped: duplicates.length,
      overlaps: [...E.overlaps, ...G.overlaps], monthsEstimated: estimated, twelveMonthTotals: { elecKwh: sum('elecKwh'), gasKwh: sum('gasKwh') },
    },
  };
}
