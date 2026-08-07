#!/usr/bin/env node
/* The API against a mock master.
 *
 * The mock publishes a real catalog.db built with node:sqlite — the same
 * schema publish-images.js writes — because a test that stubs the database
 * proves only that the stub was read. The knobs on the mock exist to reach
 * the paths that matter: a version bump, a corrupt download, a dead master.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

let failCount = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failCount++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'card-api-test-'));
const SRC_PORT = 3490;
const API_PORT = 3491;
const API2_PORT = 3492;

/* ---- fixture: a published catalog.db, exactly as the publisher writes it ---- */
const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE sets (
    lang TEXT NOT NULL DEFAULT 'en', id TEXT NOT NULL, name TEXT NOT NULL,
    release_date TEXT, logo TEXT, official_count INTEGER,
    position INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'master',
    hidden INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (lang, id));
  CREATE TABLE cards (
    lang TEXT NOT NULL DEFAULT 'en', id TEXT NOT NULL, set_id TEXT NOT NULL,
    local_id TEXT NOT NULL, name TEXT NOT NULL, rarity TEXT, category TEXT,
    dex_csv TEXT, types_csv TEXT, hp INTEGER, illustrator TEXT, variants_csv TEXT,
    img_low TEXT, img_high TEXT, position INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'master', hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lang, id));
  CREATE INDEX idx_cards_set ON cards (lang, set_id);
  CREATE TABLE printings (
    lang TEXT NOT NULL DEFAULT 'en', card_id TEXT NOT NULL, variant TEXT NOT NULL,
    label TEXT, img_low TEXT, img_high TEXT, source TEXT NOT NULL DEFAULT 'master',
    hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lang, card_id, variant));
`;

function buildFixture(file, { withNewCard = false } = {}) {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=DELETE');
  db.exec(SCHEMA);
  const set = db.prepare('INSERT INTO sets (lang,id,name,release_date,logo,official_count,position,hidden) VALUES (?,?,?,?,?,?,?,?)');
  set.run('en', 'base1', 'Base Set', '1999-01-09', 'https://cdn.test/base1-logo.png', 102, 0, 0);
  set.run('en', 'fossil', 'Fossil', '1999-10-10', null, 62, 1, 0);
  set.run('en', 'ghost', 'Removed Set', null, null, 10, 2, 1);     // tombstone
  set.run('fr', 'base1', 'Set de Base', '1999-01-09', null, 102, 0, 0);
  const card = db.prepare('INSERT INTO cards (lang,id,set_id,local_id,name,rarity,category,dex_csv,types_csv,hp,illustrator,variants_csv,img_low,img_high,position,hidden) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  card.run('en', 'base1-4', 'base1', '4', 'Charizard', 'Rare Holo', 'Pokemon', '6', 'Fire', 120, 'Mitsuhiro Arita',
    'normal,holo', 'https://cdn.test/base1/4/low.webp', 'https://cdn.test/base1/4/high.webp', 0, 0);
  card.run('en', 'base1-7', 'base1', '7', 'Squirtle', 'Common', 'Pokemon', '7', 'Water', 40, null,
    'normal', 'https://cdn.test/base1/7/low.webp', null, 1, 0);
  card.run('en', 'base1-99', 'base1', '99', 'Deleted Card', 'Common', 'Pokemon', null, null, null, null,
    'normal', null, null, 2, 1);                                    // tombstone
  card.run('en', 'fossil-1', 'fossil', '1', 'Aerodactyl', 'Rare Holo', 'Pokemon', '142', 'Fighting', 60, null,
    'normal,holo', null, null, 0, 0);
  card.run('fr', 'base1-4', 'base1', '4', 'Dracaufeu', 'Rare Holo', 'Pokemon', '6', 'Feu', 120, null,
    'normal,holo', null, null, 0, 0);
  if (withNewCard) {
    card.run('en', 'fossil-2', 'fossil', '2', 'Articuno', 'Rare Holo', 'Pokemon', '144', 'Water', 70, null,
      'normal', null, null, 1, 0);
  }
  const pr = db.prepare('INSERT INTO printings (lang,card_id,variant,label,img_low,img_high,hidden) VALUES (?,?,?,?,?,?,?)');
  pr.run('en', 'base1-4', 'cracked-ice-holo', 'Cracked Ice Holo', 'https://cdn.test/base1/4/cih.webp', null, 0);
  pr.run('en', 'fossil-1', 'holo', null, null, null, 1);            // this variant is withdrawn
  db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('schema', '1');
  db.close();
}

/* ---- the mock master: catalog.json + catalog.db + a scan index ---- */
const master = {
  version: 1,
  dbFile: path.join(TMP, 'master-v1.db'),
  corrupt: false,
  scanIndex: { algo: 'test', cards: [{ id: 'base1-4', hash: 'aa' }] },
};
buildFixture(master.dbFile);

const mockSrc = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/catalog.json') {
    const body = JSON.stringify({ version: master.version, contentHash: 'hash-v' + master.version, cards: 4, sets: 3, printings: 2 });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(body);
  }
  if (u.pathname === '/catalog.db') {
    if (master.corrupt) { res.writeHead(200); return res.end('this is not a sqlite file at all'); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return fs.createReadStream(master.dbFile).pipe(res);
  }
  if (u.pathname === '/en/scan-index.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(master.scanIndex));
  }
  res.writeHead(404); res.end('nope');
});

let AUTH = null;   // the token most checks ride on; set once the CLI has minted it
const j = async (pathAndQuery, port = API_PORT, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  if (AUTH && !opts.noAuth && !headers.Authorization && !headers['X-API-Key']) headers.Authorization = 'Bearer ' + AUTH;
  const r = await fetch(`http://localhost:${port}${pathAndQuery}`, { ...opts, headers });
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, headers: r.headers, body };
};

const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 120));
  }
};

const children = [];
function startApi(port, dataDir, source, { noAuth = false } = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      CARD_SOURCE_URL: source,
      CARD_CHECK_INTERVAL_MS: '300',
      CARD_REQUIRE_TOKEN: noAuth ? '0' : '1',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(child);
  return child;
}

/* mint a token exactly the way the operator would: through the CLI */
function mint(dataDir, args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'tokens.js'), ...args],
    { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
  const m = (r.stdout || '').match(/ptcg_live_[0-9a-f]{40}/);
  if (!m) throw new Error('the CLI issued no token:\n' + r.stdout + r.stderr);
  return m[0];
}
const cli = (dataDir, args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'tokens.js'), ...args],
  { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' }).stdout || '';

(async () => {
  mockSrc.listen(SRC_PORT);

  /* ---- an API with nothing: no catalog on disk, a master that is not there.
   * Runs with the gate off — which is also the check that CARD_REQUIRE_TOKEN=0
   * exists for local development. ---- */
  startApi(API2_PORT, path.join(TMP, 'api2-data'), 'http://localhost:39999', { noAuth: true });
  await until(async () => (await j('/v1/health', API2_PORT)).status === 200);
  const bare = await j('/v1/health', API2_PORT);
  const bareSets = await j('/v1/sets?lang=en', API2_PORT);
  check('an empty API says so instead of pretending', bare.body.ok === false && bare.body.catalog === false);
  check('and its data endpoints answer 503, not an empty list',
    bareSets.status === 503 && /master may be unreachable/.test(bareSets.body.error));

  /* ---- the real one: gated, boots, pulls v1, serves ---- */
  const apiData = path.join(TMP, 'api-data');
  AUTH = mint(apiData, ['issue', '--name', 'Set Tracker (test)', '--plan', 'app']);
  const tokTiny = mint(apiData, ['issue', '--name', 'Tiny allowance', '--plan', 'starter', '--monthly', '3', '--burst', '100']);
  const tokBurst = mint(apiData, ['issue', '--name', 'Burst-capped unlimited', '--plan', 'unlimited', '--burst', '2']);
  const tokPull = mint(apiData, ['issue', '--name', 'One pull and a half', '--monthly', '150', '--burst', '100']);
  startApi(API_PORT, apiData, `http://localhost:${SRC_PORT}`);
  check('the API pulls the catalog on boot',
    await until(async () => (await j('/v1/health')).body.catalog === true));
  check('and reports the master version it holds', (await j('/v1/health')).body.version === 1);

  const langs = await j('/v1/languages');
  check('languages come from the data, not a config', JSON.stringify(langs.body.languages) === '["en","fr"]');

  const sets = await j('/v1/sets?lang=en');
  check('the set list carries counts and hides tombstones',
    sets.body.sets.length === 2 && sets.body.sets[0].id === 'base1' &&
    sets.body.sets[0].cardCount.official === 102 && sets.body.sets[0].cardCount.total === 102 &&
    !sets.body.sets.some((s) => s.id === 'ghost'));

  const base1 = await j('/v1/sets/base1?lang=en');
  check('a set brings its cards, in order, without the deleted one',
    base1.body.cards.length === 2 && base1.body.cards[0].id === 'base1-4' &&
    !base1.body.cards.some((c) => c.id === 'base1-99'));
  const zard = base1.body.cards[0];
  check('a card carries the fields a client needs',
    zard.name === 'Charizard' && zard.number === '4' && zard.rarity === 'Rare Holo' &&
    zard.dex[0] === 6 && zard.types[0] === 'Fire' && zard.hp === 120 &&
    zard.images.low === 'https://cdn.test/base1/4/low.webp');
  check('custom printings ride along with their labels',
    zard.printings.length === 1 && zard.printings[0].label === 'Cracked Ice Holo' &&
    zard.variants.includes('cracked-ice-holo'));

  const aero = await j('/v1/cards/fossil-1?lang=en');
  check('a withdrawn printing takes its variant off the card',
    aero.body.variants.includes('normal') && !aero.body.variants.includes('holo') &&
    aero.body.printings.length === 0);

  check('a tombstoned card is not found, not served', (await j('/v1/cards/base1-99?lang=en')).status === 404);
  check('the French copy is its own catalog', (await j('/v1/cards/base1-4?lang=fr')).body.name === 'Dracaufeu');

  const found = await j('/v1/cards?lang=en&name=chari');
  check('search matches names case-insensitively', found.body.total === 1 && found.body.cards[0].id === 'base1-4');
  check('and search results say which set a card is from', found.body.cards[0].setName === 'Base Set');
  const paged = await j('/v1/cards?lang=en&perPage=1&page=2');
  check('pagination pages through everything visible',
    paged.body.total === 3 && paged.body.cards.length === 1 && paged.body.more === true);
  const typed = await j('/v1/cards?lang=en&type=Water');
  check('a type filter matches whole types, not substrings', typed.body.total === 1 && typed.body.cards[0].id === 'base1-7');

  const cors = await j('/v1/sets?lang=en');
  check('browser clients are welcome (CORS on answers)', cors.headers.get('access-control-allow-origin') === '*');

  /* ---- the gate: who may ask, and how much ---- */
  check('health answers with no token at all — a monitor needs no key',
    (await j('/v1/health', API_PORT, { noAuth: true })).status === 200);
  check('everything else refuses a missing token with a sentence, not a hang',
    (await j('/v1/sets?lang=en', API_PORT, { noAuth: true })).status === 401);
  check('an invented token is turned away',
    (await j('/v1/sets?lang=en', API_PORT, { headers: { Authorization: 'Bearer ptcg_live_' + 'f'.repeat(40) } })).status === 401);
  check('and junk that could never be a token is too',
    (await j('/v1/sets?lang=en', API_PORT, { headers: { Authorization: 'Bearer hello' } })).status === 401);
  check('X-API-Key works for clients that cannot set Authorization',
    (await j('/v1/cards/base1-4?lang=en', API_PORT, { headers: { 'X-API-Key': AUTH } })).status === 200);
  check('an unlimited token still sees its own weather',
    cors.headers.get('x-quota-limit') === 'unlimited' && cors.headers.get('x-ratelimit-limit') === '300');

  // a small allowance runs out, and the wall explains itself
  const tiny = (q) => j(q, API_PORT, { headers: { Authorization: 'Bearer ' + tokTiny } });
  await tiny('/v1/cards/base1-4?lang=en');
  await tiny('/v1/cards/base1-7?lang=en');
  const lastGood = await tiny('/v1/cards/fossil-1?lang=en');
  check('quota headers count down to the wall',
    lastGood.headers.get('x-quota-used') === '3' && lastGood.headers.get('x-quota-remaining') === '0');
  const spent = await tiny('/v1/cards/base1-4?lang=en');
  check('a spent allowance is a 402 that says when it resets',
    spent.status === 402 && /resets \d{4}-\d{2}-\d{2}/.test(spent.body.error));
  check('but the free manifest still answers — polling for updates costs nothing',
    (await tiny('/v1/catalog.json')).status === 200);
  const me = await tiny('/v1/me');
  check('/v1/me tells a token the truth about itself',
    me.status === 200 && me.body.used === 3 && me.body.remaining === 0 && me.body.plan === 'starter');

  // the burst window guards the host, unlimited plans included
  const bursty = (q) => j(q, API_PORT, { headers: { Authorization: 'Bearer ' + tokBurst } });
  await bursty('/v1/cards/base1-4?lang=en');
  await bursty('/v1/cards/base1-7?lang=en');
  const walled = await bursty('/v1/cards/fossil-1?lang=en');
  check('an unlimited plan still hits the per-minute ceiling',
    walled.status === 429 && parseInt(walled.headers.get('retry-after'), 10) >= 1 &&
    parseInt(walled.headers.get('retry-after'), 10) <= 60);

  // revocation is immediate, no restart, no cache to wait out
  const burstId = (cli(apiData, ['list']).match(/#(\d+)[^\n]*Burst-capped/) || [])[1];
  cli(apiData, ['revoke', burstId]);
  check('a revoked token gets 403 on its very next request',
    (await bursty('/v1/me')).status === 403);
  check('the ledger shows names, plans and spend',
    /Tiny allowance/.test(cli(apiData, ['list'])) && /REVOKED/.test(cli(apiData, ['list'])));

  /* ---- the bulk file: byte-for-byte, tombstones included ---- */
  const dbRes = await fetch(`http://localhost:${API_PORT}/v1/catalog.db`, { headers: { Authorization: 'Bearer ' + AUTH } });
  const dbBytes = Buffer.from(await dbRes.arrayBuffer());
  const onDisk = fs.readFileSync(path.join(TMP, 'api-data', 'catalog.db'));
  check('catalog.db is served byte-for-byte', dbBytes.equals(onDisk));
  const pulled = path.join(TMP, 'pulled.db');
  fs.writeFileSync(pulled, dbBytes);
  const pdb = new DatabaseSync(pulled);
  check('with the tombstones still inside, because installs merge by them',
    pdb.prepare("SELECT hidden FROM cards WHERE lang='en' AND id='base1-99'").get().hidden === 1);
  pdb.close();
  const etag = dbRes.headers.get('etag');
  const again = await fetch(`http://localhost:${API_PORT}/v1/catalog.db`,
    { headers: { 'If-None-Match': etag, Authorization: 'Bearer ' + AUTH } });
  check('an install that already has this version is told so in one round trip', again.status === 304);

  /* ---- the pull is priced like the whole database it is ---- */
  const puller = (q, h = {}) => j(q, API_PORT, { headers: { Authorization: 'Bearer ' + tokPull, ...h } });
  const pull1 = await fetch(`http://localhost:${API_PORT}/v1/catalog.db`, { headers: { Authorization: 'Bearer ' + tokPull } });
  check('a bulk pull costs 100, not 1', pull1.status === 200 && pull1.headers.get('x-quota-used') === '100');
  const mePull = await puller('/v1/me');
  check('and the spend is durable, visible, and honest', mePull.body.used === 100 && mePull.body.remaining === 50);
  check('a second pull does not fit in what is left', (await puller('/v1/catalog.db')).status === 402);
  check('but "you already have it" is free even to a broke token',
    (await puller('/v1/catalog.db', { 'If-None-Match': etag })).status === 304);

  /* ---- the master moves on; the API follows by itself ---- */
  buildFixture(master.dbFile, { withNewCard: true });
  master.version = 2;
  check('a version bump is picked up without a restart',
    await until(async () => (await j('/v1/health')).body.version === 2));
  check('and the new card is being served', (await j('/v1/cards/fossil-2?lang=en')).status === 200);

  /* ---- a corrupt download must never replace a working catalog ---- */
  master.corrupt = true;
  master.version = 3;
  await new Promise((r) => setTimeout(r, 1500));
  const afterCorrupt = await j('/v1/health');
  check('a garbage download is refused and the old catalog keeps serving',
    afterCorrupt.body.version === 2 && (await j('/v1/cards/fossil-2?lang=en')).status === 200);
  master.corrupt = false;
  check('and the retry lands the real file once the master recovers',
    await until(async () => (await j('/v1/health')).body.version === 3));

  /* ---- the scanner index: fetched once, then owned ---- */
  const scan1 = await j('/v1/scan-index?lang=en');
  check('the scanner index passes through from the master', scan1.body.algo === 'test' && scan1.body.cards.length === 1);
  mockSrc.close();
  await new Promise((r) => setTimeout(r, 300));
  const scan2 = await j('/v1/scan-index?lang=en');
  check('and is served from cache when the master is gone', scan2.status === 200 && scan2.body.algo === 'test');

  check('an unknown path is a 404 with an explanation, not a hang',
    (await j('/v1/nothing-here')).status === 404);

  /* ---- the ledger survives what the burst window is allowed to forget ---- */
  children[1].kill();                                    // the gated API; api2 stays up
  await new Promise((r) => setTimeout(r, 300));
  startApi(API_PORT, apiData, `http://localhost:${SRC_PORT}`);
  check('a restarted API still holds its catalog (the mock is dead by now)',
    await until(async () => (await j('/v1/health', API_PORT, { noAuth: true })).body.catalog === true));
  const meAfter = await j('/v1/me', API_PORT, { headers: { Authorization: 'Bearer ' + tokPull } });
  check('and the monthly spend came back with it — quota is a ledger, not a mood',
    meAfter.status === 200 && meAfter.body.used === 100);
  check('while the tiny token is still spent, not refreshed by a reboot',
    (await j('/v1/cards/base1-4?lang=en', API_PORT, { headers: { Authorization: 'Bearer ' + tokTiny } })).status === 402);

  for (const c of children) c.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failCount ? `${failCount} check(s) FAILED` : 'All checks passed.');
  process.exit(failCount ? 1 : 0);
})().catch((e) => {
  console.error(e);
  for (const c of children) c.kill();
  process.exit(1);
});
