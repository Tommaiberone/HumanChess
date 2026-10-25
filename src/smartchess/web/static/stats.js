// Anonymous usage counters for the public site (stats_lambda.py). The page sends names from
// a closed list ("view", "review_done", ...), never text: no usernames, games or errors.
// Nothing is stored on this device (no cookie, no localStorage), nothing is sent when the
// browser says Do Not Track or Global Privacy Control, and nothing without the
// smartchess-stats <meta>, so a local copy or the Python server never reports.
// `?from=me` switches it off for that visit (the owner testing the live site).

const URL_ = document.querySelector('meta[name="smartchess-stats"]')?.content || '';
const params = new URLSearchParams(location.search);
const off = !URL_ || navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true
  || params.get('from') === 'me';

const queue = [];
let timer = 0;
const started = Date.now();
let left = false;

/** Same buckets as stats_lambda.py: "u<first edge>" below the first edge, else the largest edge reached. */
export function bucket(value, edges) {
  if (!(value >= edges[0])) return `u${edges[0]}`;
  return String([...edges].reverse().find(e => value >= e));
}

export function track(key) {
  if (off) return;
  queue.push(key);
  timer ||= setTimeout(flush, 3000); // soon, in case the tab is killed before it is hidden
}

export function flush() {
  clearTimeout(timer);
  timer = 0;
  while (queue.length) {
    const k = queue.splice(0, 30);
    // text/plain keeps it a "simple" request: no preflight, and keepalive lets it outlive the page.
    fetch(URL_, { method: 'POST', body: JSON.stringify({ k }), headers: { 'content-type': 'text/plain' },
      keepalive: true, credentials: 'omit', mode: 'cors' }).catch(() => {});
  }
}

const referrer = () => {
  let host = '';
  try { host = new URL(document.referrer).hostname.replace(/^(www|old|new|m)\./, ''); } catch { /* no referrer */ }
  if (!host || host === location.hostname) return 'direct';
  if (/(^|\.)reddit\.com$/.test(host) || host === 'redd.it') return 'reddit';
  if (/(^|\.)lichess\.org$/.test(host)) return 'lichess';
  if (/(^|\.)chess\.com$/.test(host)) return 'chesscom';
  if (/(^|\.)google\./.test(host)) return 'google';
  if (/(^|\.)(bing\.com|duckduckgo\.com|yahoo\.com|ecosia\.org|brave\.com)$/.test(host)) return 'search';
  if (/(^|\.)github\.com$/.test(host)) return 'github';
  if (/^(t\.co|x\.com|twitter\.com)$/.test(host)) return 'x';
  if (host === 'news.ycombinator.com') return 'hn';
  return 'other';
};

/** The page was opened: where from, on what kind of device, in which language. */
export function trackView() {
  if (off) return;
  // A finger as the main pointer: a phone has a short side under 600 px, a tablet is wider but not a desktop screen.
  const touch = matchMedia('(pointer: coarse)').matches;
  const device = !touch ? 'desktop' : Math.min(innerWidth, innerHeight) < 600 ? 'phone' : innerWidth < 1100 ? 'tablet' : 'desktop';
  const lang = (navigator.language || '').slice(0, 2).toLowerCase();
  track('view');
  track(`view.ref.${referrer()}`);
  track(`view.dev.${device}`);
  const known = /^[a-z][a-z]$/.test(lang) ? lang : 'other';
  track(`view.lang.${known}`);
  const from = params.get('from');
  if (from && /^[a-z0-9]{2,12}$/.test(from)) track(`view.from.${from}`); // a link tagged for a post, e.g. ?from=chess
}

// How long the visit lasted, counted the first time the tab is hidden or left.
function leave() {
  if (left || off) return;
  left = true;
  queue.push(`leave.dur.${bucket((Date.now() - started) / 1000, [10, 60, 300, 900])}`);
  flush();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { leave(); flush(); } });
addEventListener('pagehide', () => { leave(); flush(); });
