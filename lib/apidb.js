/* The service's own database — tokens and usage, kept strictly apart from the
 * catalog. The catalog file gets thrown away and replaced whenever the master
 * moves; who is allowed in, and how much they have spent, must survive that.
 *
 * Shared between the server and the token CLI so the two cannot disagree
 * about the schema, the plans, or what a token even looks like.
 */
'use strict';

const path = require('path');
const crypto = require('crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error('This needs Node 22.5+ (for the built-in node:sqlite database).');
  process.exit(1);
}

/* Plans. The names are the contract; the numbers are placeholders until
 * pricing is real (PLAN.md, open question 2) — which is why every token also
 * STORES its resolved limits at issue time. Editing this table later changes
 * future tokens, never quietly re-prices the ones already handed out.
 *
 *   monthly: requests per calendar month (UTC). null = unlimited.
 *   burst:   requests per minute. Applies to every plan, unlimited included —
 *            unlimited is a commercial promise, not permission to saturate
 *            the host.
 */
const PLANS = {
  selfhost: { monthly: 2500, burst: 60 },    // the free tier: one tracker install's pulls + updates
  app: { monthly: null, burst: 300 },        // first-party applications
  starter: { monthly: 10000, burst: 60 },
  pro: { monthly: 100000, burst: 120 },
  unlimited: { monthly: null, burst: 300 },
};

function openApiDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'api.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    -- Only the SHA-256 of a token is stored, never the token: a copy of this
    -- database must not be a set of keys. The raw value exists exactly once,
    -- on the screen of whoever issued it. The prefix column keeps enough of
    -- the raw value (ptcg_live_ + a few characters) that a token in hand can
    -- be matched to a row without being able to go the other way.
    CREATE TABLE IF NOT EXISTS tokens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      hash          TEXT NOT NULL UNIQUE,
      prefix        TEXT NOT NULL,
      plan          TEXT NOT NULL,
      monthly_limit INTEGER,                 -- NULL = unlimited
      burst_limit   INTEGER NOT NULL,
      notes         TEXT,
      created       TEXT NOT NULL,
      last_used     INTEGER,
      revoked       INTEGER NOT NULL DEFAULT 0
    );
    -- one row per token per calendar month; the quota question is one lookup.
    -- THIS node's own spend only — a peer's spend lives in peer_usage.
    CREATE TABLE IF NOT EXISTS usage (
      token_id INTEGER NOT NULL,
      period   TEXT NOT NULL,                -- 'YYYY-MM', UTC
      count    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (token_id, period)
    );
    -- what the OTHER nodes have counted, as absolute per-node totals — a
    -- grow-only counter per (node, token, month), so applying the same
    -- exchange twice changes nothing and arrival order does not matter.
    -- Keyed by token hash, not local id: AUTOINCREMENT ids differ per node,
    -- the hash is the token's one global name.
    CREATE TABLE IF NOT EXISTS peer_usage (
      node       TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      period     TEXT NOT NULL,
      count      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (node, token_hash, period)
    );
  `);
  // tokens replicate between nodes by last-write-wins on this stamp — a node
  // that never clusters simply never reads it
  try { db.exec('ALTER TABLE tokens ADD COLUMN updated INTEGER NOT NULL DEFAULT 0'); } catch { /* already present */ }
  return db;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ptcg_live_ + 160 bits of hex. The prefix makes a leaked token greppable in
 * public code, and lets obvious junk be rejected before it costs a lookup. */
const newToken = () => 'ptcg_live_' + crypto.randomBytes(20).toString('hex');
const TOKEN_RE = /^ptcg_live_[0-9a-f]{40}$/;

/** The current quota period, UTC — '2026-08'. */
const period = () => new Date().toISOString().slice(0, 7);

/** When the current period's count stops mattering. */
function periodResetsAt() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/** A write stamp that cannot lose to a peer's slightly-fast clock: always at
 * least one past whatever the row carried before. Revoking a token must win
 * the replication argument even against a minting node ten minutes ahead. */
const writeStamp = (prev) => Math.max(Date.now(), (prev || 0) + 1);

module.exports = { PLANS, openApiDb, sha256, newToken, TOKEN_RE, period, periodResetsAt, writeStamp };
