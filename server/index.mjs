#!/usr/bin/env node
// Entry point: `node server/index.mjs`
// Requires Node >= 24 (built-in node:sqlite).
import { createApp } from './app.mjs';
import { resolve } from 'node:path';

const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  console.error(
    'Refusing to start: set the ADMIN_PASSWORD environment variable to a strong secret.\n' +
      'See README-QR.md for the masked-prompt setup.'
  );
  process.exit(1);
}

const host = process.env.HOST ?? '127.0.0.1'; // HOST=0.0.0.0 is opt-in
const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? 'data/restaurant.sqlite';
const staticDir = process.env.STATIC_DIR ?? 'dist';

const secureCookies = process.env.SECURE_COOKIES === '1';
const app = createApp({ adminPassword, dbPath: resolve(dbPath), host, port, staticDir, secureCookies });
const address = await app.listen();
console.log(`Listening on http://${address.address}:${address.port} (db: ${dbPath})`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
