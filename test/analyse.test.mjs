import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as core from '../vendor/afterlife-core.mjs';
import { fakeForge } from '../lib/fake-forge.mjs';
import { createBackend } from '../src/plan.mjs';
import { analyse } from '../ui/analyse.js';
import { makeAsk } from '../ui/ask.js';

const samples = new URL('../static/admin/samples/', import.meta.url);
const NAMES = ['01-leave-request', '02-expense-report', '04-purchase-request', '05-new-hire-onboarding', '12-vendor-onboarding', '16-equipment-loan'];
const fileOf = (name, as = `${name}.xsn`) => ({ name: as, file: new File([readFileSync(new URL(`${name}.xsn`, samples))], as) });
const six = () => NAMES.map((n) => fileOf(n));
const noWait = async () => {};
const soon = (ms = 5) => new Promise((done) => setTimeout(done, ms));

/** A backend over an in-memory Jira, reached the way the page reaches the real one. */
function site(options, between = async () => undefined) {
  const forge = fakeForge(options);
  const backend = createBackend({ ...forge, wait: noWait });
  const calls = [];
  const invoke = async (name, payload) => {
    calls.push(name);
    const other = await between(name, payload, calls.length);
    return other ?? backend.resolvers[name]({ payload, context: { accountId: 'admin-1' } });
  };
  const ask = makeAsk(invoke, noWait);
  return { ...forge, ask, calls };
}

test('every template is analysed and saved, and progress runs from nothing to all', async () => {
  const s = site();
  const progress = [];
  const report = await analyse(six(), { core, ask: s.ask, sample: true, onProgress: (done, total) => progress.push([done, total]) });
  assert.deepEqual([report.saved, report.templates, report.errors.length], [6, 6, 0]);
  assert.deepEqual([...report.ids].sort(), ['equipment-loan', 'expense-report', 'leave-request', 'new-hire-onboarding', 'purchase-request', 'vendor-onboarding']);
  assert.deepEqual(progress[0], [0, 6]);
  assert.deepEqual(progress.at(-1), [6, 6]);
  assert.deepEqual(progress.map((p) => p[0]), [0, 1, 2, 3, 4, 5, 6]);
  const { forms } = await s.ask('listForms');
  assert.equal(forms.length, 6);
  assert.ok(forms.every((f) => f.sample === true));
});

test('permission checks that Jira fails for a moment cost nothing: every form is still saved', async () => {
  // Three failures outlast the backend's own retries once, so the page has to ask again too.
  const s = site({ permissionFailures: 3 });
  const report = await analyse(six(), { core, ask: s.ask });
  assert.deepEqual([report.saved, report.errors.length], [6, 0]);
  assert.equal((await s.ask('listForms')).forms.length, 6);
});

test('a form that cannot be saved is named, and the rest are saved', async () => {
  const s = site({}, async (name, payload) =>
    name === 'saveForm' && payload.record.fileName === '02-expense-report.xsn'
      ? { ok: false, error: 'Jira storage did not accept this form. Try again in a moment.' }
      : undefined);
  const progress = [];
  const report = await analyse(six(), { core, ask: s.ask, onProgress: (done) => progress.push(done) });
  assert.equal(report.saved, 5);
  assert.deepEqual(report.errors, [{ fileName: '02-expense-report.xsn', why: 'Jira storage did not accept this form. Try again in a moment.' }]);
  assert.equal(progress.at(-1), 6);
});

test('a file that is not a template is reported by its code, and counts as done', async () => {
  const s = site();
  const broken = { name: 'broken.xsn', file: new File([new Uint8Array([1, 2, 3, 4])], 'broken.xsn') };
  const progress = [];
  const report = await analyse([broken, fileOf('01-leave-request'), { name: 'notes.txt', file: new File(['x'], 'notes.txt') }], { core, ask: s.ask, onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(report.saved, 1);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].fileName, 'broken.xsn');
  assert.ok(report.errors[0].code);
  assert.deepEqual(report.skipped, ['notes.txt']);
  assert.deepEqual(progress.at(-1), [2, 2]);
});

test('with no template among the files nothing is asked of Jira', async () => {
  const s = site();
  const report = await analyse([{ name: 'notes.txt', file: new File(['x'], 'notes.txt') }], { core, ask: s.ask, onProgress: () => assert.fail('no progress to show') });
  assert.deepEqual([report.templates, report.saved, s.calls.length], [0, 0, 0]);
});

test('two templates with one form name are saved one after the other and both stay', async () => {
  let together = 0;
  let most = 0;
  const s = site({}, async () => {
    most = Math.max(most, ++together);
    await soon(2);
    together -= 1;
  });
  const report = await analyse([fileOf('01-leave-request', 'hr/leave.xsn'), fileOf('01-leave-request', 'old/leave.xsn')], { core, ask: s.ask });
  assert.equal(report.saved, 2);
  assert.equal(most, 1, 'never two saves of one name at once');
  assert.deepEqual((await s.ask('listForms')).forms.map((f) => f.fileName).sort(), ['hr/leave.xsn', 'old/leave.xsn']);
});

test('when the person turns out not to be an administrator, the work stops cleanly', async () => {
  // The second save is refused while three others are still on their way.
  const s = site({}, async (name, _payload, nth) => {
    if (name !== 'saveForm') return undefined;
    await soon(nth === 2 ? 1 : 15);
    return nth === 2 ? { ok: false, denied: true, error: 'Only Jira administrators can use InfoPath Afterlife.' } : undefined;
  });
  const progress = [];
  const e = await analyse(six(), { core, ask: s.ask, onProgress: (done) => progress.push(done) }).then(() => assert.fail('should stop'), (x) => x);
  assert.equal(e.denied, true);
  assert.equal(s.calls.length, 4, 'no save was started after the refusal');
  const told = progress.length;
  await soon(40);
  assert.equal(progress.length, told, 'and nothing reports progress afterwards');
  assert.equal(s.calls.length, 4);
});
