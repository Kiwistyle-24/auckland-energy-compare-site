// Minimal hand-written validator for data/plans.json and plan objects (no dependencies).
import { isComparatorUrl } from './comparators.js';
const RATE_KEYS = ['anytime', 'day', 'night', 'peak', 'offpeak'];
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isStr = (x) => typeof x === 'string' && x.length > 0;
const isIso = (x) => isStr(x) && !Number.isNaN(Date.parse(x));
const isUrl = (x) => { try { const u = new URL(x); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };

export function validatePlan(p, where = 'plan') {
  const e = [];
  if (!p || typeof p !== 'object') return [`${where}: not an object`];
  for (const k of ['id', 'provider', 'name']) if (!isStr(p[k])) e.push(`${where}.${k} must be a non-empty string`);
  if (!['electricity', 'gas'].includes(p.fuel)) e.push(`${where}.fuel must be "electricity" or "gas"`);
  if (!['low', 'standard', 'any'].includes(p.userType)) e.push(`${where}.userType must be low|standard|any`);
  if (typeof p.gstInclusive !== 'boolean') e.push(`${where}.gstInclusive must be boolean`);
  if (!isNum(p.dailyCents) || p.dailyCents < 0 || p.dailyCents > 2000) e.push(`${where}.dailyCents must be a number of cents/day (0-2000)`);
  if (!p.rates || typeof p.rates !== 'object') e.push(`${where}.rates missing`);
  else {
    const keys = Object.keys(p.rates);
    if (!keys.length) e.push(`${where}.rates is empty`);
    for (const k of keys) {
      if (!RATE_KEYS.includes(k)) e.push(`${where}.rates.${k} is not a known rate (${RATE_KEYS.join(', ')})`);
      else if (!isNum(p.rates[k]) || p.rates[k] < 0 || p.rates[k] > 200) e.push(`${where}.rates.${k} must be cents/kWh (0-200)`);
    }
    if (p.fuel === 'gas' && keys.some((k) => k !== 'anytime')) e.push(`${where}: gas plans only support rates.anytime`);
  }
  if (p.monthlyRates !== undefined) {
    if (!Array.isArray(p.monthlyRates) || p.monthlyRates.length !== 12) e.push(`${where}.monthlyRates must have 12 entries (Jan..Dec)`);
    else p.monthlyRates.forEach((m, i) => { for (const [k, v] of Object.entries(m || {})) if (!RATE_KEYS.includes(k) || !isNum(v) || v < 0 || v > 200) e.push(`${where}.monthlyRates[${i}].${k} invalid`); });
  }
  if (p.requires !== undefined && (!Array.isArray(p.requires) || p.requires.some((r) => !['broadband', 'ev'].includes(r)))) e.push(`${where}.requires must be a list of broadband|ev`);
  if (!p.source || typeof p.source !== 'object') e.push(`${where}.source missing (every price needs a source)`);
  else {
    if (!['automatic', 'snapshot', 'manual', 'bill', 'example'].includes(p.source.method)) e.push(`${where}.source.method must be automatic|snapshot|manual|bill|example`);
    if (p.source.method !== 'bill' && !isUrl(p.source.url)) e.push(`${where}.source.url must be a URL`);
    if (p.source.url && isComparatorUrl(p.source.url)) e.push(`${where}.source.url is a comparison site; prices must come from the retailer's own website`);
    if (['automatic', 'snapshot'].includes(p.source.method) && !isStr(p.retailerId)) e.push(`${where}.retailerId required for fetched plans`);
    if (!isIso(p.source.retrievedAt)) e.push(`${where}.source.retrievedAt must be an ISO date`);
  }
  if (p.effectiveFrom !== undefined && p.effectiveFrom !== null && !isIso(p.effectiveFrom)) e.push(`${where}.effectiveFrom must be an ISO date`);
  if (p.variantGroup !== undefined && !isStr(p.variantGroup)) e.push(`${where}.variantGroup must be a string`);
  if (p.source?.method === 'example' && p.isExample !== true) e.push(`${where}: example data must set isExample: true`);
  return e;
}

export function validateManualPlans(m) {
  if (!m || !Array.isArray(m.plans)) return ['manual-plans.json must contain { "plans": [] }'];
  return m.plans.flatMap((p, i) => validatePlan(p, `manual.plans[${i}]`));
}

export function validatePlansFile(d) {
  const e = [];
  if (!d || typeof d !== 'object') return ['not an object'];
  if (d.schemaVersion !== 2) e.push('schemaVersion must be 2');
  if (!isIso(d.generatedAt)) e.push('generatedAt must be an ISO date');
  if (!isNum(d.gstRate)) e.push('gstRate must be a number');
  if (!Array.isArray(d.plans)) e.push('plans must be an array');
  else d.plans.forEach((p, i) => e.push(...validatePlan(p, `plans[${i}]`)));
  if (!Array.isArray(d.providers) || !d.providers.length) e.push('providers must be a non-empty array');
  else d.providers.forEach((p, i) => {
    if (!isStr(p.name)) e.push(`providers[${i}].name missing`);
    if (!isUrl(p.url)) e.push(`providers[${i}].url must be a URL`);
    if (!['not_available_automatically', 'closed', 'needs_review', 'automatic'].includes(p.status)) e.push(`providers[${i}].status invalid`);
    if (p.status !== 'automatic' && !isStr(p.reason)) e.push(`providers[${i}].reason required when not automatic`);
    if (!isIso(p.checkedAt)) e.push(`providers[${i}].checkedAt must be an ISO date`);
    if (isComparatorUrl(p.url)) e.push(`providers[${i}].url is a comparison site`);
  });
  if (!Array.isArray(d.sources) || !d.sources.length) e.push('sources must be a non-empty array');
  else d.sources.forEach((s, i) => {
    if (!isUrl(s.url)) e.push(`sources[${i}].url must be a URL`);
    if (isComparatorUrl(s.url)) e.push(`sources[${i}].url is a comparison site`);
    if (!['ok', 'failed', 'manual'].includes(s.status)) e.push(`sources[${i}].status must be ok|failed|manual`);
    if (s.status !== 'manual' && !isIso(s.retrievedAt)) e.push(`sources[${i}].retrievedAt must be an ISO timestamp`);
  });
  const nc = d.networkCharges || {};
  for (const k of ['electricity', 'gas']) {
    const n = nc[k];
    if (!n) { e.push(`networkCharges.${k} missing`); continue; }
    if (!isUrl(n.source?.url) || !isIso(n.source?.retrievedAt)) e.push(`networkCharges.${k}.source needs url and retrievedAt`);
    if (!Array.isArray(n.rows) || !n.rows.length) e.push(`networkCharges.${k}.rows empty`);
    else n.rows.forEach((r, i) => { if (!isStr(r.code) || !isNum(r.dailyCentsExGst)) e.push(`networkCharges.${k}.rows[${i}] invalid`); });
  }
  return e;
}

export function validateUsageFile(u) {
  const e = [];
  if (!u || typeof u !== 'object') return ['not an object'];
  if (!u.default || !isNum(u.default.elecKwh) || !isNum(u.default.gasKwh)) e.push('default.elecKwh and default.gasKwh must be numbers');
  if (u.months && (!Array.isArray(u.months) || u.months.length !== 12)) e.push('months must have 12 entries (Jan..Dec)');
  else (u.months || []).forEach((m, i) => { if (!isNum(m.elecKwh) || !isNum(m.gasKwh)) e.push(`months[${i}] needs elecKwh and gasKwh`); });
  if (u.currentPlan) {
    if (u.currentPlan.electricity) e.push(...validatePlan(u.currentPlan.electricity, 'currentPlan.electricity'));
    if (u.currentPlan.gas) e.push(...validatePlan(u.currentPlan.gas, 'currentPlan.gas'));
  }
  const text = JSON.stringify(u).toLowerCase();
  for (const bad of ['icp', 'account number', 'address', 'customer number']) if (text.includes(`"${bad}`)) e.push(`usage file must not contain personal identifiers (${bad})`);
  return e;
}
