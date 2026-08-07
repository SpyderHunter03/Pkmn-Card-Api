#!/usr/bin/env node
/* Issue, inspect and revoke API tokens — the human half of Phase 2.
 *
 * There is no signup page and no payment hook yet, on purpose: a token is
 * something the operator mints, hands over, and can kill. When billing ever
 * exists, it calls the same code paths this does; nothing gets reworked.
 *
 * Usage (DATA_DIR chooses which install's tokens, default ./data):
 *   node scripts/tokens.js issue --name "Set Tracker (prod)" --plan app
 *   node scripts/tokens.js issue --name "Free self-hoster" --plan selfhost
 *   node scripts/tokens.js issue --name "Custom" --monthly 5000 --burst 30
 *   node scripts/tokens.js list
 *   node scripts/tokens.js show 3
 *   node scripts/tokens.js revoke 3
 */
'use strict';

const path = require('path');
const { PLANS, openApiDb, sha256, newToken, period } = require(path.join(__dirname, '..', 'lib', 'apidb'));

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
require('fs').mkdirSync(DATA_DIR, { recursive: true });
const db = openApiDb(DATA_DIR);

const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const fail = (msg) => { console.error(msg); process.exit(1); };

if (cmd === 'issue') {
  const name = (opt('name', '') || '').trim();
  if (!name) fail('A token needs a --name — it is how you will recognise it in `list` a year from now.');
  const planName = opt('plan', 'starter');
  const plan = PLANS[planName];
  if (!plan) fail(`Unknown plan "${planName}". Plans: ${Object.keys(PLANS).join(', ')} — or set --monthly / --burst directly.`);
  const monthlyRaw = opt('monthly', null);
  const monthly = monthlyRaw === null ? plan.monthly
    : (monthlyRaw === 'unlimited' ? null : parseInt(monthlyRaw, 10));
  if (monthly !== null && !(Number.isInteger(monthly) && monthly > 0)) fail('--monthly must be a positive number, or "unlimited".');
  const burst = parseInt(opt('burst', String(plan.burst)), 10);
  if (!(Number.isInteger(burst) && burst > 0)) fail('--burst must be a positive number of requests per minute.');

  const raw = newToken();
  db.prepare(`INSERT INTO tokens (name, hash, prefix, plan, monthly_limit, burst_limit, notes, created)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(name, sha256(raw), raw.slice(0, 16), planName, monthly, burst, opt('notes', null), new Date().toISOString());

  console.log(`Issued "${name}" — plan ${planName}, ` +
    `${monthly === null ? 'unlimited requests' : monthly + ' requests'}/month, ${burst}/minute.`);
  console.log('');
  console.log(`  Token (shown once, store it now): ${raw}`);
  console.log('');
  console.log('Only its hash is kept here. If this value is lost, revoke and issue a new one.');
  process.exit(0);
}

if (cmd === 'list') {
  const rows = db.prepare(`
    SELECT t.*, COALESCE(u.count, 0) AS used FROM tokens t
    LEFT JOIN usage u ON u.token_id = t.id AND u.period = ?
    ORDER BY t.id`).all(period());
  if (!rows.length) { console.log('No tokens yet — `issue` makes one.'); process.exit(0); }
  for (const t of rows) {
    const quota = t.monthly_limit === null ? 'unlimited' : `${t.used}/${t.monthly_limit}`;
    const state = t.revoked ? 'REVOKED' : 'active';
    const seen = t.last_used ? new Date(t.last_used).toISOString().slice(0, 16).replace('T', ' ') : 'never';
    console.log(`#${t.id}  ${t.prefix}…  ${state}  plan=${t.plan}  month=${quota}  burst=${t.burst_limit}/min  last used ${seen}  — ${t.name}`);
  }
  process.exit(0);
}

if (cmd === 'show' || cmd === 'revoke' || cmd === 'restore') {
  const id = parseInt(args[0], 10);
  const t = Number.isInteger(id) ? db.prepare('SELECT * FROM tokens WHERE id = ?').get(id) : null;
  if (!t) fail('No token with that id — `list` shows them.');
  if (cmd === 'revoke') {
    db.prepare('UPDATE tokens SET revoked = 1 WHERE id = ?').run(id);
    console.log(`#${id} "${t.name}" is revoked. Every request it makes from now on gets 403.`);
  } else if (cmd === 'restore') {
    db.prepare('UPDATE tokens SET revoked = 0 WHERE id = ?').run(id);
    console.log(`#${id} "${t.name}" works again.`);
  } else {
    const used = db.prepare('SELECT count FROM usage WHERE token_id = ? AND period = ?').get(id, period());
    console.log(JSON.stringify({ ...t, hash: undefined, usedThisPeriod: (used && used.count) || 0 }, null, 2));
  }
  process.exit(0);
}

fail(`Usage: node scripts/tokens.js <issue|list|show|revoke|restore> …
  issue --name "…" [--plan ${Object.keys(PLANS).join('|')}] [--monthly N|unlimited] [--burst N] [--notes "…"]
  list · show <id> · revoke <id> · restore <id>`);
