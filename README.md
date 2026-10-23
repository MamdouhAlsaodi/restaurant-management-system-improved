# Restaurant Management System — Improved React Edition

React/Vite restaurant POS with Arabic (RTL), English, and Portuguese UI. Existing menu, checkout, sales, and settings stay in the admin browser's `localStorage`; they are **not automatically shared or migrated**. The new table-QR flow uses a self-hosted Node/SQLite backend and an explicitly published menu snapshot.

## Local setup

Requires Node.js **24+** for `node:sqlite`.

```sh
npm ci
npm run build
read -rs -p 'Admin password: ' ADMIN_PASSWORD; printf '\n'; export ADMIN_PASSWORD
node server/index.mjs
```

Visit `http://127.0.0.1:8787/` for admin login. Open the **طلبات QR** tab to publish the current menu, create a table, and copy/print its QR link. A guest scans the code, chooses items, and submits an order that appears as **pending** in that tab. A staff member may accept or reject it. **Neither submission nor acceptance records a paid sale or changes the existing local checkout history.**

This is a local development workflow; `npm run dev` alone serves only the frontend and cannot serve the QR API. The QR guest page currently lists items without product images. For API details, configuration, backup and security limitations, read [README-QR.md](README-QR.md).

## Checks

```sh
npx --no-install tsc --noEmit
npm run build
node --test tests/frontend/*.test.mjs tests/server/*.test.mjs
```

## Stack

React 19, TypeScript, Vite, locally built Tailwind CSS, Node HTTP/SQLite, and local QR rendering. No third-party cloud service is required. A public mobile URL needs a deliberately configured, HTTPS-protected deployment; a QR pointing to `127.0.0.1` will **not** work from a customer's phone.
