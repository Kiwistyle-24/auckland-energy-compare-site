// Price-comparison / aggregator sites. These are NEVER used as a price source: every rate in this app
// must come from the retailer's own website (or your own bills / a quote you typed from a retailer's site).
// (Shared by the fetcher and the browser app.) tests/sources.test.js fails if any of these domains shows up as a source anywhere in data/plans.json.
export const COMPARATOR_DOMAINS = [
  'powerswitch.org.nz', 'consumer.org.nz', 'selectra.nz', 'selectra.co.nz', 'canstar.co.nz', 'canstarblue.co.nz',
  'billy.govt.nz', 'glimp.co.nz', 'powercompare.co.nz', 'switchme.co.nz', 'whatpower.co.nz', 'compare.co.nz',
  'priceme.co.nz', 'moneyhub.co.nz', 'energyhub.co.nz', 'powerplans.co.nz', 'nzpowerplans.co.nz',
];

/** True if a URL's host is (a subdomain of) a comparator domain. */
export function isComparatorUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return COMPARATOR_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

/** True if url's host is one of `domains` (or a subdomain of one). */
export function isOnDomain(url, domains) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return domains.some((d) => host === d || host.endsWith('.' + d));
}
