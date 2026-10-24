import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../components/qr/GuestPage.tsx', import.meta.url), 'utf8');

// ---- Guest name input: required, not login, frozen during ambiguous retry ----

test('GuestPage renders a required guest name input disabled while frozen', () => {
  assert.ok(/id="guest-name"/.test(src), 'must render guest name input');
  assert.ok(/disabled=\{frozen \|\| submitting\}/.test(src), 'name input must be non-editable while frozen');
  assert.ok(/الاسم مطلوب/.test(src), 'must surface required-name error');
  assert.ok(/maxLength=\{80\}/.test(src), 'name input must cap at 80 chars');
});

test('GuestPage permits retrying a frozen ambiguous submission without editing its snapshot', () => {
  assert.ok(/if \(submitting \|\| \(!frozen && cartLines\.length === 0\) \|\| submittedOrder\) return;/.test(src), 'frozen must not block retry handler');
  assert.ok(/disabled=\{submitting \|\| \(!frozen && cartLines\.length === 0\) \|\| nameInvalid\}/.test(src), 'frozen must not disable retry button');
  assert.ok(/const attempt: PendingGuestAttempt = pendingAttempt \?\?/.test(src), 'a reload must replay the saved snapshot');
});

test('GuestPage passes guestName into submitGuestOrder', () => {
  assert.ok(/guestName: trimmedName/.test(src), 'submission must include guestName');
});

test('GuestPage offers a fresh distinct order after success', () => {
  assert.ok(/startNewOrder/.test(src), 'must offer starting another order');
  assert.ok(/setRequestId\(null\)/.test(src), 'new order must get a fresh requestId');
});
