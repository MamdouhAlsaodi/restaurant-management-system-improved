import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
test('legacy import validates complete backup then atomically writes before React state update', () => {
  assert.match(app, /parseLegacyBackup\(text\)/);
  assert.match(app, /restoreLegacyBackup\(data, localStorage\)/);
  assert.doesNotMatch(app, /if \(data\.menuItems\) handleUpdateMenuItems/);
});
