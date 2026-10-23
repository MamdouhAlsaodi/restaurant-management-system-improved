import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const gate = readFileSync(new URL('../../components/qr/AdminGate.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../../components/qr/StaffPanel.tsx', import.meta.url), 'utf8');
const index = readFileSync(new URL('../../index.tsx', import.meta.url), 'utf8');

test('login gate supports optional username for staff while keeping password-only owner login', () => {
  assert.ok(/username\.trim\(\)\s*\?\s*\{\s*username/.test(gate), 'username is sent only when entered');
  assert.ok(/\{\s*password\s*\}/.test(gate), 'owner password-only body is preserved');
  assert.match(gate, /SessionActor/, 'gate passes the session actor to the app');
});

test('staff management and audit panel is owner-only and wired to server endpoints', () => {
  assert.match(panel, /\/api\/admin\/staff/);
  assert.match(panel, /\/api\/admin\/audit\?limit=50/);
  assert.match(panel, /deactivate/);
  assert.match(panel, /actor\.kind !== 'owner'/, 'panel refuses to render for non-owner actors');
  assert.ok(!/localStorage/.test(panel), 'staff passwords/state never touch localStorage');
});

test('App mounts the staff view only for the owner actor', () => {
  assert.match(app, /isOwner && \(/, 'staff nav tab is owner-only');
  assert.match(app, /\{view === 'staff' && isOwner && <StaffPanel actor=\{actor\} \/>\}/);
});

test('index routes owner to legacy App and staff to a server-only workspace', () => {
  assert.match(index, /actor\.kind === 'owner' \? <App actor=\{actor\} \/> : <StaffWorkspace actor=\{actor\} \/>/);
  const workspace = readFileSync(new URL('../../components/qr/StaffWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /<OrderInbox/);
  assert.match(workspace, /<KitchenPanel/);
  assert.doesNotMatch(workspace, /localStorage|restaurant-orders|restaurant-daily-sales/, 'staff never mounts browser-local sales');
});
