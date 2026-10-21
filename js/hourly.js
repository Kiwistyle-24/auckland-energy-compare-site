// Genesis hourly usage CSVs ("date","usage","dollars","type"; one file per day) -> hourly kWh rows, and
// time-of-use splits computed from that hourly shape for each plan's own time bands.
// Pure functions (browser + Node tests). The dollars column is ignored. Nothing here logs or uploads anything.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export class HourlyError extends Error {
  constructor(message) { super(message); this.name = 'HourlyError'; }
}

/** Split one CSV line (double-quoted fields, commas allowed inside quotes). */
function csvFields(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Does this text look like a Genesis hourly usage CSV? */
export function looksLikeHourlyCsv(text) {
  const first = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
  const h = csvFields(first).map((x) => x.toLowerCase());
  return h[0] === 'date' && h[1] === 'usage';
}

const pad = (n) => String(n).padStart(2, '0');

/** "12:00AM 26 September 2026" -> { date: "2026-09-26", hour: 0 } (NZ local wall-clock time, as the file shows it). */
export function parseHourLabel(s) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/i.exec(String(s).trim());
  if (!m) return null;
  const mo = MONTHS.indexOf(m[5].toLowerCase());
  let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12;
  if (mo < 0 || Number(m[2]) !== 0 || h > 23) return null;
  return { date: `${m[6]}-${pad(mo + 1)}-${pad(Number(m[4]))}`, hour: h };
}

/**
 * Parse one Genesis hourly CSV. Returns { rows: [{ key, date, hour, kwh, type }], skipped }.
 * Rows are NZ local hours; on the DST-start day there are 23, on the DST-end day 25 (the repeated hour is kept
 * as a second row). The last line may lack a trailing newline.
 */
export function parseHourlyCsv(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length || !looksLikeHourlyCsv(lines[0])) throw new HourlyError('This CSV is not a Genesis hourly usage file (expected the columns "date","usage","dollars","type").');
  const head = csvFields(lines[0]).map((x) => x.toLowerCase());
  const iType = head.indexOf('type');
  const rows = [], seen = new Map();
  let skipped = 0;
  for (const l of lines.slice(1)) {
    const f = csvFields(l);
    const t = parseHourLabel(f[0]);
    const u = /^(-?\d+(?:\.\d+)?)\s*kwh$/i.exec(f[1] || '');
    if (!t || !u) { skipped++; continue; }
    const base = `${t.date}T${pad(t.hour)}`;
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    rows.push({ key: n > 1 ? `${base}#${n}` : base, date: t.date, hour: t.hour, kwh: Number(u[1]), type: iType >= 0 ? (f[iType] || '').toLowerCase() : '' });
  }
  if (!rows.length) throw new HourlyError('This Genesis hourly usage CSV has no readable hourly rows.');
  return { rows, skipped };
}

/** Merge rows, de-duplicating by timestamp (the newer import wins). */
export function mergeHourly(...lists) {
  const m = new Map();
  for (const l of lists) for (const r of l || []) m.set(r.key, r);
  return [...m.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const dow = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();
/** NZ daylight saving: starts last Sunday of September (23-hour day), ends first Sunday of April (25-hour day). */
export function expectedHours(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  if (dow(iso) !== 0) return 24;
  if (m === 9 && d + 7 > 30) return 23;
  if (m === 4 && d <= 7) return 25;
  return 24;
}

const fmtDay = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function hourlyCoverage(rows) {
  if (!rows?.length) return null;
  const byDay = new Map();
  for (const r of rows) byDay.set(r.date, (byDay.get(r.date) || 0) + 1);
  const days = [...byDay.keys()].sort();
  const weekend = days.filter((d) => [0, 6].includes(dow(d))).length;
  const incomplete = days.filter((d) => byDay.get(d) < expectedHours(d));
  const dst = days.filter((d) => expectedHours(d) !== 24);
  return {
    days: days.length, from: days[0], to: days[days.length - 1], weekdays: days.length - weekend, weekendDays: weekend,
    hours: rows.length, kwh: Math.round(rows.reduce((t, r) => t + r.kwh, 0) * 100) / 100,
    incompleteDays: incomplete, dstDays: dst, estimatedHours: rows.filter((r) => r.type && r.type !== 'actual').length,
    text: `${days.length} day${days.length === 1 ? '' : 's'}, ${fmtDay(days[0])} – ${fmtDay(days[days.length - 1])} (${days.length - weekend} weekdays, ${weekend} weekend days)`,
  };
}

// ---------- plan time bands ----------
// Each spec turns a plan's stated time bands into a band for every 15 minutes of each day of the week.
// Specs are matched against the plan's own timeBands text, so a changed band description is never guessed.
const H = (h, m = 0) => h * 60 + m;
const inR = (min, ranges) => ranges.some(([a, b]) => min >= a && min < b);
const WEEKDAY = (d) => d >= 1 && d <= 5;

export const BAND_SPECS = [
  {
    id: 'mercury-flex',
    match: (tb) => tb.peak === '7.00am–10.59am and 5.00pm–9.29pm' && tb.offpeak === '11.00am–4.59pm and 9.30pm–6.59am' && tb.days === 'every day',
    band: (d, min) => (inR(min, [[H(7), H(11)], [H(17), H(21, 30)]]) ? 'peak' : 'offpeak'),
    note: 'Hourly data can\'t split the 9–10pm hour at 9:30pm, so half of that hour\'s use is counted as peak and half as off-peak.',
  },
  {
    id: 'day-night-7am-9pm',
    match: (tb) => /7\s*am\s*-\s*9\s*pm/i.test(tb.day || '') && /9\s*pm\s*-\s*7\s*am/i.test(tb.night || ''),
    band: (d, min) => (inR(min, [[H(7), H(21)]]) ? 'day' : 'night'),
  },
  {
    id: 'ek-movemaster',
    match: (tb) => tb.peak === 'weekdays 7–9am and 5–9pm' && /weekdays 9am–5pm and 9–11pm; weekends 7am–11pm/.test(tb.offpeak || '') && /every day 11pm–7am/.test(tb.night || ''),
    band: (d, min) => (!inR(min, [[H(7), H(23)]]) ? 'night' : WEEKDAY(d) && inR(min, [[H(7), H(9)], [H(17), H(21)]]) ? 'peak' : 'offpeak'),
  },
  {
    id: 'ek-sunday-saver',
    match: (tb) => tb.peak === 'weekdays 7–9am and 5–9pm' && /Saturdays all day; weekdays 9am–5pm and 9pm–7am/.test(tb.offpeak || '') && /^Sundays/.test(tb.free || ''),
    band: (d, min) => (d === 0 ? 'free' : WEEKDAY(d) && inR(min, [[H(7), H(9)], [H(17), H(21)]]) ? 'peak' : 'offpeak'),
  },
  {
    id: 'octopus-flexi',
    match: (tb) => tb.peak === 'weekdays 7–11am and 5–9pm' && tb.offpeak === 'weekdays 11am–5pm and 9–11pm; weekends 7am–11pm' && tb.night === 'every day 11pm–7am',
    band: (d, min) => (!inR(min, [[H(7), H(23)]]) ? 'night' : WEEKDAY(d) && inR(min, [[H(7), H(11)], [H(17), H(21)]]) ? 'peak' : 'offpeak'),
  },
  {
    id: 'octopus-free-lunch',
    freeLabel: 'free (11am–2pm)',
    match: (tb) => tb.peak === 'every day 7–11am and 5–9pm' && tb.free === 'every day 11am–2pm' && tb.offpeak === 'every day 2–5pm and 9pm–7am',
    band: (d, min) => (inR(min, [[H(11), H(14)]]) ? 'free' : inR(min, [[H(7), H(11)], [H(17), H(21)]]) ? 'peak' : 'offpeak'),
  },
  {
    id: 'ecotricity-ecosaver',
    note: 'Ecotricity\'s weekend rates weren\'t captured, so weekends are assumed to use the weekday bands.',
    match: (tb) => tb.peak === '7–11am and 5–9pm (weekday chart; weekends assumed the same)' && tb.offpeak === '9pm–7am and 11am–5pm (weekday chart; weekends assumed the same)',
    band: (d, min) => (inR(min, [[H(7), H(11)], [H(17), H(21)]]) ? 'peak' : 'offpeak'),
  },
];

export function specFor(plan) {
  const tb = plan?.timeBands;
  return tb ? BAND_SPECS.find((s) => s.match(tb)) || null : null;
}

/** Fraction of the hourly kWh falling in each band of a spec (each hour spread evenly over its four quarters). */
export function bandFractions(spec, rows) {
  const tot = {}; let all = 0;
  for (const r of rows) {
    const d = dow(r.date);
    for (let q = 0; q < 4; q++) {
      const b = spec.band(d, r.hour * 60 + q * 15);
      tot[b] = (tot[b] || 0) + r.kwh / 4;
    }
    all += r.kwh;
  }
  return Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, all ? v / all : 0]));
}

const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Hourly rows are grouped into a winter shape (May–Aug) and a spring shape (every other month: Sep–Apr). */
export const seasonOfDate = (iso) => ([5, 6, 7, 8].includes(Number(iso.slice(5, 7))) ? 'winter' : 'spring');

/**
 * Default weight of the WINTER shape for each calendar month (Jan..Dec); the rest is the spring shape.
 * May–Aug winter; Sep is a 50/50 blend; Oct–Nov spring; Mar (1/3) and Apr (2/3) blend from spring into winter;
 * Dec–Feb use the spring shape (there is no summer data).
 */
export const DEFAULT_WINTER_WEIGHTS = [0, 0, 1 / 3, 2 / 3, 1, 1, 1, 1, 0.5, 0, 0, 0];

export function seasonCoverage(rows) {
  const by = { winter: [], spring: [] };
  for (const r of rows || []) by[seasonOfDate(r.date)].push(r);
  return { winter: hourlyCoverage(by.winter), spring: hourlyCoverage(by.spring), rows: by };
}

/** Convert band fractions (of all use) into the shares calc.js splitUsage expects. */
function toShares(f, plan) {
  const free = plan.freeHours ? f.free || 0 : 0;
  const rem = 1 - free || 1;
  return { peak: (f.peak || 0) / rem, night: (f.night || 0) / rem, free };
}
const blend = (a, b, w) => { const o = {}; for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) o[k] = w * ((a || {})[k] || 0) + (1 - w) * ((b || {})[k] || 0); return o; };
const describe = (f, spec) => Object.entries(f).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${pct(v)} ${k === 'offpeak' ? 'off-peak' : k === 'free' ? spec?.freeLabel || 'free (Sundays)' : k}`).join(', ');

export function describeWeights(w) {
  const groups = [];
  w.forEach((x, i) => { const t = x >= 1 ? 'winter' : x <= 0 ? 'spring' : `${Math.round(x * 100)}% winter / ${Math.round((1 - x) * 100)}% spring`; const g = groups[groups.length - 1]; if (g && g.t === t) g.to = i; else groups.push({ t, from: i, to: i }); });
  return groups.map((g) => `${MON[g.from]}${g.to > g.from ? `–${MON[g.to]}` : ''} ${g.t}`).join('; ');
}

/**
 * Season-aware shares for one plan from the hourly data, or null if the plan's bands can't be mapped (e.g.
 * Powershop, whose peak hours aren't stated). Returns { spec, fractions: {winter, spring}, monthShares[12]
 * (index 0 = Jan), shares (12-month mean, for display), label }.
 */
export function hourlySharesForPlan(plan, rows, opts = {}) {
  if (!rows?.length || !plan || plan.fuel !== 'electricity') return null;
  const spec = specFor(plan);
  if (!spec) return null;
  const sc = opts.seasons || seasonCoverage(rows);
  const fw = sc.winter ? bandFractions(spec, sc.rows.winter) : null;
  const fs = sc.spring ? bandFractions(spec, sc.rows.spring) : null;
  const weights = (opts.winterWeights || DEFAULT_WINTER_WEIGHTS).map((x) => Math.max(0, Math.min(1, Number(x) || 0)));
  const wFor = (i) => (!fw ? 0 : !fs ? 1 : weights[i]);
  const monthFractions = Array.from({ length: 12 }, (_, i) => blend(fw, fs, wFor(i)));
  const monthShares = monthFractions.map((f) => toShares(f, plan));
  const mean = blend(Object.fromEntries(Object.keys(monthFractions[0]).map((k) => [k, monthFractions.reduce((t, f) => t + (f[k] || 0), 0) / 12])), {}, 1);
  const parts = [];
  if (fw) parts.push(`winter (${sc.winter.text}): ${describe(fw, spec)}`);
  if (fs) parts.push(`spring (${sc.spring.text}): ${describe(fs, spec)}`);
  const how = fw && fs
    ? `Each month's kWh from your bills is split with: ${describeWeights(weights)}${weights.slice(11).concat(weights.slice(0, 2)).every((x) => x === 0) ? ' (Dec–Feb use the spring shape: there is no summer data)' : ''}. Edit the month weights under "When you use power".`
    : fw ? 'Only winter data is loaded, so every month uses the winter shape: summer use may differ.' : 'Your hourly data covers only spring, so winter heating may shift this split.';
  return {
    spec: spec.id, fractions: { winter: fw, spring: fs }, monthShares, shares: toShares(mean, plan),
    label: `Split from your hourly data: ${parts.join('; ')}.${spec.note ? ` ${spec.note}` : ''} ${how} Turn off "Use my hourly data" to set your own split.`,
  };
}

/** { planId: {...} } for every plan whose bands can be computed from the hourly data. */
export function planSharesFromHourly(plans, rows, opts = {}) {
  if (!rows?.length) return {};
  const seasons = seasonCoverage(rows);
  const out = {};
  for (const p of plans || []) { const s = hourlySharesForPlan(p, rows, { ...opts, seasons }); if (s) out[p.id] = s; }
  return out;
}

export { DAY_NAMES, MON };
