# One node first, then as many as you want — the Vultr runbook

The runbook is in two halves on purpose. Part I stands entirely on its own:
one box, publicly reachable through Cloudflare, tokens working — a complete
deployment you can stop at. Part II turns that box into a cluster by adding
nodes, one at a time, without ever taking the first one down. Every step is
copy-paste; the only editing is names and secrets.

The smallest 1GB plan is plenty — this service is one Node process serving a
small SQLite file, and image bytes never pass through it.

```
PART I — one node                PART II — add nodes, one at a time

  api.yourdomain.com               api.yourdomain.com
         │                                │
    Cloudflare                       Cloudflare
    (one tunnel,                    (same tunnel,
     one connector)                  connector per node)
         │                        ┌───────┼────────┐
      [east]                   [east]  [west]   [more…]
                                  └──sync──┴──sync──┘
                                  signed ledger exchange, every 5s
```

---

# Part I — the first node

## 1. Provision

One instance on [Vultr](https://my.vultr.com):

- Ubuntu 24.04 LTS **or newer**, smallest shared-CPU plan with **1GB RAM and
  IPv4**, SSH key added at creation
- Skip every add-on. Auto-backups (+20%) buy nothing here: the catalog
  re-pulls itself from the bucket, and once a second node exists the token
  ledger replicates too. DDoS protection is Cloudflare's job.
- Know the billing rule: a **stopped** instance still bills at full price —
  only destroying it stops the meter. These boxes rebuild from this runbook
  in minutes, so "destroy and re-provision" is the pause button.

Note the public IP; it is `NODE_IP` below.

## 2. Base install

```bash
# Node 22+ — try NodeSource first
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs git
# if NodeSource has no channel for a brand-new Ubuntu release yet, the
# distro's own package is usually recent enough:
#   apt-get install -y nodejs npm git
node --version     # the only thing that matters: >= 22.5 (node:sqlite)

# a user that owns nothing but the service
useradd --system --home /var/lib/card-api --create-home --shell /usr/sbin/nologin cardapi

# the code
git clone https://github.com/SpyderHunter03/Pkmn-Card-Api /opt/card-api
# (private repo? use a fine-grained read-only token in the URL, or a deploy key)

# prove it on this box before wiring anything (needs the 1GB plan — the
# suite spawns several node processes; on 512MB, skip this or add swap)
cd /opt/card-api && npm test
```

## 3. The env file

```bash
mkdir -p /etc/card-api && touch /etc/card-api/env && chmod 600 /etc/card-api/env
```

`/etc/card-api/env` — note there is **nothing about clustering here yet**;
those lines arrive in Part II:

```ini
PORT=3400
DATA_DIR=/var/lib/card-api
CARD_SOURCE_URL=https://pub-828f8f41b9f543f88ccae1f6ff84c2c5.r2.dev
CARD_NODE_ID=east
# the bucket is public by standing policy; if it ever must go private
# (severability), add the R2_* credentials here — same names as
# publish-images.js
```

`CARD_NODE_ID` matters even solo: it names this node in `/v1/health`, and it
is already correct the day a peer appears.

## 4. Firewall and service

```bash
# nothing in but SSH; clients arrive through the tunnel
ufw default deny incoming
ufw allow OpenSSH
ufw --force enable

cp /opt/card-api/deploy/card-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now card-api
journalctl -u card-api -n 20     # expect the boot pull of the catalog
```

## 5. The tunnel

1. Cloudflare Zero Trust → Networks → Tunnels → **Create tunnel** (call it
   `card-api`). Public hostname: `api.yourdomain.com` → service
   `http://localhost:3400`.
2. It shows a connector install command — pick **Debian, 64-bit** (Ubuntu is
   Debian-family) and run it on the box.

Keep that connector command somewhere: **every future node runs the exact
same command.** That is what makes additional nodes replicas of one tunnel
instead of new tunnels.

## 6. Prove it

```bash
# alive, named, holding cards
curl -s http://localhost:3400/v1/health
#   → "ok":true, "node":"east", "service":"0.4.3", "catalog":true, "version":…

# mint a key — always DATA_DIR (the CLI says which ledger file it opened;
# believe it), always as the service user (root-owned SQLite sidecar files
# break the service's next write)
cd /opt/card-api
sudo -u cardapi DATA_DIR=/var/lib/card-api node scripts/tokens.js issue --name "smoke" --monthly 10 --burst 100
T=ptcg_live_...    # the value it printed

curl -s -H "Authorization: Bearer $T" http://localhost:3400/v1/me
curl -s -H "Authorization: Bearer $T" "http://localhost:3400/v1/sets?lang=en"

# and through the front door
curl -s https://api.yourdomain.com/v1/health

# done exercising? the CLI takes the token value itself
sudo -u cardapi DATA_DIR=/var/lib/card-api node scripts/tokens.js revoke $T
```

(Testing from Windows? PowerShell aliases `curl` to something else entirely
— call `curl.exe` explicitly.)

**Part I complete.** This is a full deployment: public hostname, tokens,
quotas, images by redirect. Everything below is optional until you want a
second location. One honest note for the solo stage: with no peer, the token
ledger (`/var/lib/card-api/api.db`) is the only state that cannot rebuild
itself — copy it somewhere after minting real keys, or be ready to re-mint.
The moment Part II happens, the peers replicate it and that concern retires.

---

# Part II — adding a node

Repeatable: the third node and the tenth follow the same steps as the
second. Nothing in Part II takes the existing nodes down.

## 7. Provision + install

Provision the new box in its region (e.g. Los Angeles or Seattle for a
`west`), then run **steps 2–4 exactly**, with two differences in the env
file: its own `CARD_NODE_ID` (say `west`), and hold off on starting the
service — clustering config comes first.

If push-deploy is set up (Part III), two extra lines belong here: append
the deploy public key to this box's `/root/.ssh/authorized_keys`, and add
`west=NEW_IP` to the `DEPLOY_HOSTS` secret once the node is proven.

## 8. The cluster key — once, ever

The first time you add a node (and never again), on either box:

```bash
openssl rand -hex 32
```

That value is the cluster key. It is **root-equivalent for the token
ledger** — whoever holds it can inject or revoke tokens on every node — so
it lives in the 0600 env files and nowhere else.

## 9. Cluster lines in EVERY node's env file

On **each** node (old and new), append — `CARD_PEERS` is every *other*
node's IP, comma-separated:

```ini
# on east:
CARD_PEERS=http://WEST_IP:3400
CARD_CLUSTER_KEY=<the value from step 8, identical everywhere>

# on west:
CARD_PEERS=http://EAST_IP:3400
CARD_CLUSTER_KEY=<same>

# a third node later? every node lists the other two:
#   CARD_PEERS=http://EAST_IP:3400,http://WEST_IP:3400
```

## 10. Firewall holes for the peers

On **each** node, one rule per peer:

```bash
ufw allow from PEER_IP to any port 3400 proto tcp
```

The exchange is HMAC-signed either way; the firewall rule just keeps
strangers from knocking at all.

## 11. The tunnel replica

On the **new** box, run the *same* connector install command from step 5.
Two connectors on one tunnel are replicas: Cloudflare spreads traffic across
them and routes around a dead one on its own. No load-balancer product, no
DNS changes, nothing to configure — the hostname already points at the
tunnel, and the tunnel now has two homes.

## 12. Restart everything, prove the cluster

```bash
# on every node
systemctl restart card-api
journalctl -u card-api -n 5      # expect: Clustered as "east" with 1 peer…

curl -s http://localhost:3400/v1/health
#   → "cluster":[{"url":"http://…:3400","ok":true,…}]
```

Then the checks that matter — this mirrors the test suite:

```bash
# on east: mint, spend 6
cd /opt/card-api
sudo -u cardapi DATA_DIR=/var/lib/card-api node scripts/tokens.js issue --name "cluster smoke" --monthly 10 --burst 100
T=ptcg_live_...
for i in 1 2 3 4 5 6; do curl -s -H "Authorization: Bearer $T" "http://localhost:3400/v1/cards/base1-4?lang=en" > /dev/null; done

# on west (give it one sync interval, ~5s): the key was minted east and the
# spend happened east, but the west knows both
curl -s -H "Authorization: Bearer $T" http://localhost:3400/v1/me
#   → "node":"west", "used":6

# spend 4 in the west, then anywhere:
curl -s -H "Authorization: Bearer $T" "http://localhost:3400/v1/cards/base1-7?lang=en"   # ×4
#   → the 11th request, either coast: 402. One wall, not one per server.

# and revocation crosses too — run it on the WEST, against a key minted east
sudo -u cardapi DATA_DIR=/var/lib/card-api node scripts/tokens.js revoke $T
#   → 403 from the east as well, within a sync interval
```

---

# Part III — day two

## Updating: push to main, and the fleet follows

`.github/workflows/deploy.yml` ships in the repo and does the whole update
dance on every push to main: the test suite runs on GitHub's runner first
(no box is touched if it is red), then each node is updated **one at a
time**, in order. A node only counts as done when its `/v1/health` reports
exactly the new version — "the process restarted" is not "the new code is
serving". If a node fails that check, `deploy/deploy-node.sh` rolls it back
to the commit it was on and the rollout halts, so a failed deploy leaves
every node on one version — the old one — never a mix. A second push during
a rollout queues behind it instead of interleaving.

Token counts are never at risk from a deploy or a rollback: the ledger
lives in `/var/lib/card-api`, outside the repo, and the deploy only ever
touches `/opt/card-api`.

Two one-time setup steps make it live (until then the workflow runs, says
there is nothing to deploy to, and exits green):

**1. A deploy key.** On your own machine, generate a keypair used for
nothing else:

```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C "card-api-deploy"
```

Put the **public** half on **every** node (and on every future node — make
it part of step 7):

```bash
cat deploy_key.pub >> /root/.ssh/authorized_keys
```

**2. Two repository secrets.** GitHub → the repo → Settings → Secrets and
variables → Actions → New repository secret:

- `DEPLOY_SSH_KEY` — the entire contents of the **private** file
  `deploy_key`, including the BEGIN/END lines. Then delete the local copy;
  GitHub holds it now.
- `DEPLOY_HOSTS` — space-separated `name=ip` entries, e.g.
  `east=203.0.113.10 west=198.51.100.20`. **The order here is the rollout
  order.** Adding a node to the cluster (Part II) ends with adding it here.

Watch any rollout under the repo's **Actions** tab; the manual trigger
("Run workflow") redeploys the current main without a push.

Manual fallback, should GitHub ever be the thing that is down:

```bash
cd /opt/card-api && git pull && npm test && systemctl restart card-api
# check /v1/health reports the new "service" version, then the next node
```

**Tokens** — mint, list, revoke on whichever node is closest; keys and
revocations replicate. Always through `sudo -u cardapi DATA_DIR=…`, and the
CLI prints which ledger file it opened — if `list` ever claims there are no
tokens, read that line before doubting your memory.

**Accuracy, stated honestly** — counting is per-node and exchanged every
`CARD_SYNC_INTERVAL_MS` (5s default). A token hammering several nodes at
once can overshoot a wall by at most a few seconds of its own request rate,
once, at the boundary — and the ledgers reconcile at the next exchange.
Strict global counting would cost a cross-region round trip on every
request; this costs nothing, and it is what the big API providers do too.
Clocks matter only for token last-write-wins, and the write stamp is
monotonic per row, so a revocation beats a fast clock regardless — but leave
NTP on (Vultr's default) anyway.
