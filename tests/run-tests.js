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
const IMGOFF_PORT = 3493;
const SIGNED_PORT = 3494;
const EAST_PORT = 3495;
const WEST_PORT = 3496;
const CLUSTER_KEY = 'a-test-cluster-key';
const IMG = `http://localhost:${SRC_PORT}`;   // fixture image URLs live under the mock master

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
  set.run('en', 'base1', 'Base Set', '1999-01-09', `${IMG}/en/images/base1/logo.webp`, 102, 0, 0);
  set.run('en', 'fossil', 'Fossil', '1999-10-10', null, 62, 1, 0);
  set.run('en', 'ghost', 'Removed Set', null, null, 10, 2, 1);     // tombstone
  set.run('fr', 'base1', 'Set de Base', '1999-01-09', null, 102, 0, 0);
  const card = db.prepare('INSERT INTO cards (lang,id,set_id,local_id,name,rarity,category,dex_csv,types_csv,hp,illustrator,variants_csv,img_low,img_high,position,hidden) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  card.run('en', 'base1-4', 'base1', '4', 'Charizard', 'Rare Holo', 'Pokemon', '6', 'Fire', 120, 'Mitsuhiro Arita',
    'normal,holo', `${IMG}/en/images/base1/4/low.webp`, `${IMG}/en/images/base1/4/high.webp`, 0, 0);
  card.run('en', 'base1-7', 'base1', '7', 'Squirtle', 'Common', 'Pokemon', '7', 'Water', 40, null,
    'normal', `${IMG}/en/images/base1/7/low.webp`, 'https://elsewhere.test/sq-high.webp', 1, 0);
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
  pr.run('en', 'base1-4', 'cracked-ice-holo', 'Cracked Ice Holo', `${IMG}/en/images/base1/4/cih.webp`, null, 0);
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
  if (/^\/en\/images\/.+\.webp$/.test(u.pathname)) {
    res.writeHead(200, { 'Content-Type': 'image/webp' });
    return res.end('WEBP-BYTES:' + u.pathname);
  }
  if (u.pathname === '/en/scan-index.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(master.scanIndex));
  }
  res.writeHead(404); res.end('nope');
});
mockSrc.on('error', (e) => {
  console.error(`The mock master could not listen on :${SRC_PORT} (${e.code}) — a previous run may still be alive.`);
  process.exit(1);
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
function startApi(port, dataDir, source, { noAuth = false, env = {} } = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      CARD_SOURCE_URL: source,
      CARD_CHECK_INTERVAL_MS: '300',
      CARD_REQUIRE_TOKEN: noAuth ? '0' : '1',
      ...env,
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
    zard.images.low === '/v1/images/en/images/base1/4/low.webp');
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
  check('every CLI command says which ledger file it opened',
    cli(apiData, ['list']).includes(path.join(apiData, 'api.db')));
  // the value in your hand is the value you want dead — no id lookup required
  const tokByVal = mint(apiData, ['issue', '--name', 'Revoked by its own value', '--plan', 'starter']);
  cli(apiData, ['revoke', tokByVal]);
  check('revoke accepts the raw token value itself',
    (await j('/v1/me', API_PORT, { headers: { Authorization: 'Bearer ' + tokByVal } })).status === 403);

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

  /* ---- images: addresses out, bytes never through ---- */
  const zardImg = (await j('/v1/cards/base1-4?lang=en')).body;
  check('image locations point back at the API, printings included',
    zardImg.images.high === '/v1/images/en/images/base1/4/high.webp' &&
    zardImg.printings[0].images.low === '/v1/images/en/images/base1/4/cih.webp');
  check('the set logo is rewritten the same way',
    (await j('/v1/sets?lang=en')).body.sets[0].logo === '/v1/images/en/images/base1/logo.webp');
  check('an image hosted somewhere else is not ours to gate, and passes through',
    (await j('/v1/cards/base1-7?lang=en')).body.images.high === 'https://elsewhere.test/sq-high.webp');

  const imgUrl = `http://localhost:${API_PORT}/v1/images/en/images/base1/4/low.webp`;
  const img = await fetch(imgUrl, { headers: { Authorization: 'Bearer ' + AUTH }, redirect: 'manual' });
  check('an image answer is an address, not bytes',
    img.status === 302 && img.headers.get('location') === `${IMG}/en/images/base1/4/low.webp`);
  const followed = await fetch(imgUrl, { headers: { Authorization: 'Bearer ' + AUTH } });
  check('and following it lands where the bytes actually live',
    followed.status === 200 && (await followed.text()).startsWith('WEBP-BYTES:'));

  check('an image still wants a token', (await fetch(imgUrl, { redirect: 'manual' })).status === 401);
  const brokeImg = await fetch(imgUrl, { headers: { Authorization: 'Bearer ' + tokTiny }, redirect: 'manual' });
  check('a token with nothing left this month can still see pictures — images cost 0, by policy',
    brokeImg.status === 302 && brokeImg.headers.get('x-quota-remaining') === '0');
  const tokImg = mint(apiData, ['issue', '--name', 'Image burster', '--plan', 'unlimited', '--burst', '2']);
  await fetch(imgUrl, { headers: { Authorization: 'Bearer ' + tokImg }, redirect: 'manual' });
  await fetch(imgUrl, { headers: { Authorization: 'Bearer ' + tokImg }, redirect: 'manual' });
  check('but the burst cap still stands — it protects the host, not the ledger',
    (await fetch(imgUrl, { headers: { Authorization: 'Bearer ' + tokImg }, redirect: 'manual' })).status === 429);

  check('a path that is not an image is refused',
    (await j('/v1/images/en/secrets.txt')).status === 400);
  check('and dotdot does not travel',
    (await j('/v1/images/..%2f..%2fdata%2fapi.db')).status === 400);

  /* ---- the severability switch: one flag, no artwork, data untouched ---- */
  startApi(IMGOFF_PORT, path.join(TMP, 'imgoff-data'), `http://localhost:${SRC_PORT}`,
    { noAuth: true, env: { IMAGES_ENABLED: '0' } });
  await until(async () => (await j('/v1/health', IMGOFF_PORT)).body.catalog === true);
  check('images off: the endpoint is gone, and says so in a sentence',
    (await j('/v1/images/en/images/base1/4/low.webp', IMGOFF_PORT)).status === 404);
  const offCard = (await j('/v1/cards/base1-4?lang=en', IMGOFF_PORT)).body;
  check('images off: the JSON hands out no artwork addresses at all — an address is distribution too',
    offCard.images.low === null && offCard.images.high === null &&
    offCard.printings[0].images.low === null &&
    (await j('/v1/sets?lang=en', IMGOFF_PORT)).body.sets[0].logo === null);
  check('images off: the card data is untouched',
    offCard.name === 'Charizard' && offCard.variants.includes('cracked-ice-holo'));

  /* ---- with bucket credentials, the address is presigned and short-lived ---- */
  startApi(SIGNED_PORT, path.join(TMP, 'signed-data'), `http://localhost:${SRC_PORT}`, {
    noAuth: true,
    env: {
      R2_ACCOUNT_ID: 'testacct', R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
      R2_SECRET_ACCESS_KEY: 'secretsecret', R2_BUCKET: 'cards',
      CARD_PUBLIC_URL: 'https://api.example.test',
    },
  });
  await until(async () => (await j('/v1/health', SIGNED_PORT)).body.catalog === true);
  const signed = await fetch(`http://localhost:${SIGNED_PORT}/v1/images/en/images/base1/4/low.webp`, { redirect: 'manual' });
  const loc = new URL(signed.headers.get('location'));
  check('with credentials, the address is the private bucket, not the public one',
    signed.status === 302 && loc.host === 'testacct.r2.cloudflarestorage.com' &&
    loc.pathname === '/cards/en/images/base1/4/low.webp');
  check('presigned, host-bound, and it expires',
    loc.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256' &&
    loc.searchParams.get('X-Amz-Expires') === '300' &&
    loc.searchParams.get('X-Amz-SignedHeaders') === 'host' &&
    /^[0-9a-f]{64}$/.test(loc.searchParams.get('X-Amz-Signature') || ''));
  check('a configured public URL makes the JSON addresses absolute',
    (await j('/v1/cards/base1-4?lang=en', SIGNED_PORT)).body.images.low ===
      'https://api.example.test/v1/images/en/images/base1/4/low.webp');

  /* ---- two homes for one service: the cluster ----
   * Two nodes, two data directories, one wall. Everything here is the
   * distributed question: does a token minted on one coast work on the
   * other, and is a limit one limit rather than one per server? ---- */
  const eastData = path.join(TMP, 'east-data');
  const westData = path.join(TMP, 'west-data');
  const clusterEnv = (me, peerPort) => ({
    CARD_NODE_ID: me,
    CARD_PEERS: `http://localhost:${peerPort}`,
    CARD_CLUSTER_KEY: CLUSTER_KEY,
    CARD_SYNC_INTERVAL_MS: '300',
  });
  startApi(EAST_PORT, eastData, `http://localhost:${SRC_PORT}`, { env: clusterEnv('east', WEST_PORT) });
  const westChild = startApi(WEST_PORT, westData, `http://localhost:${SRC_PORT}`, { env: clusterEnv('west', EAST_PORT) });
  await until(async () => (await j('/v1/health', EAST_PORT, { noAuth: true })).body.catalog === true);
  await until(async () => (await j('/v1/health', WEST_PORT, { noAuth: true })).body.catalog === true);
  check('each node knows its own name',
    (await j('/v1/health', EAST_PORT, { noAuth: true })).body.node === 'east' &&
    (await j('/v1/health', WEST_PORT, { noAuth: true })).body.node === 'west');
  check('and health shows the peer once an exchange has landed',
    await until(async () => {
      const c = (await j('/v1/health', EAST_PORT, { noAuth: true })).body.cluster;
      return c && c[0] && c[0].ok === true;
    }));

  // a key minted on one coast works on the other
  const eastTok = mint(eastData, ['issue', '--name', 'Cross-country', '--monthly', '10', '--burst', '100']);
  const onWest = (q, tok = eastTok, opts = {}) => j(q, WEST_PORT, { headers: { Authorization: 'Bearer ' + tok }, ...opts });
  const onEast = (q, tok = eastTok, opts = {}) => j(q, EAST_PORT, { headers: { Authorization: 'Bearer ' + tok }, ...opts });
  check('a token minted on the east coast is honored on the west',
    await until(async () => (await onWest('/v1/me')).status === 200));

  // one month, not one month per server
  for (let i = 0; i < 6; i++) await onEast('/v1/cards/base1-4?lang=en');
  check('spend made in the east is visible from the west',
    await until(async () => ((await onWest('/v1/me')).body || {}).used === 6));
  for (let i = 0; i < 4; i++) await onWest('/v1/cards/base1-7?lang=en');
  check('the allowance is one wall, not one per server',
    (await onWest('/v1/cards/base1-4?lang=en')).status === 402);
  check('and the east agrees once the ledgers have crossed',
    await until(async () => ((await onEast('/v1/me')).body || {}).used === 10) &&
    (await onEast('/v1/cards/base1-4?lang=en')).status === 402);

  // the burst window is shared the same way, within one exchange of drift
  const burstTok = mint(eastData, ['issue', '--name', 'Coast-to-coast burst', '--plan', 'unlimited', '--burst', '5']);
  check('the burst token crossed over first',
    await until(async () => (await onWest('/v1/me', burstTok)).status === 200));
  // that /v1/me probe on the west counted once; spend three in the east
  for (let i = 0; i < 3; i++) await onEast('/v1/languages', burstTok);
  // wait for the east's window to reach the west, without touching the token
  await new Promise((r) => setTimeout(r, 900));
  const w1 = await onWest('/v1/languages', burstTok);      // west window: 1 probe + this = 2, east 3 → at the wall
  const w2 = await onWest('/v1/languages', burstTok);      // 2 + 1 + 3 = 6 > 5
  check('a burst cap is one ceiling for the whole cluster',
    w1.status === 200 && w2.status === 429 && (w2.headers.get('retry-after') || '') !== '');

  // revocation crosses the country too — minted east, killed west
  const westList = cli(westData, ['list']);
  const westId = (westList.match(new RegExp('#(\\d+)\\s+' + eastTok.slice(0, 16))) || [])[1];
  check('the west can even see it in its own ledger', !!westId);
  cli(westData, ['revoke', westId]);
  check('a revocation on one coast lands on the other',
    await until(async () => (await onEast('/v1/me')).status === 403));

  // the peers' door has its own lock
  const forged = await fetch(`http://localhost:${EAST_PORT}/v1/cluster/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cluster-Signature': 'f'.repeat(64) },
    body: JSON.stringify({ node: 'mallory', tokens: [], usage: {}, burst: {} }),
  });
  check('an exchange without the cluster key is turned away', forged.status === 401);

  // one coast going dark must not take the other with it
  westChild.kill();
  await new Promise((r) => { if (westChild.exitCode !== null) return r(); westChild.once('exit', r); });
  // probed with a key the east actually holds — the suite's main token lives
  // in a different install's ledger, and the east refusing it is correctness
  const soloTok = mint(eastData, ['issue', '--name', 'Alone on the coast', '--plan', 'app']);
  check('the east keeps serving with the west gone',
    (await onEast('/v1/sets?lang=en', soloTok)).status === 200);
  check('and says so instead of pretending',
    await until(async () => {
      const c = (await j('/v1/health', EAST_PORT, { noAuth: true })).body.cluster;
      return c && c[0] && c[0].ok === false;
    }));

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
  const gated = children[1];                             // the gated API; api2 stays up
  gated.kill();
  // kill() only asks — wait for the exit, or on Windows the new instance can
  // find the port still held by the old one's ghost
  await new Promise((r) => { if (gated.exitCode !== null) return r(); gated.once('exit', r); });
  await new Promise((r) => setTimeout(r, 200));
  startApi(API_PORT, apiData, `http://localhost:${SRC_PORT}`);
  check('a restarted API still holds its catalog (the mock is dead by now)',
    await until(async () => (await j('/v1/health', API_PORT, { noAuth: true })).body.catalog === true));
  const meAfter = await j('/v1/me', API_PORT, { headers: { Authorization: 'Bearer ' + tokPull } });
  check('and the monthly spend came back with it — quota is a ledger, not a mood',
    meAfter.status === 200 && meAfter.body.used === 100);
  check('while the tiny token is still spent, not refreshed by a reboot',
    (await j('/v1/cards/base1-4?lang=en', API_PORT, { headers: { Authorization: 'Bearer ' + tokTiny } })).status === 402);

  /* ---- cleanup, the Windows way ----
   * kill() only ASKS a child to die, and Windows refuses to delete files a
   * living process still holds open — so removing the temp dir straight
   * after the kills is a race the sandbox's Linux always won and a real
   * Windows box promptly lost. Wait for every child to actually exit, retry
   * the removal (SQLite's file locks can outlive the process by a beat),
   * and never let the janitor fail a suite the checks passed: a leftover
   * temp dir is the OS temp cleaner's problem, not a test failure. */
  for (const c of children) c.kill();
  await Promise.all(children.map((c) => new Promise((r) => {
    if (c.exitCode !== null) return r();
    c.once('exit', r);
    setTimeout(r, 3000);       // a stuck child must not hang the suite either
  })));
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    console.log(`(left ${TMP} behind — the temp cleaner will take it)`);
  }
  console.log(failCount ? `${failCount} check(s) FAILED` : 'All checks passed.');
  process.exit(failCount ? 1 : 0);
})().catch((e) => {
  console.error(e);
  for (const c of children) c.kill();
  process.exit(1);
});
