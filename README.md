# bookloop

Find independent bookshops, see what's happening at them this week, and keep a shelf of what to read next. Built for New York City, Chicago and Singapore.

This is the full-stack version of the original static prototype. It runs entirely on Cloudflare's free plan: Workers, static assets, D1, and passkeys instead of a paid auth or email provider.

## What it does

- **Bookshops** — 349 real shops imported from OpenStreetMap, filtered by city, search and vibe tags, with a map and a detail panel.
- **Events** — upcoming readings, book clubs and signings, with RSVP, plus a free submission form for booksellers (every listing is reviewed before it appears).
- **Accounts** — passkey sign-in (Face ID / Touch ID / screen lock). No passwords, no email, no auth vendor.
- **Shelf and taste** — save books as want / reading / read, rate them, pick genres.
- **Friends** — request by handle, accept, see what friends are reading and which events they're going to. Shelves are friends-only or private.
- **Recommendations** — bookshops scored from the tags of shops you follow plus your genres; books from the Open Library catalogue.
- **Shop claims** — booksellers can claim a listing and send corrections, reviewed by a human.
- **Staff picks** — a claimed shop can hand-sell one book with one sentence, credited to the bookseller and reviewed before it appears. Shown on the shop and as a city strip, with one-click save to a shelf.
- **Shop pages** — every bookshop has an indexable `/shop/:id` page with a canonical URL, schema.org `BookStore` and `Event` markup, and a place in `/sitemap.xml`.

## Stack

| Piece | Choice | Cost |
| --- | --- | --- |
| Runtime | Cloudflare Workers | Free: 100k requests/day |
| Frontend | Static HTML/CSS/vanilla JS modules served by the same Worker | Free |
| Database | Cloudflare D1 (SQLite) | Free: 5 GB, 5M row reads/day, 100k row writes/day |
| Auth | WebAuthn passkeys (`@simplewebauthn/server`) | Free |
| Book metadata | Open Library search API | Free |
| Bookshop data | OpenStreetMap via Overpass | Free, ODbL |
| Maps | Leaflet + OpenStreetMap tiles | Free for light use |

## Run locally

```bash
npm install
npm run db:local                        # applies pending migrations
npm run seed:build                       # regenerates data/seed.sql from data/osm-raw.json
npm run seed:local
cp .dev.vars.example .dev.vars           # local admin token only
npm run dev
```

Open **http://localhost:8787** (if that port is taken, run `npm run dev -- --port 8791`). Use `localhost`, not `127.0.0.1`: a WebAuthn relying party ID cannot be an IP address, so passkeys will fail on `127.0.0.1`.

Passkeys need a secure context; browsers treat `localhost` as secure. To try the moderation queue:

```bash
curl -s http://localhost:8787/api/admin/queue -H 'x-admin-token: local-admin-token'
curl -s -X POST http://localhost:8787/api/admin/events/<id> \
  -H 'content-type: application/json' -H 'x-admin-token: local-admin-token' \
  -d '{"action":"approve"}'
curl -s -X POST http://localhost:8787/api/admin/staff-picks/<id> \
  -H 'content-type: application/json' -H 'x-admin-token: local-admin-token' \
  -d '{"action":"approve"}'
```

## Deploy to your own Cloudflare account

```bash
npx wrangler login
npx wrangler d1 create bookloop          # copy the database_id into wrangler.jsonc
npm run db:remote                       # applies pending migrations
npm run seed:remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

Then set `APP_ORIGIN` in `wrangler.jsonc` to the deployed origin (for example `https://bookloop.example.workers.dev`) so WebAuthn and the same-origin checks use the canonical URL. Passkeys are bound to the hostname, so changing the domain later requires users to add a new passkey.

GitHub Actions can deploy on push to `main` (`.github/workflows/deploy.yml`); add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets. The workflow does not run migrations.

## Data pipeline

### Bookshops

`data/osm-raw.json` is an Overpass export of `shop=books` inside the three city bounding boxes. `npm run seed:build` normalizes it into `data/seed.sql`:

- chains are flagged (`is_indie = 0`) using brand tags and a name list, then hidden from results;
- factual tags only: `second_hand=yes` → used books, `cafe=yes` → café, `wheelchair=yes` → step-free access;
- every row keeps its OSM URL and a `checked_at` timestamp;
- re-running the seed is an upsert, so favourites, vibes and events are never destroyed.

Add curated tags in `data/tag-overrides.json` keyed by store id if you want to correct a listing by hand:

```json
{ "osm-node-123456": ["cozy", "staff-picks"] }
```

**Licensing:** bookshop data is © OpenStreetMap contributors under ODbL 1.0. The site credits it in the footer and on each listing. If you publish a derived database, it must stay ODbL.

### Events

There is no free, national API of indie bookshop events: Eventbrite removed public event search in 2019, and the ABA/IndieCommerce calendars are per-store. The two paths that scale without paying for data are:

1. **Bookseller submissions** — `POST /api/events`, reviewed in the admin queue. This is the primary path and the partnership hook.
2. **The shop's own published calendar** — `scripts/ingest-events.mjs` reads an iCalendar feed or schema.org `Event` JSON-LD from the shop's events page and writes reviewed SQL:

```bash
node scripts/ingest-events.mjs \
  --store osm-node-123456 \
  --url https://shop.example/events \
  --out data/events.sql
npx wrangler d1 execute bookloop --remote --file=./data/events.sql
```

Check `robots.txt` and each shop's terms first, keep the source URL, and do not import calendars the shop has not published for reuse. Imported rows are marked `source = 'jsonld'` and keep their `source_url`.

### Staff picks

A staff pick is a hand-sell, not a rating: one book, one sentence, credited to the person who works there.

- Only an **approved claim holder** for that shop can submit one from the shop panel. Admins with `ADMIN_TOKEN` can submit to any shop.
- `source` records `owner` or `editor`; `bookseller`, `section`, `source_url`, `checked_at` and `reviewed_at` keep the provenance visible.
- Owner submissions land as `pending` and wait in the admin queue. Editor submissions through the admin token publish immediately, matching the event flow.
- Readers see published picks in the city strip (`GET /api/staff-picks?city=`) and inside the shop detail response.
- **Save to shelf** resolves the pick's title and author through Open Library on first use, stores the result on `staff_picks.book_id`, and falls back to a local book record if Open Library is unavailable. Repeat saves do not call the API again.

An owner can also submit from the API while signed in:

```bash
curl -s -X POST http://localhost:8787/api/stores/<storeId>/staff-picks \
  -H 'content-type: application/json' \
  -b 'bl_session=<session token>' \
  -d '{"title":"Book title","author":"Author","note":"Why I love it.","bookseller":"Sam","section":"Poetry table"}'
```

## API

All responses are JSON. Mutating routes require `Origin` to match the deployment and, unless noted, a session cookie.

```
GET    /api/config
POST   /api/auth/register/options | /verify
POST   /api/auth/login/options    | /verify
POST   /api/auth/recovery/options | /verify
POST   /api/auth/logout
GET    /api/me                     PATCH /api/me          PUT /api/me/genres
GET    /api/stores?city=&q=&tag=   GET /api/stores/:id
POST   /api/stores/:id/favorite    DELETE /api/stores/:id/favorite
POST   /api/stores/:id/vibes       DELETE /api/stores/:id/vibes
POST   /api/stores/:id/claim
GET    /api/staff-picks?city=&storeId=&limit=
POST   /api/stores/:id/staff-picks
POST   /api/staff-picks/:id/save
GET    /api/events?city=&from=&to=&storeId=
POST   /api/events                 POST /api/events/:id/rsvp   DELETE /api/events/:id/rsvp
GET    /api/books/search?q=
GET    /api/shelf                  PUT /api/shelf/:bookId      DELETE /api/shelf/:bookId
GET    /api/friends                POST /api/friends
POST   /api/friends/:handle/accept | /decline
GET    /api/users/:handle          GET /api/feed
GET    /api/recommendations
GET    /api/admin/queue            POST /api/admin/events/:id | /claims/:id | /staff-picks/:id
GET    /shop/:id                   GET /sitemap.xml | /robots.txt
```

### Shop pages and search

`GET /shop/:id` is server-rendered from `public/shop-template.html`: the Worker loads the shop, its published events and its staff picks, then replaces the meta and body tokens. The response carries a canonical URL and a schema.org `@graph` with a `BookStore` plus one `Event` per upcoming listing. `public/js/shop.js` only enhances follow, claim and save, so the page is readable and indexable without JavaScript.

`/sitemap.xml` lists the home page, the events page and every indie shop; `/robots.txt` points to it. Set `APP_ORIGIN` to the production origin so canonical URLs and the sitemap use the public hostname rather than whatever host served the request.

## Security notes

- Passkeys: challenge rows are single-use and expire in five minutes; the counter is updated on every login; recovery codes are stored as SHA-256 hashes and are one-time.
- Sessions: random 32-byte tokens, only the SHA-256 hash is stored, `HttpOnly; SameSite=Lax`, 30 days, `Secure` over HTTPS.
- CSRF: mutating routes reject a mismatched `Origin`.
- Moderation: `ADMIN_TOKEN` is a Worker secret; if unset, admin routes return 503.
- No email is collected, which keeps the app free but means account recovery depends on the saved recovery code. Adding verified email later needs a transactional email provider.

## Known limits

- OSM coverage is uneven and occasionally stale; hours and websites need shop confirmation.
- Vibe tags start empty and are community- or owner-supplied, so recommendations are thin until readers use them.
- Events are empty until bookshops post or a calendar is imported.
- Staff picks are empty until a shop claims its listing and submits one, so the city strip stays hidden until the first pick is approved.
- Shop pages are rendered per request with no edge cache yet; add a KV or Cache API layer before traffic grows.
- The map uses the public OSM tile service, which is fine for a pilot but should move to self-hosted Protomaps PMTiles on R2 before real traffic.
