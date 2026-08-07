# Two coasts, one API — the Vultr runbook

Two nodes, one in the eastern US and one in the western, exchanging ledgers
so a token's limits are one wall rather than one per server, fronted by a
single hostname through Cloudflare. Every step below is copy-paste; the only
editing is names and secrets.

The smallest Vultr plan is plenty — this service is one Node process serving
a SQLite file, and the image bytes never pass through it.

## 0. What you will end up with

```
                 api.yourdomain.com
                        │
                   Cloudflare
                  (one tunnel, two replicas)
                 ┌──────┴──────┐
              [east]         [west]        ← Vultr, e.g. New Jersey + Los Angeles
                 └──── sync ────┘          ← signed ledger exchange, every 5s
```

Clients hit one hostname. Cloudflare picks a live connector — and when one
box is down, the other simply has both. The nodes exchange tokens, monthly
spend and burst windows every five seconds, so the rate limiting is
cluster-wide (accurate to within one exchange, which is the honest trade for
keeping every request local-speed).

## 1. Provision

Two instances on [Vultr](https://my.vultr.com):

- **east**: e.g. New Jersey · **west**: e.g. Los Angeles or Seattle
- Ubuntu 24.04 LTS, smallest shared-CPU plan, IPv4
- Add your SSH key at creation

Note both public IPs; below they are `EAST_IP` and `WEST_IP`.

## 2. On BOTH boxes — base install

```bash
# Node 22 (Ubuntu 24.04 ships an older one)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git

# a user that owns nothing but the service
useradd --system --home /var/lib/card-api --create-home --shell /usr/sbin/nologin cardapi

# the code
git clone https://github.com/SpyderHunter03/Pkmn-Card-Api /opt/card-api
# (private repo? use a fine-grained read-only token in the URL, or push a deploy key first)

# prove it on this box before wiring anything
cd /opt/card-api && npm test
```

## 3. The cluster key — once, then copy

On **one** box:

```bash
openssl rand -hex 32
```

That value is the cluster key. It is root-equivalent for the token ledger —
whoever holds it can inject or revoke tokens — so it goes in the env file
below with mode 0600 and nowhere else.

## 4. On BOTH boxes — the env file

```bash
mkdir -p /etc/card-api && touch /etc/card-api/env && chmod 600 /etc/card-api/env
```

`/etc/card-api/env` on **east** (swap the two IPs and `east`/`west` on the
other box):

```ini
PORT=3400
DATA_DIR=/var/lib/card-api
CARD_SOURCE_URL=https://pub-828f8f41b9f543f88ccae1f6ff84c2c5.r2.dev
CARD_NODE_ID=east
CARD_PEERS=http://WEST_IP:3400
CARD_CLUSTER_KEY=<the value from step 3, identical on both>
# the bucket is public by standing policy; if it ever must go private
# (severability), add the R2_* credentials here — same names as
# publish-images.js
```

## 5. On BOTH boxes — firewall, service, tunnel

```bash
# nothing in but SSH and the peer; clients arrive through the tunnel
ufw default deny incoming
ufw allow OpenSSH
ufw allow from EAST_IP to any port 3400 proto tcp    # on west; use WEST_IP on east
ufw --force enable

# the service
cp /opt/card-api/deploy/card-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now card-api
journalctl -u card-api -n 20      # expect the boot pull and "Clustered as …"
```

Then the tunnel — **one** tunnel, run on **both** boxes, which is what makes
Cloudflare the proxy between them:

1. Cloudflare Zero Trust → Networks → Tunnels → Create tunnel (say
   `card-api`). Public hostname: `api.yourdomain.com` → service
   `http://localhost:3400`.
2. Copy the connector install command it shows you and run **the same
   command on both boxes**. Two connectors on one tunnel are *replicas*:
   Cloudflare spreads traffic across them and routes around a dead one on
   its own. No load-balancer product, no open inbound ports.

## 6. Prove the cluster (this mirrors the test suite)

```bash
# on east — mint a small key for the exercise
cd /opt/card-api && DATA_DIR=/var/lib/card-api node scripts/tokens.js issue --name "smoke" --monthly 10 --burst 100
T=ptcg_live_...   # the value it printed

# each node knows itself and sees its peer
curl -s http://localhost:3400/v1/health | grep -o '"node":"[a-z]*"'
curl -s http://localhost:3400/v1/health | grep -o '"cluster":.*'

# spend 6 in the east…
for i in 1 2 3 4 5 6; do curl -s -H "Authorization: Bearer $T" http://localhost:3400/v1/cards/base1-4?lang=en > /dev/null; done

# …and read the ledger FROM THE WEST (give it a sync interval, ~5s)
ssh WEST_IP 'curl -s -H "Authorization: Bearer '$T'" http://localhost:3400/v1/me'
#   → "used": 6      ← the east's spend, seen from the west

# spend 4 more in the west, then anywhere:
#   → 402, one wall for the whole cluster

# and through the front door
curl -s -H "Authorization: Bearer $T" https://api.yourdomain.com/v1/health
```

Revocation is the same everywhere: `tokens.js revoke <id>` on either box is
enforced by both within a sync interval. Mint on whichever box is closer;
keys replicate.

## 7. Updating

One node at a time, and the other keeps answering — that is the point of
having two:

```bash
cd /opt/card-api && git pull && npm test && systemctl restart card-api
# check /v1/health, then repeat on the other box
```

## Accuracy, stated honestly

Counting is per-node and exchanged every `CARD_SYNC_INTERVAL_MS` (5s
default). A token hammering both coasts at once can therefore overshoot a
wall by at most a few seconds of its own request rate, once, at the boundary
— and the ledger reconciles at the next exchange. Strict global counting
would cost a cross-country round trip on every request; this costs nothing
and is what the big API providers do too. Clocks matter only for token
last-write-wins, and the write stamp is monotonic per row, so a revocation
beats a fast clock regardless — but leave NTP on (Vultr's default) anyway.
