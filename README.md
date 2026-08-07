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

Or Docker: `docker build -t tcg-card-api . && docker run -p 3400:3400 -e CARD_SOURCE_URL=… -v carddata:/data tcg-card-api`

## The surface (v1)

All GET. CORS is open, so browser apps are first-class clients.

| Endpoint | What it answers |
| --- | --- |
| `/v1/health` | am I up, do I hold a catalog, which version |
| `/v1/catalog.json` | the master manifest: version, content hash, row counts |
| `/v1/catalog.db` | the whole database, byte-for-byte as published (ETag/304 aware) — for consumer installs that mirror rather than query |
| `/v1/languages` | which languages the catalog holds |
| `/v1/sets?lang=en` | every set, with card counts |
| `/v1/sets/base1?lang=en` | one set with all its cards and printings |
| `/v1/cards/base1-4?lang=en` | one card |
| `/v1/cards?lang=en&name=char&rarity=…&type=…&set=…&page=1&perPage=100` | search |
| `/v1/scan-index?lang=en` | the offline scanner's perceptual-hash index |

Deleted cards are tombstones in the database (that is how consumer installs
learn about deletions), but this API never serves a tombstone as if it were a
card: JSON endpoints show the world as it is, `catalog.db` carries the
tombstones because the pull protocol needs them.

## What is deliberately not here yet

Tokens, plans and quotas (Phase 2), and metered image URLs (Phase 3) — see
[PLAN.md](PLAN.md) for the full staging and the reasoning. Phase 1 is
unauthenticated on purpose: the data path gets proved on its own before the
gate goes in front of it.

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
