#!/usr/bin/env node
/* TCG Card API — a card catalog, served to applications.
 *
 * This is the data half of what used to live inside one tracker app, split
 * out so that any application — the tracker, or a different one entirely —
 * can consume the same cards without deploying a tracker to get them.
 *
 * It is a CONSUMER of the published master, not a second authority: on boot
 * (and on a timer) it pings the master's catalog.json manifest, pulls
 * catalog.db when the version moves, and serves straight from that file.
 * The maintainer workspace and its publish flow do not know this exists.
 *
 * Phase 2: the gate is in. Every /v1 endpoint except /v1/health wants a token
 * (Authorization: Bearer …, or X-API-Key for clients that cannot set it),
 * requests are weighted — a bulk catalog.db pull is not priced like a card
 * lookup — and every answer carries X-Quota-* / X-RateLimit-* headers so a
 * client sees the wall before hitting it. scripts/tokens.js mints the keys.
 *
 * Env:
 *   PORT                    listen port (default 3400)
 *   DATA_DIR                where the pulled catalog + this service's own
 *                           state live (default ./data)
 *   CARD_SOURCE_URL         base URL of the published master (the bucket) —
 *                           the same value the tracker calls cdnBase
 *   CARD_CHECK_INTERVAL_MS  how often to look for a newer master
 *                           (default 6 hours)
 *   CARD_REQUIRE_TOKEN      set to 0 to run the surface open (local
 *                           development; the default is on)
 *
 * Zero dependencies. Node >= 22.5 (node:sqlite).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('This server needs Node 22.5+ (for the built-in node:sqlite database). Please update Node and restart.');
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '3400', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SOURCE = (process.env.CARD_SOURCE_URL || '').trim().replace(/\/+$/, '');
const CHECK_MS = parseInt(process.env.CARD_CHECK_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
const REQUIRE_TOKEN = process.env.CARD_REQUIRE_TOKEN !== '0';

const CAT_FILE = path.join(DATA_DIR, 'catalog.db');
const CAT_TMP = CAT_FILE + '.tmp';
const META_FILE = path.join(DATA_DIR, 'meta.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const LANG_RE = /^[a-z]{2}(-[a-z]{2})?$/i;
const SET_ID_RE = /^[a-zA-Z0-9_.-]{1,60}$/;
const CARD_ID_RE = /^[a-zA-Z0-9_.-]{1,80}$/;

/* ============================================================
 * Tokens, quotas, and the burst window
 *
 * Who may ask, and how much, lives in api.db — a separate database from the
 * catalog, because the catalog file is thrown away and replaced whenever the
 * master moves and the ledger of spend must survive that.
 *
 * Monthly counts are durable rows. The burst window is in memory and does
 * not survive a restart, which is the right trade for a cap measured in
 * seconds: its job is protecting the host right now, not accounting.
 * ============================================================ */
const { openApiDb, sha256, TOKEN_RE, period, periodResetsAt } = require(path.join(__dirname, 'lib', 'apidb'));
const adb = openApiDb(DATA_DIR);
const _tokenByHash = adb.prepare('SELECT * FROM tokens WHERE hash = ?');
const _usageOf = adb.prepare('SELECT count FROM usage WHERE token_id = ? AND period = ?');
const _charge = adb.prepare(`INSERT INTO usage (token_id, period, count) VALUES (?,?,?)
  ON CONFLICT(token_id, period) DO UPDATE SET count = count + excluded.count`);
const _touch = adb.prepare('UPDATE tokens SET last_used = ? WHERE id = ?');

const _burst = new Map();      // token id -> { start, n } for the current minute
const _touched = new Map();    // token id -> last time last_used was written

function bearerOf(req) {
  const h = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return String(req.headers['x-api-key'] || '').trim();
}

/** Authenticate and meter one request. Sends the refusal itself and returns
 * null; otherwise sets the quota headers and returns the token row (or true
 * when the gate is switched off for local development). */
function gate(req, res, cost) {
  if (!REQUIRE_TOKEN) return true;
  const raw = bearerOf(req);
  if (!raw) return sendJSON(res, 401, { error: 'A token is required: Authorization: Bearer <token> (or X-API-Key).' }), null;
  // junk that could never be a token is refused before it costs a lookup
  const t = TOKEN_RE.test(raw) ? _tokenByHash.get(sha256(raw)) : null;
  if (!t) return sendJSON(res, 401, { error: 'That token is not recognised.' }), null;
  if (t.revoked) return sendJSON(res, 403, { error: 'This token has been revoked.' }), null;

  // ---- the burst window: requests per minute, every plan, no exceptions ----
  const now = Date.now();
  let w = _burst.get(t.id);
  if (!w || now - w.start >= 60_000) { w = { start: now, n: 0 }; _burst.set(t.id, w); }
  const resetIn = Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000));
  res.setHeader('X-RateLimit-Limit', String(t.burst_limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, t.burst_limit - w.n - 1)));
  res.setHeader('X-RateLimit-Reset', String(resetIn));
  if (w.n + 1 > t.burst_limit) {
    return sendJSON(res, 429, { error: `Too many requests — this token is limited to ${t.burst_limit} per minute.` },
      { 'Retry-After': String(resetIn) }), null;
  }
  w.n++;

  // ---- the monthly allowance: durable, weighted by what was asked for ----
  const per = period();
  const used = (_usageOf.get(t.id, per) || { count: 0 }).count;
  res.setHeader('X-Quota-Period', per);
  if (t.monthly_limit === null) {
    res.setHeader('X-Quota-Limit', 'unlimited');
    res.setHeader('X-Quota-Used', String(used + cost));
  } else {
    if (used + cost > t.monthly_limit) {
      res.setHeader('X-Quota-Limit', String(t.monthly_limit));
      res.setHeader('X-Quota-Used', String(used));
      res.setHeader('X-Quota-Remaining', '0');
      return sendJSON(res, 402, {
        error: `The monthly allowance is spent (${used} of ${t.monthly_limit} requests used). It resets ${periodResetsAt().slice(0, 10)}.`,
      }), null;
    }
    res.setHeader('X-Quota-Limit', String(t.monthly_limit));
    res.setHeader('X-Quota-Used', String(used + cost));
    res.setHeader('X-Quota-Remaining', String(t.monthly_limit - used - cost));
  }
  if (cost > 0) _charge.run(t.id, per, cost);
  // last_used is a courtesy for `tokens.js list`, not an audit log — one
  // write a minute per token, not one per request
  if ((now - (_touched.get(t.id) || 0)) > 60_000) { _touch.run(now, t.id); _touched.set(t.id, now); }
  return t;
}

/* What each ask is worth. Weighting is the whole point: the bulk file and a
 * single card lookup must not cost the same, the manifest is free so installs
 * can poll for updates without spending, and images (Phase 3) are free
 * forever — that one is policy, not economics; see PLAN.md. */
function costOf(p, req) {
  if (p === '/v1/catalog.db') return req.headers['if-none-match'] === currentEtag() ? 0 : 100;
  if (p === '/v1/scan-index') return 5;
  if (p === '/v1/catalog.json' || p === '/v1/languages' || p === '/v1/me') return 0;
  if (p === '/v1/sets' || p.startsWith('/v1/sets/') || p === '/v1/cards' || p.startsWith('/v1/cards/')) return 1;
  return 0;                     // unknown paths get a 404, not a bill
}

function currentEtag() {
  return `"v${state.manifest ? state.manifest.version : 0}-${((state.manifest && state.manifest.contentHash) || '').slice(0, 16)}"`;
}

/* ============================================================
 * The catalog: one SQLite file, pulled from the master, read-only
 *
 * Served from the file as published rather than imported into a schema of
 * our own: an import step is a place for the copy to drift from the truth,
 * and the whole job of this service is to NOT be a second truth.
 * ============================================================ */
let cat = null;          // open read-only handle, or null before the first pull
let state = { manifest: null, fetchedAt: null, checkedAt: null };
try { state = { ...state, ...JSON.parse(fs.readFileSync(META_FILE, 'utf8')) }; } catch { /* first boot */ }

function saveMeta() {
  fs.writeFileSync(META_FILE, JSON.stringify(state, null, 2));
}

function openCatalog() {
  if (cat) { try { cat.close(); } catch { /* already closed */ } }
  try { cat = new DatabaseSync(CAT_FILE, { readOnly: true }); }
  catch { cat = new DatabaseSync(CAT_FILE); }   // older node:sqlite without the option
}

/** A downloaded file is not a catalog until it proves it: opens, has the
 * expected tables, holds at least one card. A truncated or garbage download
 * must never replace a working database. */
function validateCatalog(file) {
  const db = new DatabaseSync(file);
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM cards').get().n;
    db.prepare('SELECT COUNT(*) AS n FROM sets').get();
    db.prepare('SELECT COUNT(*) AS n FROM printings').get();
    if (!n) throw new Error('the downloaded catalog holds no cards');
  } finally {
    db.close();
  }
}

let refreshing = false;
async function checkForUpdate(reason) {
  if (!SOURCE || refreshing) return;
  refreshing = true;
  try {
    const mRes = await fetch(SOURCE + '/catalog.json');
    if (!mRes.ok) throw new Error('HTTP ' + mRes.status + ' for catalog.json');
    const manifest = await mRes.json();
    state.checkedAt = Date.now();
    if (cat && state.manifest && manifest.version === state.manifest.version) { saveMeta(); return; }

    const dRes = await fetch(SOURCE + '/catalog.db');
    if (!dRes.ok) throw new Error('HTTP ' + dRes.status + ' for catalog.db');
    fs.writeFileSync(CAT_TMP, Buffer.from(await dRes.arrayBuffer()));
    validateCatalog(CAT_TMP);

    // the swap is synchronous end to end, so no request ever finds the
    // catalog half-replaced: close, rename over, reopen
    if (cat) { try { cat.close(); } catch { /* closing to swap */ } cat = null; }
    try {
      fs.renameSync(CAT_TMP, CAT_FILE);
    } finally {
      if (fs.existsSync(CAT_FILE)) openCatalog();
    }
    state.manifest = manifest;
    state.fetchedAt = Date.now();
    saveMeta();
    clearScanCache();
    console.log(`Catalog v${manifest.version}: ${manifest.cards} cards, ${manifest.sets} sets, ${manifest.printings} printings (${reason}).`);
  } catch (e) {
    fs.rmSync(CAT_TMP, { force: true });
    console.warn('Catalog update failed: ' + e.message);
  } finally {
    refreshing = false;
  }
}

/* ============================================================
 * Emitters — catalog rows as client JSON
 *
 * Tombstones (hidden = 1) are part of the pull protocol, not part of the
 * data: they exist so a consumer install can delete what the master
 * deleted. A client of this API gets the world as it is — no tombstones —
 * while /v1/catalog.db stays byte-for-byte the published file, tombstones
 * and all, because installs that pull it still need them.
 * ============================================================ */
function langOf(url) {
  const lang = url.searchParams.get('lang') || 'en';
  return LANG_RE.test(lang) ? lang : null;
}

function cardJson(c, prints) {
  const live = (prints || []).filter((p) => !p.hidden);
  const dead = new Set((prints || []).filter((p) => p.hidden).map((p) => p.variant));
  const variants = new Set((c.variants_csv || '').split(',').filter(Boolean));
  for (const p of live) variants.add(p.variant);
  for (const v of dead) variants.delete(v);
  return {
    id: c.id,
    setId: c.set_id,
    number: c.local_id,
    name: c.name,
    rarity: c.rarity || null,
    category: c.category || null,
    dex: (c.dex_csv || '').split(',').filter(Boolean).map(Number),
    types: (c.types_csv || '').split(',').filter(Boolean),
    hp: c.hp ?? null,
    illustrator: c.illustrator || null,
    variants: [...variants],
    images: { low: c.img_low || null, high: c.img_high || null },
    printings: live.map((p) => ({
      variant: p.variant,
      label: p.label || null,
      images: { low: p.img_low || null, high: p.img_high || null },
    })),
  };
}

function setSummaryJson(s, n) {
  const official = s.official_count || n;
  return {
    id: s.id,
    name: s.name,
    releaseDate: s.release_date || null,
    logo: s.logo || null,
    cardCount: { official, total: Math.max(n, official) },
  };
}

const printsOf = (lang, cardId) =>
  cat.prepare('SELECT * FROM printings WHERE lang = ? AND card_id = ? ORDER BY variant').all(lang, cardId);

function emitSets(lang) {
  return cat.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM cards c WHERE c.lang = s.lang AND c.set_id = s.id AND c.hidden = 0) AS n
    FROM sets s WHERE s.lang = ? AND s.hidden = 0 ORDER BY s.position, s.id`).all(lang)
    .map((s) => setSummaryJson(s, s.n));
}

function emitSet(lang, id) {
  const s = cat.prepare('SELECT * FROM sets WHERE lang = ? AND id = ? AND hidden = 0').get(lang, id);
  if (!s) return null;
  const cards = cat.prepare('SELECT * FROM cards WHERE lang = ? AND set_id = ? AND hidden = 0 ORDER BY position, local_id').all(lang, id);
  // one query for every printing in the set, grouped in memory — not one
  // query per card
  const byCard = {};
  for (const p of cat.prepare(`
    SELECT p.* FROM printings p JOIN cards c ON c.lang = p.lang AND c.id = p.card_id
    WHERE c.lang = ? AND c.set_id = ? AND c.hidden = 0`).all(lang, id)) {
    (byCard[p.card_id] = byCard[p.card_id] || []).push(p);
  }
  return { ...setSummaryJson(s, cards.length), cards: cards.map((c) => cardJson(c, byCard[c.id])) };
}

function emitCard(lang, id) {
  const c = cat.prepare('SELECT * FROM cards WHERE lang = ? AND id = ? AND hidden = 0').get(lang, id);
  return c ? cardJson(c, printsOf(lang, c.id)) : null;
}

function emitSearch(lang, q) {
  const where = ['c.lang = ?', 'c.hidden = 0'];
  const args = [lang];
  if (q.name) { where.push('c.name LIKE ?'); args.push('%' + q.name + '%'); }
  if (q.set) { where.push('c.set_id = ?'); args.push(q.set); }
  if (q.rarity) { where.push('c.rarity = ?'); args.push(q.rarity); }
  // types_csv is "Fire" or "Water,Psychic" — match the whole token, not a substring
  if (q.type) { where.push("(',' || c.types_csv || ',') LIKE ?"); args.push('%,' + q.type + ',%'); }
  const W = where.join(' AND ');
  const total = cat.prepare(`SELECT COUNT(*) AS n FROM cards c WHERE ${W}`).get(...args).n;
  const perPage = Math.min(Math.max(q.perPage || 100, 1), 250);
  const page = Math.max(q.page || 1, 1);
  const rows = cat.prepare(`
    SELECT c.*, s.name AS set_name FROM cards c
    LEFT JOIN sets s ON s.lang = c.lang AND s.id = c.set_id
    WHERE ${W} ORDER BY (SELECT position FROM sets ss WHERE ss.lang = c.lang AND ss.id = c.set_id), c.position, c.id
    LIMIT ? OFFSET ?`).all(...args, perPage, (page - 1) * perPage);
  return {
    total,
    page,
    perPage,
    more: page * perPage < total,
    cards: rows.map((c) => ({ ...cardJson(c, printsOf(lang, c.id)), setName: c.set_name || null })),
  };
}

/* ---- the scanner's fingerprints: published beside the catalog, cached here
 * so the master being briefly unreachable never takes the scanner down ---- */
const scanCacheFile = (lang) => path.join(DATA_DIR, `scan-index-${lang}.json`);
function clearScanCache() {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (/^scan-index-.*\.json$/.test(f)) fs.rmSync(path.join(DATA_DIR, f), { force: true });
  }
}
async function scanIndex(lang) {
  const file = scanCacheFile(lang);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!SOURCE) return null;
  const r = await fetch(`${SOURCE}/${lang}/scan-index.json`);
  if (!r.ok) return null;
  const data = await r.json();
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

/* ============================================================
 * HTTP
 * ============================================================ */
function sendJSON(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // clients of a public API are as likely to be browsers as servers
    'Access-Control-Allow-Origin': '*',
    ...extra,
  });
  res.end(body);
}

const noCatalog = (res) => sendJSON(res, 503, {
  error: SOURCE
    ? 'The card catalog has not been pulled yet — the master may be unreachable. Try again shortly.'
    : 'No card catalog is loaded and CARD_SOURCE_URL is not set, so there is nothing to pull one from.',
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, X-API-Key, Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }
  if (req.method !== 'GET') return sendJSON(res, 405, { error: 'Method not allowed' });

  try {
    // the one open endpoint: a monitor should not need a key to ask "alive?"
    if (p === '/v1/health') {
      return sendJSON(res, 200, {
        ok: !!cat,
        catalog: !!cat,
        version: state.manifest ? state.manifest.version : null,
        sourceConfigured: !!SOURCE,
        auth: REQUIRE_TOKEN,
        checkedAt: state.checkedAt || null,
      });
    }

    // everything below the line pays its way
    const tok = gate(req, res, costOf(p, req));
    if (!tok) return;

    if (p === '/v1/me') {
      if (tok === true) return sendJSON(res, 200, { auth: 'disabled' });
      const used = (_usageOf.get(tok.id, period()) || { count: 0 }).count;
      return sendJSON(res, 200, {
        name: tok.name,
        plan: tok.plan,
        monthlyLimit: tok.monthly_limit,          // null = unlimited
        burstLimit: tok.burst_limit,
        period: period(),
        used,
        remaining: tok.monthly_limit === null ? null : Math.max(0, tok.monthly_limit - used),
        resetsAt: periodResetsAt(),
        created: tok.created,
      });
    }

    if (p === '/v1/catalog.json') {
      if (!state.manifest) return noCatalog(res);
      return sendJSON(res, 200, { ...state.manifest, fetchedAt: state.fetchedAt, checkedAt: state.checkedAt });
    }

    if (p === '/v1/catalog.db') {
      if (!cat) return noCatalog(res);
      // byte-for-byte the published file — tombstones included, because the
      // installs that pull this still merge by them. A 304 costs nothing:
      // "you already have it" is not a download.
      const etag = currentEtag();
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Access-Control-Allow-Origin': '*' });
        return res.end();
      }
      const stat = fs.statSync(CAT_FILE);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        ETag: etag,
        'Access-Control-Allow-Origin': '*',
      });
      return fs.createReadStream(CAT_FILE).pipe(res);
    }

    if (!cat && p.startsWith('/v1/')) return noCatalog(res);

    if (p === '/v1/languages') {
      return sendJSON(res, 200, {
        languages: cat.prepare('SELECT DISTINCT lang FROM sets WHERE hidden = 0 ORDER BY lang').all().map((r) => r.lang),
      });
    }

    if (p === '/v1/sets') {
      const lang = langOf(url);
      if (!lang) return sendJSON(res, 400, { error: 'That does not look like a language code' });
      return sendJSON(res, 200, { language: lang, sets: emitSets(lang) });
    }

    const setMatch = p.match(/^\/v1\/sets\/([^/]+)$/);
    if (setMatch) {
      const lang = langOf(url);
      if (!lang) return sendJSON(res, 400, { error: 'That does not look like a language code' });
      const id = decodeURIComponent(setMatch[1]);
      if (!SET_ID_RE.test(id)) return sendJSON(res, 400, { error: 'That does not look like a set id' });
      const set = emitSet(lang, id);
      return set ? sendJSON(res, 200, set) : sendJSON(res, 404, { error: 'Set not found' });
    }

    const cardMatch = p.match(/^\/v1\/cards\/([^/]+)$/);
    if (cardMatch) {
      const lang = langOf(url);
      if (!lang) return sendJSON(res, 400, { error: 'That does not look like a language code' });
      const id = decodeURIComponent(cardMatch[1]);
      if (!CARD_ID_RE.test(id)) return sendJSON(res, 400, { error: 'That does not look like a card id' });
      const card = emitCard(lang, id);
      return card ? sendJSON(res, 200, card) : sendJSON(res, 404, { error: 'Card not found' });
    }

    if (p === '/v1/cards') {
      const lang = langOf(url);
      if (!lang) return sendJSON(res, 400, { error: 'That does not look like a language code' });
      return sendJSON(res, 200, emitSearch(lang, {
        name: (url.searchParams.get('name') || '').trim(),
        set: SET_ID_RE.test(url.searchParams.get('set') || '') ? url.searchParams.get('set') : '',
        rarity: (url.searchParams.get('rarity') || '').trim(),
        type: (url.searchParams.get('type') || '').trim(),
        page: parseInt(url.searchParams.get('page') || '1', 10) || 1,
        perPage: parseInt(url.searchParams.get('perPage') || '100', 10) || 100,
      }));
    }

    if (p === '/v1/scan-index') {
      const lang = langOf(url);
      if (!lang) return sendJSON(res, 400, { error: 'That does not look like a language code' });
      const data = await scanIndex(lang);
      return data ? sendJSON(res, 200, data)
        : sendJSON(res, 404, { error: 'No scanner index is published for that language' });
    }

    return sendJSON(res, 404, { error: 'Unknown endpoint — this API serves /v1/…' });
  } catch (e) {
    return sendJSON(res, 500, { error: e.message || 'Internal error' });
  }
});

/* ============================================================
 * Boot
 * ============================================================ */
if (fs.existsSync(CAT_FILE)) {
  try {
    openCatalog();
  } catch (e) {
    console.warn('The stored catalog would not open (' + e.message + ') — it will be re-pulled.');
    cat = null;
  }
}

server.on('error', (e) => {
  console.error(`Could not listen on :${PORT} — ${e.code === 'EADDRINUSE' ? 'something is already using that port' : e.message}.`);
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`TCG Card API on http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  if (cat && state.manifest) console.log(`Serving catalog v${state.manifest.version} from disk.`);
  if (!SOURCE) console.log('CARD_SOURCE_URL is not set — serving whatever is on disk, never updating.');
});

checkForUpdate('boot');
setInterval(() => checkForUpdate('scheduled'), Math.max(CHECK_MS, 5_000));
// no catalog is an outage, not a schedule: retry hard until the first one lands
const bootRetry = setInterval(() => {
  if (cat) { clearInterval(bootRetry); return; }
  checkForUpdate('retry');
}, 30_000);

module.exports = { server };
