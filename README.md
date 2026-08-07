# TCG Card API

A standalone service that serves a published card catalog — sets, cards,
printings, the scanner's fingerprint index, and the bulk database file — to
any application that wants cards without wanting to *be* a card database.

It exists because the card data used to live inside one tracker app, and the
moment a second application wanted the same cards, "deploy a whole tracker to
get at its database" stopped being an answer. This service is the split: the
data has one home, and every app — the original tracker included — is just a
client.

**Zero dependencies.** Node ≥ 22.5 (the built-in `node:sqlite`), one process,
one data directory. The same deployment shape as the tracker it came from.

## How it gets its data

It is a *consumer* of the published master, not a second authority:

```
maintainer workspace ──publish──▶ bucket (catalog.db, catalog.json, images)
                                     │
                                     │  pulled on boot + every 6h
                                     ▼
                                TCG Card API ──▶ your apps
```

On boot it pings `catalog.json` (one tiny request), pulls `catalog.db` when
the version has moved, validates the download actually is a database, and
atomically swaps it in. A corrupt or truncated download is refused and the
old catalog keeps serving. Nothing about the maintainer workspace or its
publish flow changes — this is just another install, one that re-serves.

## Running it

```bash
CARD_SOURCE_URL=https://pub-xxxx.r2.dev PORT=3400 node server.js
```

| Env | Meaning | Default |
| --- | --- | --- |
| `PORT` | listen port | `3400` |
| `DATA_DIR` | pulled catalog + this service's own state | `./data` |
| `CARD_SOURCE_URL` | base URL of the published master (the tracker calls this `cdnBase`) | — |
| `CARD_CHECK_INTERVAL_MS` | how often to look for a newer master | 6 hours |
| `CARD_REQUIRE_TOKEN` | `0` runs the surface open (local dev) | on |
| `CARD_PUBLIC_URL` | this API's public base; makes JSON image URLs absolute | — |
| `IMAGES_ENABLED` | `0` removes all artwork from the API's answers | on |
| `CARD_IMAGE_URL_TTL` | seconds a presigned image URL lives | `300` |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` / `R2_ENDPOINT` | bucket credentials for presigned URLs (same names as `publish-images.js`) | — |
| `CARD_NODE_ID` | this node's name in a cluster | hostname |
| `CARD_PEERS` | comma-separated base URLs of the other nodes | — |
| `CARD_CLUSTER_KEY` | shared secret peers sign exchanges with (required with peers) | — |
| `CARD_SYNC_INTERVAL_MS` | how often peers exchange ledgers | `5000` |

Or Docker: `docker build -t tcg-card-api . && docker run -p 3400:3400 -e CARD_SOURCE_URL=… -v carddata:/data tcg-card-api`

## Tokens

Every endpoint except `/v1/health` wants one, as `Authorization: Bearer <token>`
(or `X-API-Key:` for clients that cannot set it). Tokens are minted at the
console — there is no signup page yet, on purpose:

```bash
node scripts/tokens.js issue --name "Set Tracker (prod)" --plan app
node scripts/tokens.js issue --name "A free self-hoster" --plan selfhost
node scripts/tokens.js list
node scripts/tokens.js revoke 3        # takes effect on their next request
```

The CLI operates on the ledger at `DATA_DIR` (default `./data`) and prints
which file it opened — on a deployed box, set `DATA_DIR` to match the
service's env file or you will be confidently inspecting an empty database.
`revoke`/`show`/`restore` accept the id from `list`, the raw token value, or
a unique prefix.

Only the SHA-256 of a token is stored — the raw value is shown once, at
issue. Plans pair a **monthly allowance** (requests per calendar month, UTC)
with a **per-minute burst cap**; `unlimited` skips the allowance but keeps
the cap, because unlimited is a commercial promise, not permission to
saturate the host. The shipped numbers (`selfhost` 2 500/mo · `app`
unlimited · `starter` 10 000 · `pro` 100 000) are placeholders until pricing
is real — every token stores its resolved limits at issue time, so editing
the table later never quietly re-prices a key already handed out.

Requests are **weighted**: a card lookup costs 1, the scanner index 5, a bulk
`catalog.db` pull 100 — and the manifest costs 0, so an install can poll for
updates forever without spending. A 304 on the bulk file is also free:
"you already have it" is not a download.

The refusals explain themselves: **401** no/unknown token, **403** revoked,
**429** over the burst cap (with `Retry-After`), **402** allowance spent
(saying when it resets). Every authenticated response carries `X-Quota-*`
and `X-RateLimit-*` headers, and `GET /v1/me` tells a token everything about
itself — so a client can see the wall long before hitting it.

`CARD_REQUIRE_TOKEN=0` runs the surface open, for local development.

## The surface (v1)

All GET. CORS is open, so browser apps are first-class clients. The cost
column is what each answer subtracts from the monthly allowance.

| Endpoint | Cost | What it answers |
| --- | --- | --- |
| `/v1/health` | — | am I up, do I hold a catalog, which version (no token needed) |
| `/v1/me` | 0 | this token's plan, spend, and when the period resets |
| `/v1/catalog.json` | 0 | the master manifest: version, content hash, row counts |
| `/v1/catalog.db` | 100 | the whole database, byte-for-byte as published (ETag/304 aware, 304 is free) |
| `/v1/languages` | 0 | which languages the catalog holds |
| `/v1/sets?lang=en` | 1 | every set, with card counts |
| `/v1/sets/base1?lang=en` | 1 | one set with all its cards and printings |
| `/v1/cards/base1-4?lang=en` | 1 | one card |
| `/v1/cards?lang=en&name=char&rarity=…&type=…&set=…&page=1&perPage=100` | 1 | search |
| `/v1/scan-index?lang=en` | 5 | the offline scanner's perceptual-hash index |
| `/v1/images/<path>` | 0 | a 302 to where the image bytes actually live — see Images |

## Images

Image locations in served JSON point at this API (`/v1/images/…`; set
`CARD_PUBLIC_URL` and they become absolute). Asking for one gets a **302 to
where the bytes actually live** — never the bytes themselves, so image
traffic costs this host a header, not a body:

- With bucket credentials configured (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` — the same names `publish-images.js`
  uses, so an existing `r2.env` works verbatim), the redirect is a
  **presigned URL**, host-bound and valid for `CARD_IMAGE_URL_TTL` seconds
  (default 300). This machinery exists as the severability path — the bucket
  is public by standing policy, and the presigner waits for a day nobody
  plans.
- Without credentials, the redirect points at the public bucket — so this
  phase deploys today, before anything about the bucket changes.

**Images cost 0 against every plan, including free, forever.** That is
standing policy (PLAN.md), not pricing: the artwork is never part of anything
paid. The per-minute burst cap still applies — it protects the host, not the
ledger. A token whose monthly allowance is spent can still fetch images.

An image hosted somewhere other than the master bucket is not ours to gate;
its URL passes through untouched.

**Browser clients:** an `<img>` tag cannot carry a Bearer header. The
intended pattern is one hop server-side — your backend (which holds the
token) requests `/v1/images/…`, gets the 302, and hands the short-lived
signed URL to the browser. The bytes then flow bucket → browser directly.

**The severability switch:** `IMAGES_ENABLED=0` removes the artwork from
this API's answers entirely — the endpoint answers 404 and every image field
in the JSON becomes null, because an address is distribution too. The card
data is untouched. This exists so a takedown request can be complied with in
one config change, without harming the data product.

Note that `/v1/catalog.db` is byte-for-byte the published file, so image
locations *inside it* still point at the bucket — consumer installs that
mirror the database handle their own image serving (that is the
tracker-client phase's concern, not this endpoint's).

Deleted cards are tombstones in the database (that is how consumer installs
learn about deletions), but this API never serves a tombstone as if it were a
card: JSON endpoints show the world as it is, `catalog.db` carries the
tombstones because the pull protocol needs them.

## Running more than one of it

Set `CARD_PEERS` (and a shared `CARD_CLUSTER_KEY`) on each node and the
nodes exchange their ledgers every few seconds, POSTing to each other's
`/v1/cluster/sync` with an HMAC over the exact body. Everything a cluster
needs rides in that one exchange:

- **Tokens travel.** Mint or revoke on either node; the row replicates by
  last-write-wins on a monotonic write stamp, so a revocation cannot lose an
  argument with a fast clock. Only hashes cross the wire — raw tokens never
  exist anywhere after issue.
- **The month is one month.** Each node counts its own spend and stores the
  peers' counts as absolute per-node totals (a grow-only counter — applying
  the same exchange twice changes nothing). The wall is the sum.
- **The burst window is one ceiling**, local count plus the peers'
  last-reported minute.
- **A dead peer takes nothing with it.** The survivor serves and counts
  alone, and the ledgers reconcile on the next successful exchange.

Accuracy is stated honestly: enforcement is exact within one sync interval
(default 5s). A token can overshoot a wall by at most a few seconds of its
own request rate, once, at the boundary — the price of keeping every request
local instead of adding a cross-country round trip to each one.

[deploy/DEPLOY.md](deploy/DEPLOY.md) is the copy-paste runbook: one Vultr
box first (a complete deployment on its own, tunneled through Cloudflare),
then nodes added one at a time — each new box is a replica connector on the
same tunnel, so Cloudflare is the proxy between them with no load-balancer
product and no open inbound ports — ending in a smoke test that proves the
cluster the same way the suite does.

## What is deliberately not here yet

Payment integration (a later phase, which will be a webhook onto the same
provisioning code the CLI uses). The bucket itself stays **public,
permanently** — that is policy, not a pending migration: images are free to
anyone at their bucket URL, token or not, which keeps the artwork
verifiably outside everything paid. See [PLAN.md](PLAN.md) for the staging
and the reasoning.

## A note on what this serves

Card names, numbers, rarities and set structure are facts about a published
game. The card *artwork* is The Pokémon Company's, and this project is not
affiliated with, endorsed by, or licensed by Nintendo, The Pokémon Company,
or Game Freak. The project's standing posture — written down in PLAN.md so it
survives any one person's memory — is that **images are never part of a paid
product**: image serving is severable behind a single switch, and no plan or
price ever attaches to the artwork.

## Tests

```bash
npm test
```

Spins a mock master publishing a real SQLite catalog, boots the API against
it, and drives the paths that matter: the boot pull, tombstone handling,
search and pagination, byte-for-byte bulk serving, a version bump picked up
without a restart, a corrupt download refused, and the scanner index served
from cache with the master gone.
