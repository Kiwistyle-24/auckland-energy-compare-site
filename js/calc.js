// Cost-calculation logic shared by the browser app and the Node tests. Pure functions, no DOM.
// All money is NZ dollars; all rates are cents. Results are GST-inclusive.

export const GST_RATE = 0.15;
export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const AVG_DAYS_PER_MONTH = 365 / 12;
export const LOW_USER_THRESHOLD_KWH = 8000; // Auckland (upper North Island) threshold
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Convert a cents value to GST-inclusive. */
export function inclGst(cents, gstInclusive, gstRate = GST_RATE) {
  return gstInclusive ? cents : cents * (1 + gstRate);
}

/**
 * Split kWh across the rate buckets a plan has.
 * shares: { night, peak, free } as fractions of total use (0..1). Remainder is day / off-peak.
 * - anytime only: everything at the anytime rate
 * - day/night: night share at night rate, rest at day rate
 * - peak/off-peak(/night): peak share at peak, night share at night (if the plan has one), rest off-peak
 * - plan.freeHours: the free share costs 0 (e.g. "free weekends" plans), applied before the split
 * Returns { buckets: {rateKey: kWh}, freeKwh }
 */
export function splitUsage(rates, kwh, shares = {}, freeHours = false) {
  const night = clamp01(shares.night ?? 0);
  const peak = clamp01(shares.peak ?? 0);
  const free = freeHours ? clamp01(shares.free ?? 0) : 0;
  const freeKwh = kwh * free;
  const rem = kwh - freeKwh;
  const has = (k) => rates && rates[k] !== undefined && rates[k] !== null && rates[k] !== '';
  const b = {};
  if (has('peak')) {
    const n = has('night') ? Math.min(night, 1) : 0;
    const p = Math.min(peak, 1 - n);
    if (has('night')) b.night = rem * n;
    b.peak = rem * p;
    const offKey = has('offpeak') ? 'offpeak' : has('day') ? 'day' : has('anytime') ? 'anytime' : 'peak';
    b[offKey] = (b[offKey] || 0) + rem * (1 - n - p);
  } else if (has('day') && has('night')) {
    b.night = rem * night;
    b.day = rem * (1 - night);
  } else if (has('anytime')) {
    b.anytime = rem;
  } else if (has('day')) {
    b.day = rem;
  } else {
    throw new Error('Plan has no usable variable rate');
  }
  return { buckets: b, freeKwh };
}

function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }

/** Variable cost in cents (GST-inclusive) for one fuel of one plan. */
export function variableCents(plan, kwh, shares, gstRate = GST_RATE) {
  const { buckets } = splitUsage(plan.rates, kwh, shares, plan.freeHours);
  let c = 0;
  for (const [k, q] of Object.entries(buckets)) c += q * inclGst(Number(plan.rates[k]), plan.gstInclusive, gstRate);
  return c;
}

/**
 * Cost of one plan (single fuel) for one period. Returns dollars incl. GST, before bundle credits.
 * opts.promptPay: apply prompt-payment discount if the plan offers one.
 */
export function periodCost(plan, { kwh, days, month }, shares, opts = {}, gstRate = GST_RATE) {
  const fixed = days * inclGst(Number(plan.dailyCents), plan.gstInclusive, gstRate);
  // Seasonal plans (e.g. Powershop) carry a rate set per calendar month; use that month's rates.
  const mr = month && Array.isArray(plan.monthlyRates) ? plan.monthlyRates[month - 1] : null;
  const variable = variableCents(mr ? { ...plan, rates: mr } : plan, kwh, shares, gstRate);
  let cents = fixed + variable;
  const d = plan.discounts || {};
  if (opts.promptPay !== false && d.promptPaymentPct) cents *= 1 - d.promptPaymentPct / 100;
  const monthsInPeriod = days / AVG_DAYS_PER_MONTH;
  let dollars = cents / 100 - (d.monthlyCreditDollars || 0) * monthsInPeriod;
  // One-off sign-up credits (e.g. "$150 credit on a 1-year term") are spread over the first year.
  if (opts.oneOffCredits !== false && d.oneOffCreditDollars) dollars -= d.oneOffCreditDollars * (days / 365);
  return { fixed: fixed / 100, variable: variable / 100, total: dollars };
}

/**
 * Build the 12 usage periods for a scenario.
 * scenario.mode = 'average' -> 12 equal months of avg kWh, 365/12 days each
 * scenario.mode = 'seasonal' -> scenario.months[i].elecKwh/gasKwh for each calendar month, real days
 */
export function usagePeriods(scenario) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    if (scenario.mode === 'seasonal' && Array.isArray(scenario.months) && scenario.months[i]) {
      const m = scenario.months[i];
      const days = DAYS_IN_MONTH[i];
      out.push({ month: i + 1, days, elecKwh: Number(m.elecKwh) || 0, gasKwh: Number(m.gasKwh) || 0 });
    } else {
      out.push({ month: i + 1, days: AVG_DAYS_PER_MONTH, elecKwh: Number(scenario.elecKwh) || 0, gasKwh: Number(scenario.gasKwh) || 0 });
    }
  }
  return out;
}

export function annualKwh(scenario) {
  const p = usagePeriods(scenario);
  return { elec: p.reduce((s, x) => s + x.elecKwh, 0), gas: p.reduce((s, x) => s + x.gasKwh, 0) };
}

/** Bundle (dual fuel) discount applies when electricity and gas plans share a bundleGroup. */
export function isBundle(elecPlan, gasPlan) {
  if (!elecPlan || !gasPlan) return false;
  const a = elecPlan.bundleGroup || elecPlan.provider;
  const b = gasPlan.bundleGroup || gasPlan.provider;
  return a === b && !!(elecPlan.discounts?.bundle || gasPlan.discounts?.bundle);
}

function bundleTerms(elecPlan, gasPlan) {
  const b = { pct: 0, monthlyCreditDollars: 0, dailyCreditCents: 0, gstInclusive: true };
  for (const p of [elecPlan, gasPlan]) {
    const x = p?.discounts?.bundle;
    if (!x) continue;
    b.pct = Math.max(b.pct, x.pct || 0);
    b.monthlyCreditDollars = Math.max(b.monthlyCreditDollars, x.monthlyCreditDollars || 0);
    b.dailyCreditCents = Math.max(b.dailyCreditCents, inclGst(x.dailyCreditCents || 0, p.gstInclusive));
  }
  return b;
}

/**
 * Cost an offer (an electricity plan, optionally plus a gas plan) over a scenario.
 * Returns { months: [{month, elec, gas, credit, total}], annual, monthlyAvg, warnings, bundle }
 */
export function costOffer({ elecPlan, gasPlan }, scenario, opts = {}) {
  const shares = scenario.shares || {};
  // scenario.planShares: { planId: { shares, monthShares?, label } } from hourly data; replaces the general split for that plan
  // (monthShares[i] for calendar month i+1 when present, e.g. season-aware splits).
  const hourly = elecPlan ? scenario.planShares?.[elecPlan.id] : null;
  const eShares = hourly ? { ...shares, ...hourly.shares } : shares;
  const periods = usagePeriods(scenario);
  const bundle = isBundle(elecPlan, gasPlan) ? bundleTerms(elecPlan, gasPlan) : null;
  const months = periods.map((p) => {
    const e = elecPlan && p.elecKwh >= 0 ? periodCost(elecPlan, { kwh: p.elecKwh, days: p.days, month: p.month }, hourly?.monthShares?.[p.month - 1] ? { ...shares, ...hourly.monthShares[p.month - 1] } : eShares, opts) : null;
    const g = gasPlan && p.gasKwh > 0 ? periodCost(gasPlan, { kwh: p.gasKwh, days: p.days, month: p.month }, shares, opts) : null;
    let elec = e ? e.total : 0;
    let gas = g ? g.total : 0;
    let credit = 0;
    if (bundle && e && g) {
      credit += (elec + gas) * (bundle.pct / 100);
      credit += bundle.monthlyCreditDollars * (p.days / AVG_DAYS_PER_MONTH);
      credit += (bundle.dailyCreditCents * p.days) / 100;
    }
    return { month: p.month, days: p.days, elecKwh: p.elecKwh, gasKwh: p.gasKwh, elec: round2(elec), gas: round2(gas), credit: round2(credit), total: round2(elec + gas - credit), rawTotal: elec + gas - credit };
  });
  const annual = round2(months.reduce((s, m) => s + m.rawTotal, 0));
  const warnings = [];
  const assumptions = [];
  const kwh = annualKwh(scenario);
  let ineligible = false;
  if (elecPlan?.userType === 'low') {
    if (kwh.elec > LOW_USER_THRESHOLD_KWH) { ineligible = true; warnings.push(`Not eligible: low-user plans are only for homes using up to ${LOW_USER_THRESHOLD_KWH.toLocaleString('en-NZ')} kWh a year; this scenario uses ${Math.round(kwh.elec).toLocaleString('en-NZ')} kWh.`); }
    assumptions.push('Low-user plan: eligible only under 8,000 kWh/yr at your main home; the low-user rules end 1 April 2027.');
  }
  if (elecPlan?.userType === 'standard' && kwh.elec <= LOW_USER_THRESHOLD_KWH) warnings.push('You may qualify for a low-user version of this plan.');
  if (elecPlan && !planHasOnlyAnytime(elecPlan)) assumptions.push(hourly ? hourly.label : touAssumption(elecPlan, shares, !!scenario.sharesFromBills));
  if (elecPlan && !hourly && !planHasOnlyAnytime(elecPlan) && scenario.planShares && Object.keys(scenario.planShares).length) assumptions.push('Not split from your hourly data: this plan\'s time bands could not be matched to stated hours (e.g. peak hours not stated in the quote), so the general shares are used.');
  if (elecPlan?.monthlyRates) assumptions.push('Seasonal prices: each month is costed at that month\'s rate from the retailer\'s quote.');
  if (elecPlan?.timeBands) assumptions.push(`Time bands (as quoted): ${Object.entries(elecPlan.timeBands).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('; ')}.`);
  for (const p of [elecPlan, gasPlan]) if (p?.discounts?.oneOffCreditDollars && opts.oneOffCredits !== false) assumptions.push(`Includes a one-off $${p.discounts.oneOffCreditDollars} ${p.provider} sign-up credit, spread over the first year (later years cost that much more).`);
  if (bundle) assumptions.push(`Dual-fuel discount applied (${[elecPlan, gasPlan].map((p) => p?.discounts?.bundle?.condition).filter(Boolean)[0] || 'same retailer for both fuels'}).`);
  if (elecPlan?.freeHours && !hourly) assumptions.push(`Free-hours plan: assumes ${pct(shares.free)} of your power use falls in the free hours (edit "When you use power"). The result depends heavily on this.`);
  if (scenario.gasKwh > 0 && scenario.mode !== 'seasonal' && !gasPlan) warnings.push('No gas plan included.');
  return { months, annual, monthlyAvg: round2(annual / 12), warnings, assumptions, ineligible, assumptionDependent: !!(elecPlan && !planHasOnlyAnytime(elecPlan)), splitFromHourly: !!hourly, bundle: !!bundle };
}

const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;

/** Plain-English statement of the usage split used to cost a time-of-use plan. */
export function touAssumption(plan, shares = {}, fromBills = false) {
  const r = plan.rates || {};
  const has = (k) => r[k] !== undefined && r[k] !== null && r[k] !== '';
  const parts = [];
  if (has('peak')) {
    parts.push(`${pct(shares.peak)} peak`);
    if (has('night')) parts.push(`${pct(shares.night)} night`);
    parts.push(`the rest (${pct(Math.max(0, 1 - (shares.peak || 0) - (has('night') ? shares.night || 0 : 0)))}) ${has('offpeak') ? 'off-peak' : 'day'}`);
  } else if (has('day') && has('night')) {
    parts.push(`${pct(shares.night)} night`, `${pct(1 - (shares.night || 0))} day`);
  }
  return `Time-of-use plan: ${fromBills ? 'uses the split from your bills' : 'assumes'} ${parts.join(', ')} of your power use (edit "When you use power"). The hours each band covers are set by the retailer.`;
}

export function planHasOnlyAnytime(p) {
  const keys = Object.keys(p.rates || {}).filter((k) => p.rates[k] !== null && p.rates[k] !== undefined && p.rates[k] !== '');
  return keys.length === 1 && keys[0] === 'anytime' && !p.freeHours;
}

/** Does a plan pass the user's preference filters? */
export function passesPrefs(plan, prefs = {}) {
  if (!plan) return true;
  // Plans from retailers closed to new customers are never ranked (you cannot switch to them).
  if (plan.closedToNewCustomers && plan.source?.method !== 'bill') return false;
  // Plans that need something else (broadband, an EV) are only ranked if you say you have / want it.
  if (Array.isArray(plan.requires) && plan.requires.some((r) => !(prefs.allow || []).includes(r))) return false;
  if (plan.isExample && !prefs.includeExamples) return false;
  if (plan.fuel === 'electricity' && prefs.userType && prefs.userType !== 'any' && plan.userType !== 'any' && plan.userType !== prefs.userType) return false;
  if (prefs.term === 'fixed' && plan.fixedTerm !== true) return false;
  if (prefs.term === 'open' && plan.fixedTerm === true) return false;
  if (prefs.pricing === 'anytime' && plan.fuel === 'electricity' && !planHasOnlyAnytime(plan)) return false;
  if (prefs.pricing === 'tou' && plan.fuel === 'electricity' && planHasOnlyAnytime(plan)) return false;
  return true;
}

/**
 * Build and rank all offers.
 * - Electricity-only users (no gas): one offer per electricity plan.
 * - With gas: each electricity plan is paired with the cheapest gas plan for that scenario,
 *   considering both the same provider (bundle discounts) and any other provider, unless
 *   prefs.dualFuel === 'only' (same provider only) or 'separate' (ignore bundle pairing preference).
 * The baseline (your current plan) is always included and flagged.
 */
export function rankOffers(plans, scenarioIn, prefs = {}, baseline = null) {
  const opts = { promptPay: prefs.promptPay !== false, oneOffCredits: prefs.oneOffCredits !== false };
  const fuels = prefs.fuels || 'both'; // 'both' | 'electricity' | 'gas'
  const zero = (k) => ({ ...scenarioIn, [k]: 0, months: (scenarioIn.months || []).map((m) => ({ ...m, [k]: 0 })) });
  const scenario = fuels === 'electricity' ? zero('gasKwh') : fuels === 'gas' ? zero('elecKwh') : scenarioIn;
  const elec = fuels === 'gas' ? [] : plans.filter((p) => p.fuel === 'electricity' && passesPrefs(p, prefs));
  const gas = fuels === 'electricity' ? [] : plans.filter((p) => p.fuel === 'gas' && passesPrefs(p, { ...prefs, userType: 'any', pricing: 'any' }));
  const offers = [];
  const finish = (base) => {
    if (base) { base.isBaseline = true; base.label = 'Your current plan (from your bills)'; offers.push(base); }
    // Cheapest first; incomplete (fuel missing) and ineligible offers go after the comparable ones.
    const bucket = (o) => (o.incomplete ? 2 : o.ineligible ? 1 : 0);
    offers.sort((x, y) => bucket(x) - bucket(y) || x.annual - y.annual);
    const b = offers.find((o) => o.isBaseline);
    offers.forEach((o, i) => { o.rank = i + 1; if (b) o.vsBaselineAnnual = round2(o.annual - b.annual); });
    return offers;
  };

  if (fuels === 'gas') {
    for (const g of gas) offers.push(makeOffer(null, g, scenario, opts));
    return finish(baseline?.gas ? makeOffer(null, baseline.gas, scenario, opts) : null);
  }
  // Your current plans can also be mixed with other providers ("keep current gas, switch power").
  const others = elec.length + gas.length > 0;
  if (baseline?.electricity && others) elec.push(baseline.electricity);
  if (baseline?.gas && others && fuels === 'both') gas.push(baseline.gas);
  const kwh = annualKwh(scenario);
  const wantGas = fuels === 'both' && kwh.gas > 0;

  const pairOptions = (e) => {
    if (!wantGas) return [null];
    let candidates = gas;
    if (prefs.dualFuel === 'only') candidates = gas.filter((g) => (g.bundleGroup || g.provider) === (e.bundleGroup || e.provider));
    // 'keep': switch power only, keeping your current gas, unless the power retailer also sells gas (then its own gas is considered too).
    else if (prefs.dualFuel === 'keep' && baseline?.gas) candidates = gas.filter((g) => g === baseline.gas || (g.bundleGroup || g.provider) === (e.bundleGroup || e.provider));
    return candidates;
  };

  for (const e of elec) {
    if (baseline && e === baseline.electricity && !wantGas) continue; // identical to the baseline row
    const opts2 = pairOptions(e);
    if (wantGas && !opts2.length) {
      if (prefs.dualFuel === 'only') continue;
      offers.push(makeOffer(e, null, scenario, opts, true));
      continue;
    }
    let best = null;
    for (const g of opts2) {
      if (baseline && e === baseline.electricity && g === baseline.gas) continue; // that's the baseline row
      const o = makeOffer(e, g, scenario, opts);
      if (!best || o.annual < best.annual) best = o;
    }
    if (best) offers.push(best);
    else if (!(baseline && e === baseline.electricity)) offers.push(makeOffer(e, null, scenario, opts, wantGas));
  }
  return finish(baseline?.electricity ? makeOffer(baseline.electricity, wantGas ? baseline.gas : null, scenario, opts) : null);
}

function makeOffer(e, g, scenario, opts, missingGas = false) {
  const r = costOffer({ elecPlan: e, gasPlan: g }, scenario, opts);
  const providers = [...new Set([e?.provider, g?.provider].filter(Boolean))];
  const nm = (p, what) => (p.source?.method === 'bill' ? `current ${what} (${p.provider})` : `${p.provider} ${what}`);
  return {
    id: [e?.id, g?.id].filter(Boolean).join('+'),
    label: !e ? nm(g, 'gas') : g ? (r.bundle ? `${e.provider} dual fuel` : `${nm(e, 'power')} + ${nm(g, 'gas')}`) : `${e.provider}${e.source?.method === 'bill' ? ' (current)' : ''}`,
    closed: !!(e?.closedToNewCustomers || g?.closedToNewCustomers),
    providers, elecPlan: e, gasPlan: g, ...r,
    incomplete: missingGas,
    warnings: missingGas ? [...r.warnings, 'No gas plan matched: gas cost not included, so this total is not comparable.'] : r.warnings,
  };
}

// ---------- low vs standard user ----------
export const STALE_DAYS = 35;

/** True if an ISO timestamp is more than `days` old (or missing/invalid). */
export function isStale(iso, now = new Date(), days = STALE_DAYS) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return (now.getTime() - t) / 86400000 > days;
}

/** Effective cents/kWh (GST-incl.) of a plan for a given usage split, ignoring daily charge. */
export function effectiveRate(plan, shares = {}) {
  return variableCents(plan, 1000, shares) / 1000;
}

/**
 * Break-even annual kWh between a low-user and a standard-user variant:
 *   365*dailyLow + k*rateLow = 365*dailyStd + k*rateStd  ->  k = 365*(dailyStd-dailyLow)/(rateLow-rateStd)
 * Uses GST-inclusive cents and the scenario's usage split for time-of-use plans.
 * Returns { breakEvenKwh|null, lowAnnual, stdAnnual, cheaper: 'low'|'standard'|'same', annualKwh }.
 */
export function compareLowStandard(lowPlan, stdPlan, scenario) {
  const shares = scenario.shares || {};
  const dl = inclGst(lowPlan.dailyCents, lowPlan.gstInclusive), ds = inclGst(stdPlan.dailyCents, stdPlan.gstInclusive);
  const rl = effectiveRate(lowPlan, shares), rs = effectiveRate(stdPlan, shares);
  const breakEvenKwh = rl > rs ? (365 * (ds - dl)) / (rl - rs) : null;
  const lowAnnual = costOffer({ elecPlan: { ...lowPlan, discounts: {} } }, scenario).annual;
  const stdAnnual = costOffer({ elecPlan: { ...stdPlan, discounts: {} } }, scenario).annual;
  const diff = round2(stdAnnual - lowAnnual);
  return { breakEvenKwh: breakEvenKwh && breakEvenKwh > 0 ? Math.round(breakEvenKwh) : null, lowAnnual, stdAnnual, diff, cheaper: Math.abs(diff) < 0.5 ? 'same' : diff > 0 ? 'low' : 'standard', annualKwh: Math.round(annualKwh(scenario).elec) };
}

/** Group electricity plans into low/standard pairs by variantGroup (or provider+name stem). */
export function variantPairs(plans) {
  const groups = new Map();
  for (const p of plans.filter((x) => x.fuel === 'electricity' && (x.userType === 'low' || x.userType === 'standard'))) {
    const key = p.variantGroup || `${p.provider}|${p.name.replace(/\b(low|standard)( user)?\b/gi, '').replace(/\s+/g, ' ').trim()}`;
    if (!groups.has(key)) groups.set(key, { key, low: null, standard: null });
    const g = groups.get(key);
    if (!g[p.userType]) g[p.userType] = p;
  }
  return [...groups.values()];
}

// ---------- verdict ----------
/** Savings under this many dollars a year count as "effectively the best plan". */
export const EFFECTIVELY_BEST_DOLLARS = 25;
/**
 * The headline verdict from ranked offers (rankOffers output).
 * kind: 'no-usage' | 'no-baseline' | 'no-alternative' | 'best' | 'effectively-best' | 'save'
 * diff: current annual − cheapest open alternative (positive = you could save).
 */
export function verdictFor(offers, { threshold = EFFECTIVELY_BEST_DOLLARS, hasUsage = true } = {}) {
  const ranked = (offers || []).filter((o) => !o.incomplete && !o.ineligible && !o.closed);
  const base = (offers || []).find((o) => o.isBaseline) || null;
  const alt = ranked.find((o) => !o.isBaseline) || null;
  if (!hasUsage || !ranked.length) return { kind: 'no-usage', base, alt, best: null, diff: null };
  if (!base) return { kind: 'no-baseline', base, alt, best: ranked[0], diff: null };
  if (!alt) return { kind: 'no-alternative', base, alt, best: base, diff: null };
  const diff = round2(base.annual - alt.annual);
  return { kind: diff <= 0 ? 'best' : diff < threshold ? 'effectively-best' : 'save', base, alt, best: diff <= 0 ? base : alt, diff };
}
