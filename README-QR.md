# Restaurant table QR backend (self-hosted)

A bounded, self-hosted backend for the restaurant table QR ordering flow: table
tokens, an admin-authenticated API, and guest ordering against a published menu
snapshot. No third-party cloud services; everything runs locally on Node.

**This is not production-ready software.** See "Limitations" below.

## Requirements

- Node.js **>= 24** (uses the built-in `node:sqlite`, `node:http`, and `node:crypto` modules; no npm dependencies on the server side).
- The frontend app in this repository built to `dist/` (`npm run build`) if you want static pages served.

## Running

```sh
# Build the frontend, then run the API with a password entered without shell-history exposure.
npm ci && npm run build
read -rs -p 'Admin password: ' ADMIN_PASSWORD; printf '\n'; export ADMIN_PASSWORD
node server/index.mjs
```

Environment variables:

| Variable         | Default                  | Meaning                                                        |
| ---------------- | ------------------------ | -------------------------------------------------------------- |
| `ADMIN_PASSWORD` | *(none — startup fails closed if absent)* | Admin login secret.                          |
| `HOST`           | `127.0.0.1`              | Bind address. `HOST=0.0.0.0` to listen on all interfaces (opt-in). |
| `PORT`           | `8787`                   | Listen port.                                                   |
| `DB_PATH`        | `data/restaurant.sqlite` | SQLite database file (directory is created automatically).     |
| `STATIC_DIR`     | `dist`                   | Directory with the built frontend (`index.html`, `assets/`).   |
| `SECURE_COOKIES` | *(off for localhost)*    | Set `1` **only behind HTTPS** to mark login/logout cookies `Secure`. |

## What is served

- `/q/:token` — public guest page (SPA route; served `index.html`, page loads data via API with the table token).
- `/login` — public login page (SPA route).
- `/` — admin page (SPA); actual admin data is only available through the session-authenticated API.
- `/assets/*` — built frontend bundle (immutable cache headers).
- Static serving resolves paths inside the static root only; encoded traversal is rejected.

## API surface

Admin (session cookie; login via `POST /api/admin/login {password}` sets an
HttpOnly, SameSite=Strict cookie; `GET /api/admin/session` reports auth state;
`POST /api/admin/logout` clears it):

- `GET/POST /api/admin/tables`, `DELETE /api/admin/tables/:id` (revokes the token, including guest access)
- `GET/PUT /api/admin/menu` — `PUT {items:[{id,name,price,image?,category?,description?}]}` **explicitly publishes a menu snapshot**; `price` is an integer amount in cents
- `GET /api/admin/orders` (newest first), `POST /api/admin/orders/:id/accept`, `POST /api/admin/orders/:id/reject` (`pending → accepted|rejected` only; otherwise `409`)

Guest (no session; token-scoped only):

- `GET /api/guest/:token/menu`
- `POST /api/guest/:token/orders {items:[{id,quantity}],notes?,requestId}` → `201` (or `200` with the same order on idempotent retry with the same `requestId`, which must be a UUID). Item names/prices and the total (integer cents) are always computed server-side from the published snapshot.

All state-mutating endpoints require `Content-Type: application/json` and a
same-origin `Origin` header (no CORS). Login failures get a fixed delay and are
rate limited; passwords are never logged. Errors never include stack traces or
internal paths.

## Money

All prices and totals are handled as **integer cents** internally and in the
API. There is no floating-point money anywhere in the backend.

## Menu publishing and migration

The menu is a **snapshot published explicitly** via `PUT /api/admin/menu`
(the frontend persists a draft in `localStorage`; nothing is published
automatically). There is **no automatic migration of any existing sales or menu
data** — existing data is not imported. The guest MVP lists names/prices/text;
local POS images (often large data URLs) are not included in the snapshot.

## HTTPS / public deployment

For anything beyond localhost you need a reverse proxy (nginx, Caddy, etc.)
that terminates TLS and forwards to `127.0.0.1:8787` **while preserving
the public `Host` header** (`Origin` must match `Host`); set `SECURE_COOKIES=1`
for that deployment. Do not expose the HTTP port itself or send admin
credentials over plain HTTP. **Do not serve this with
static hosting alone** — the backend (API + SQLite) is an integral server
process; static hosts cannot run it.

## Backups

All **QR table/menu/order** state lives in the SQLite file (plus `-wal`/`-shm` WAL
sidecars). Pre-existing POS data and checkout/sales remain in the same admin
browser's `localStorage`; another browser/device will not inherit them. To back
up: stop the server (or use `sqlite3 db '.backup ...'` / copy all three files
together). Restore by placing the file(s) and restarting. Sessions are
in-memory, so admins must log in again after a restart; tables, menu, and
orders persist.

## Limitations (read before trusting this)

- **Not production ready.** Single process, in-memory rate limiting and
  sessions (per-process), no clustering, no request queuing.
- No CSRF tokens beyond SameSite=Strict cookies and Origin checking; no audit
  log; no backup automation.
- Login rate limiting is per source IP in memory and resets on restart.
- The admin UI is gated by the API, not by the static files — anyone can load
  the SPA shell, but admin data requires a valid session.
