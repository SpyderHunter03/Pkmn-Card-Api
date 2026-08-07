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

Deleted cards are tombstones in the database (that is how consumer installs
learn about deletions), but this API never serves a tombstone as if it were a
card: JSON endpoints show the world as it is, `catalog.db` carries the
tombstones because the pull protocol needs them.

## What is deliberately not here yet

Image URLs served through the API (Phase 3 — signed bucket redirects, free on
every plan by standing policy) and any payment integration (Phase 5, which
will be a webhook onto the same provisioning code the CLI uses). See
[PLAN.md](PLAN.md) for the staging and the reasoning.

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
