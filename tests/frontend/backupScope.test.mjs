import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const modal = readFileSync(new URL('../../components/modals/SettingsModal.tsx', import.meta.url), 'utf8');
test('settings backup UI distinguishes browser legacy data from SQLite server data', () => {
  assert.match(modal, /localStorage/);
  assert.match(modal, /SQLite/);
});
