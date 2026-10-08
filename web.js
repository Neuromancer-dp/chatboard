// Web access for /search and pasted links: DuckDuckGo (no key) or a
// self-hosted SearXNG instance, plus a small readable-text page extractor.

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (html) => decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function duckduckgo(query) {
  const resp = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query, kl: 'wt-wt' }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`DuckDuckGo returned ${resp.status}`);
  const html = await resp.text();
  const results = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const block of blocks) {
    if (/result--ad\b/.test(block)) continue;
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    let url = decodeEntities(link[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snip = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/);
    results.push({ title: stripTags(link[2]), url, snippet: snip ? stripTags(snip[1]) : '' });
    if (results.length >= 6) break;
  }
  if (!results.length && /anomaly|captcha/i.test(html)) throw new Error('DuckDuckGo is rate-limiting right now, try again in a minute');
  return results;
}

async function searxng(base, query) {
  const url = `${base.replace(/\/+$/, '')}/search?${new URLSearchParams({ q: query, format: 'json' })}`;
  const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`SearXNG returned ${resp.status} (is format=json enabled?)`);
  const data = await resp.json();
  return (data.results || []).slice(0, 6).map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.content || '' }));
}

async function search(query, settings) {
  if (settings.search_provider === 'searxng' && settings.searxng_url?.trim()) return searxng(settings.searxng_url, query);
  return duckduckgo(query);
}

// Readable text from a page: title + main text, boilerplate stripped.
async function readPage(url, maxChars = 3000) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`page returned ${resp.status}`);
  const type = resp.headers.get('content-type') || '';
  if (!/text\/html|text\/plain|xhtml/.test(type)) throw new Error(`can't read ${type.split(';')[0] || 'this kind of page'}`);

  // read at most MAX_PAGE_BYTES
  const reader = resp.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const raw = new TextDecoder().decode(Buffer.concat(chunks));
  if (/text\/plain/.test(type)) return { title: url, text: raw.slice(0, maxChars) };

  const title = stripTags(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url);
  let body = raw.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i)?.[2] || raw.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || raw;
  body = body
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const text = decodeEntities(body.replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 30 || /[.!?:]$/.test(l))
    .join('\n');
  return { title, text: text.slice(0, maxChars) };
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi;
const findUrls = (text) => [...new Set(text.match(URL_RE) || [])].slice(0, 2);

module.exports = { search, readPage, findUrls };
