import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeAsk, Problem, words } from '../ui/ask.js';

const answers = (...list) => {
  const calls = [];
  const waits = [];
  const ask = makeAsk(
    async (name, payload) => {
      calls.push([name, payload]);
      const next = list.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    async (ms) => void waits.push(ms),
  );
  return { ask, calls, waits };
};
const failure = (promise) => promise.then(() => assert.fail('should have failed'), (e) => e);

test('a good answer is handed back as it is', async () => {
  const { ask, calls } = answers({ ok: true, forms: [] });
  assert.deepEqual(await ask('listForms', { a: 1 }), { ok: true, forms: [] });
  assert.deepEqual(calls, [['listForms', { a: 1 }]]);
});

test('when the backend stopped before doing anything, the page asks again, with the same payload', async () => {
  const { ask, calls, waits } = answers({ ok: false, retry: true, error: 'x' }, { ok: false, retry: true, error: 'x' }, { ok: true, id: 'a' });
  assert.deepEqual(await ask('saveForm', { record: 1 }), { ok: true, id: 'a' });
  assert.deepEqual(calls, [['saveForm', { record: 1 }], ['saveForm', { record: 1 }], ['saveForm', { record: 1 }]]);
  assert.deepEqual(waits, [600, 1500]);
});

test('after three such answers the person is told, in the backend’s words, and is not called a stranger', async () => {
  const again = { ok: false, retry: true, error: 'Jira could not confirm your permissions just now. Try again in a moment.' };
  const { ask, calls } = answers(again, again, again, { ok: true });
  const e = await failure(ask('openPlan'));
  assert.ok(e instanceof Problem);
  assert.equal(e.denied, false);
  assert.equal(words(e), again.error);
  assert.equal(calls.length, 3);
});

test('a refusal and a failure are not asked again', async () => {
  const refused = answers({ ok: false, denied: true, error: 'Only Jira administrators can use InfoPath Afterlife.' }, { ok: true });
  const e = await failure(refused.ask('openPlan'));
  assert.deepEqual([e.denied, e.message, refused.calls.length], [true, 'Only Jira administrators can use InfoPath Afterlife.', 1]);

  const failed = answers({ ok: false, error: 'This form is too large to keep.' }, { ok: true });
  assert.equal((await failure(failed.ask('saveForm'))).message, 'This form is too large to keep.');
  assert.equal(failed.calls.length, 1);
});

test('a call that never reaches Jira is not repeated: it may have gone through', async () => {
  const { ask, calls } = answers(new Error('network'), { ok: true });
  const e = await failure(ask('createForm'));
  assert.match(e.message, /Jira did not answer/);
  assert.equal(calls.length, 1);
  assert.match((await failure(answers(undefined).ask('listForms'))).message, /Jira did not answer/);
});

test('an error that is not ours gets plain words, not its own', () => {
  assert.equal(words(new TypeError('x is undefined')), 'Something went wrong on this page. Reload it and try again.');
});
