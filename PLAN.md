# The plan: one card API, many applications, nothing sold that isn't ours

Decisions already made are marked **settled**. The open questions at the end
need answers before the phases that depend on them.

## Why this exists

Two immediate clients — the Pokémon Set Tracker and a second application in
the family — and a wish to monetize *something* eventually, with one hard
constraint ranked above the rest: **no legal exposure to The Pokémon Company
worth having.**

That constraint shapes the whole design, so it goes first.

## The legal posture (settled)

Not legal advice; the one-line version of the real thing is "an hour with an
IP lawyer and an LLC before anyone pays a cent."

- **Facts are the product.** Names, numbers, rarities, HP, set structure —
  facts aren't copyrightable. A metadata API is the defensible thing to
  operate and, if it ever comes to it, the defensible thing to charge for.
- **Artwork is never for sale.** Card images are The Pokémon Company's
  copyrighted art. Free fan databases that serve them have been tolerated for
  years; tolerance is precisely what evaporates when money attaches. So:
  image endpoints cost **0** against every plan including free, they are
  burst-capped only to protect the host, they never appear on any pricing
  page, and the whole image path sits behind one `IMAGES_ENABLED` switch so a
  cease-and-desist can be complied with in a minute without touching the
  data product. Severability is the engineering translation of "don't get
  sued."
- **Trademark hygiene.** The service can *describe* Pokémon cards; it is not
  *named* as a Pokémon product, and their logos are never its branding. The
  non-affiliation disclaimer ships in the README and in `/v1/health`-adjacent
  docs forever.
- **What money attaches to, if it ever does:** the applications (hosted
  tracker accounts, premium app features) first, the metadata service at
  most. Never the bucket of scans.

Splitting the API out adds no exposure the tracker didn't already carry — it
redistributes the same images today. The split adds *control*: a private
bucket, revocable per-app tokens, and visibility into who pulls what.

## Architecture (settled)

```
maintainer workspace ──publish──▶ R2 (catalog.db, catalog.json, images)
                                     │ pulls on boot + on version change
                                     ▼
                                TCG Card API
                                     │ tokens (Phase 2)
              ┌──────────────────────┼──────────────────────┐
        Set Tracker            the second app          anyone else, later
```

- Its own repository, its own release cadence. An API consumed by several
  applications is not a mode of one of them.
- A consumer of the published master, serving straight off the pulled
  `catalog.db`. The maintainer workspace does not change at all.
- The bucket goes private only at the end of Phase 4, when nothing anonymous
  still needs it.

## Tokens and quotas (Phase 2, design settled)

- `ptcg_live_<40 hex>`; only the SHA-256 is stored, the raw value is shown
  once at issue. The prefix makes a leaked token greppable and junk cheap to
  reject.
- Plans: monthly request allowance + per-minute burst cap. `NULL` allowance
  is unlimited — and the burst cap still applies, because unlimited is a
  commercial promise, not permission to saturate the host.
- Per-endpoint cost, so a bulk `catalog.db` pull (100) and a card lookup (1)
  don't cost the same. The manifest costs 0 so installs can poll it freely.
  **Images cost 0. Always. See the legal posture.**
- Errors that explain themselves: 401 no token, 403 revoked, 429 burst (with
  `Retry-After`), 402 allowance spent. `X-Quota-*` headers on everything so a
  client sees the wall before hitting it.
- A CLI to issue, list and revoke. Billing, if it ever exists, is a webhook
  that calls the same provisioning code — nothing to rework.

**Settled:** a free self-host tier exists, sized for one tracker install's
boot pull plus updates. The tracker's out-of-the-box install story survives.

## Phases

1. **The service, no auth** — ✅ done. The read surface, the pull loop,
   corrupt-download refusal, 27 checks green.
2. **Tokens, plans, quotas** — the gate goes in front; a CLI mints tokens for
   the two family apps and the free tier.
3. **Images** — metered-at-zero image endpoint answering with short-lived
   signed bucket URLs (bytes go Cloudflare → client, never through this
   host); card JSON rewritten to point at the API; `IMAGES_ENABLED` switch.
4. **The tracker becomes a client** — token in setup + admin, catalog pull
   and images rerouted, honest failure messages for missing/revoked/spent.
   Only after this ships everywhere does the bucket go private.
5. **Billing** — later, deliberately. Attaches to data plans and apps only.

## Open

1. **A lapsed token and an install that already has its cards** — keep
   working with stale data, or stop? "Keeps working, stops updating" is
   kinder and harder to police; leaning that way, not settled.
2. **Plan shapes** — starter/pro/unlimited numbers. Needed before Phase 2's
   defaults are more than placeholders, not before its machinery.
