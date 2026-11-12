import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as core from '../vendor/afterlife-core.mjs';
import { toJsmForm } from '../lib/convert.mjs';
import { summarise } from '../lib/summary.mjs';
import { fakeForge } from '../lib/fake-forge.mjs';
import { createBackend, VALUE_BYTES } from '../src/plan.mjs';

const samples = new URL('../static/admin/samples/', import.meta.url);

async function recordOf(file, extra = {}) {
  const bytes = new Uint8Array(readFileSync(new URL(file, samples)));
  const template = await core.parseXsn(bytes);
  const ir = core.buildFormIR(template);
  const row = (await core.triageFiles([{ name: file, bytes }])).rows[0];
  return { ...summarise(row, ir, toJsmForm(template, ir, core), '2026-01-01T00:00:00.000Z'), ...extra };
}

function setup(options) {
  const forge = fakeForge(options);
  let clock = Date.parse('2026-11-12T08:00:00Z');
  const waits = [];
  const warnings = [];
  const backend = createBackend({
    ...forge,
    now: () => clock,
    wait: async (ms) => void waits.push(ms),
    warn: (line) => warnings.push(line),
  });
  const call = (name, payload, accountId = 'admin-1') =>
    backend.resolvers[name]({ payload, context: { accountId } });
  return { ...forge, backend, call, waits, warnings, tick: (ms) => (clock += ms) };
}

const leave = await recordOf('01-leave-request.xsn');
const expense = await recordOf('02-expense-report.xsn');
const purchase = await recordOf('04-purchase-request.xsn');

test('every admin page call is refused to someone who is not a Jira administrator', async () => {
  const { backend, call, store } = setup({ admin: false });
  for (const name of Object.keys(backend.resolvers)) {
    const r = await call(name, { record: leave, id: leave.id, ids: [leave.id], serviceDeskId: '4', projectKey: 'HR', rovoAccess: 'admins' });
    assert.deepEqual([name, r.ok, r.denied], [name, false, true]);
  }
  assert.equal(store.size, 0, 'nothing was written');
});

test('when Jira cannot say who is asking, nothing is done, the page may ask again, and the answer is not remembered', async () => {
  const s = setup({ knownUser: false });
  const r = await s.call('saveForm', { record: leave });
  assert.deepEqual([r.ok, r.retry, r.denied], [false, true, undefined]);
  assert.match(r.error, /could not confirm/);
  assert.equal(s.store.size, 0);
  s.state.knownUser = true;
  assert.equal((await s.call('saveForm', { record: leave })).ok, true);
});

test('a permission check that Jira fails is asked again before giving up', async () => {
  const s = setup({ permissionFailures: 2 });
  assert.equal((await s.call('saveForm', { record: leave })).ok, true, 'the third answer counts');
  assert.deepEqual(s.waits, [150, 400]);
  assert.deepEqual(s.warnings, []);

  s.tick(61_000);
  s.state.permissionFailures = 3;
  const r = await s.call('saveForm', { record: expense }, 'admin-7');
  assert.deepEqual([r.ok, r.retry], [false, true]);
  assert.deepEqual(s.warnings, ['The ADMINISTER permission check failed: status 503.']);
  assert.equal(s.warnings.join().includes('admin-7'), false, 'the log line names nobody');
  assert.equal((await s.call('saveForm', { record: expense }, 'admin-7')).ok, true, 'and the next call asks afresh');

  // The same holds for the check on one project.
  s.state.permissionFailures = 1;
  assert.equal((await s.call('createForm', { id: leave.id, projectKey: 'HR' })).ok, true);
  s.state.permissionFailures = 3;
  const made = await s.call('createForm', { id: expense.id, projectKey: 'HR' });
  assert.equal(made.ok, false);
  assert.match(made.error, /could not confirm who is asking, so nothing was created/);
  assert.equal(s.jiraForms.size, 1);
});

test('the permission check is asked once a minute per person, not once per call', async () => {
  const s = setup();
  const asked = () => s.state.calls.filter((c) => c.includes('permissions=ADMINISTER') && !c.includes('projectKey')).length;
  await Promise.all([s.call('openPlan'), s.call('listTargets'), s.call('listForms')]);
  assert.equal(asked(), 1);
  s.tick(61_000);
  await s.call('listForms');
  assert.equal(asked(), 2);
  await s.call('listForms', undefined, 'admin-2');
  assert.equal(asked(), 3);
});

test('a saved form is listed without its field list, and read without its design', async () => {
  const { call, store } = setup();
  assert.deepEqual(await call('saveForm', { record: leave }), { ok: true, id: leave.id });
  assert.deepEqual([...store.keys()].sort(), [`brief:${leave.id}`, `design:${leave.id}`, `form:${leave.id}`]);

  const { forms, settings } = await call('openPlan');
  assert.deepEqual(settings, { rovoAccess: 'everyone' });
  assert.equal(forms.length, 1);
  assert.equal(forms[0].name, leave.name);
  assert.deepEqual(forms[0].causes, leave.causes.map((c) => c.id));
  assert.equal('fields' in forms[0], false);
  assert.equal('design' in forms[0], false);

  const { form } = await call('getForm', { id: leave.id });
  assert.equal(form.fields.length, leave.fields.length);
  assert.deepEqual(form.created, []);
  assert.equal('design' in form, false);
});

test('the plan is sorted by wave, then name, over more than one page of storage', async () => {
  const { call } = setup();
  for (let i = 0; i < 205; i++)
    await call('saveForm', { record: { ...leave, id: `form-${i}`, name: `Form ${String(i).padStart(3, '0')}`, fileName: `f${i}.xsn`, wave: (i % 3) + 1 } });
  const { forms } = await call('listForms');
  assert.equal(forms.length, 205);
  assert.deepEqual(forms.slice(0, 2).map((f) => f.name), ['Form 000', 'Form 003']);
  assert.ok(forms.every((f, i) => i === 0 || forms[i - 1].wave <= f.wave));
});

test('two different templates with one name both stay in the plan', async () => {
  const { call } = setup();
  await call('saveForm', { record: leave });
  const other = { ...leave, fileName: 'finance/template.xsn', urn: 'urn:other' };
  assert.deepEqual(await call('saveForm', { record: other }), { ok: true, id: `${leave.id}-2` });
  assert.deepEqual(await call('saveForm', { record: { ...other, urn: 'urn:third' } }), { ok: true, id: `${leave.id}-3` });
  // The same file again replaces its own row and nothing else.
  assert.deepEqual(await call('saveForm', { record: other }), { ok: true, id: `${leave.id}-2` });
  const { forms } = await call('listForms');
  assert.deepEqual(forms.map((f) => f.fileName), [leave.fileName, 'finance/template.xsn', 'finance/template.xsn']);
  assert.equal((await call('getForm', { id: `${leave.id}-2` })).form.id, `${leave.id}-2`);
});

test('a record that is not a form record is refused', async () => {
  const { call, store } = setup();
  for (const record of [undefined, {}, { ...leave, id: '../x' }, { ...leave, wave: 4 }, { ...leave, design: {} }, { ...leave, fields: 'x' }, { ...leave, name: '' }])
    assert.equal((await call('saveForm', { record })).ok, false);
  assert.equal(store.size, 0);
});

test('a very large form keeps what fits and says how many fields it left out', async () => {
  const { call } = setup();
  const field = { label: 'Đơn giá – 単価', path: '/my:f/my:x', control: 'Text box', target: 'ts', targetWords: 'Short text', status: 'converted', note: 'n'.repeat(300) };
  const big = { ...leave, fields: Array.from({ length: 3000 }, () => field) };
  assert.equal((await call('saveForm', { record: big })).ok, true);
  const { form } = await call('getForm', { id: leave.id });
  assert.ok(form.fields.length > 0 && form.fields.length < 3000);
  assert.equal(form.fields.length + form.fieldsOmitted, 3000);
  assert.equal('note' in form.fields[0], false);
  assert.ok(new TextEncoder().encode(JSON.stringify(form)).length <= VALUE_BYTES + 200);

  const design = { ...leave.design, questions: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [i + 1, { type: 'ts', label: 'ß'.repeat(60), validation: { rq: false } }])) };
  const r = await call('saveForm', { record: { ...leave, id: 'huge', fileName: 'huge.xsn', design } });
  assert.equal(r.ok, false);
  assert.match(r.error, /too large to keep/);
  assert.equal((await call('getForm', { id: 'huge' })).ok, false, 'nothing half-saved');
});

test('removing forms removes all three values of each', async () => {
  const { call, store } = setup();
  for (const record of [leave, expense, purchase]) await call('saveForm', { record });
  assert.deepEqual(await call('removeForms', { ids: [leave.id, purchase.id] }), { ok: true, removed: 2 });
  assert.deepEqual([...store.keys()].sort(), [`brief:${expense.id}`, `design:${expense.id}`, `form:${expense.id}`]);
  assert.equal((await call('getForm', { id: leave.id })).ok, false);
  assert.equal((await call('removeForms', { ids: ['../x'] })).ok, false);
});

test('service projects and request types are read to the last page', async () => {
  const desks = Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), projectKey: `P${i}`, projectName: `Project ${7 - i}` }));
  const { call } = setup({ desks, pageSize: 3, requestTypes: { 1: Array.from({ length: 8 }, (_, i) => ({ id: String(i + 10), name: `Type ${i}`, portalId: '1' })) }, taken: new Set(['1/12']) });
  const targets = await call('listTargets');
  assert.equal(targets.desks.length, 7);
  assert.equal(targets.desks[0].projectName, 'Project 1');
  const { requestTypes } = await call('listRequestTypes', { serviceDeskId: '1' });
  assert.equal(requestTypes.length, 8);
  assert.deepEqual(requestTypes.filter((t) => t.hasForm).map((t) => t.id), ['12']);
  assert.equal((await call('listRequestTypes', { serviceDeskId: '99' })).ok, false);
  assert.equal((await call('listRequestTypes', { serviceDeskId: 'x' })).ok, false);
});

test('creating a form posts the stored design and records where it went', async () => {
  const s = setup();
  await s.call('saveForm', { record: purchase });
  const r = await s.call('createForm', { id: purchase.id, projectKey: 'HR', requestTypeId: '40' });
  assert.equal(r.ok, true);
  assert.equal(r.questions, purchase.conversion.questions);
  assert.equal(r.formsPage, '/jira/servicedesk/projects/HR/settings/forms');
  const sent = s.jiraForms.get(`HR/${r.formId}`);
  assert.deepEqual(sent.design, purchase.design);
  assert.deepEqual(sent.publish.portal.portalRequestTypeIds, [40]);
  const { forms } = await s.call('listForms');
  assert.deepEqual(forms[0].created.map((c) => [c.projectKey, c.requestTypeId]), [['HR', '40']]);
  // Analysing the template again keeps the record of what was created.
  await s.call('saveForm', { record: purchase });
  assert.equal((await s.call('getForm', { id: purchase.id })).form.created.length, 1);
});

test('a second copy in the same project needs to be asked for', async () => {
  const s = setup();
  await s.call('saveForm', { record: leave });
  assert.equal((await s.call('createForm', { id: leave.id, projectKey: 'HR' })).ok, true);
  const again = await s.call('createForm', { id: leave.id, projectKey: 'HR' });
  assert.deepEqual([again.ok, again.duplicate], [false, true]);
  assert.equal(s.jiraForms.size, 1);
  assert.equal((await s.call('createForm', { id: leave.id, projectKey: 'FAC' })).ok, true, 'another project is not a copy');
  assert.equal((await s.call('createForm', { id: leave.id, projectKey: 'HR', again: true })).ok, true);
  assert.equal(s.jiraForms.size, 3);
});

test('a form deleted in Jira is no longer counted as created', async () => {
  const s = setup();
  await s.call('saveForm', { record: leave });
  const made = await s.call('createForm', { id: leave.id, projectKey: 'HR' });
  s.jiraForms.delete(`HR/${made.formId}`);
  const read = await s.call('getForm', { id: leave.id });
  assert.deepEqual([read.form.created, read.changed], [[], true]);
  assert.deepEqual((await s.call('listForms')).forms[0].created, []);
  assert.equal((await s.call('createForm', { id: leave.id, projectKey: 'HR' })).ok, true, 'so it can be created again');
});

test('creating needs the person to administer the project, and a real project', async () => {
  const s = setup({ projectAdmin: false });
  await s.call('saveForm', { record: leave });
  const r = await s.call('createForm', { id: leave.id, projectKey: 'HR' });
  assert.equal(r.ok, false);
  assert.match(r.error, /administer project HR/);
  s.state.projectAdmin = true;
  assert.match((await s.call('createForm', { id: leave.id, projectKey: 'NOPE' })).error, /not found/);
  assert.equal((await s.call('createForm', { id: leave.id, projectKey: 'hr' })).ok, false);
  assert.equal((await s.call('createForm', { id: 'missing', projectKey: 'HR' })).ok, false);
  assert.equal((await s.call('createForm', { id: leave.id, projectKey: 'HR', requestTypeId: '4; drop' })).ok, false);
  assert.equal(s.jiraForms.size, 0);
});

test('Rovo: the plan, one form, and what to say when the name is unclear', async () => {
  const s = setup();
  const { actions } = s.backend;
  assert.match((await actions.listLegacyForms({}, {})).note, /No InfoPath templates/);
  for (const record of [leave, expense, purchase]) await s.call('saveForm', { record: { ...record, sample: true } });

  const plan = await actions.listLegacyForms({}, {});
  assert.equal(plan.total, 3);
  assert.equal(plan.waves[1] + plan.waves[2] + plan.waves[3], 3);
  assert.ok(plan.forms.every((f) => f.bundledSample === true && f.causesOfDeath.length > 0));
  assert.ok(plan.forms.every((f) => f.causesOfDeath.every((words) => / /.test(words))), 'causes are named in words, not ids');

  const one = await actions.getLegacyForm({ form: 'expense report' }, {});
  assert.equal(one.name, expense.name);
  assert.equal(one.fields.length, expense.fields.length);
  assert.ok(one.causesOfDeath.every((c) => c.evidence.length > 0 && / /.test(c.cause)));
  assert.equal(JSON.stringify(one).includes('this page'), false, 'nothing is worded for the admin page');
  assert.equal((await actions.getLegacyForm({ form: expense.fileName }, {})).name, expense.name);
  assert.equal((await actions.getLegacyForm({ form: 'expense' }, {})).name, expense.name);

  const unclear = await actions.getLegacyForm({ form: 're' }, {});
  assert.match(unclear.error, /More than one/);
  assert.ok(unclear.matchingForms.length > 1);
  const none = await actions.getLegacyForm({ form: 'payroll' }, {});
  assert.match(none.error, /No analysed form/);
  assert.equal(none.knownForms.length, 3);
  assert.match((await actions.getLegacyForm({}, {})).error, /No analysed form/);
});

test('Rovo: creating a form follows the same rules as the page, and never makes a copy', async () => {
  const s = setup();
  const { actions } = s.backend;
  await s.call('saveForm', { record: leave });
  const made = await actions.createJsmForm({ form: 'Leave Request', projectKey: ' hr ' }, {});
  assert.equal(made.ok, true);
  assert.deepEqual(made.needsAttention, leave.attention);
  assert.match((await actions.createJsmForm({ form: 'Leave Request', projectKey: 'HR' }, {})).error, /already created in HR/);
  s.state.projectAdmin = false;
  assert.match((await actions.createJsmForm({ form: 'Leave Request', projectKey: 'FAC' }, {})).error, /does not administer a service project with the key FAC/);
  assert.match((await actions.createJsmForm({ form: 'Leave Request', projectKey: 'NOPE' }, {})).error, /with the key NOPE/);
  assert.match((await actions.createJsmForm({ form: 'Leave Request' }, {})).error, /No service project was named/);
  assert.equal(s.jiraForms.size, 1);
});

test('Rovo: the service projects offered are the ones the person administers', async () => {
  const s = setup({ projectAdmin: ['FAC'] });
  const { actions } = s.backend;
  assert.deepEqual(await actions.listServiceProjects({}, {}), {
    serviceProjects: [{ key: 'FAC', name: 'Facilities' }],
  });
  s.state.projectAdmin = false;
  const none = await actions.listServiceProjects({}, {});
  assert.deepEqual(none.serviceProjects, []);
  assert.match(none.note, /administers no service project/);
  s.state.knownUser = false;
  assert.match((await actions.listServiceProjects({}, {})).error, /could not confirm/);
});

test('Rovo: a site can keep the plan with its administrators', async () => {
  const s = setup();
  const { actions } = s.backend;
  await s.call('saveForm', { record: leave });
  assert.equal((await s.call('setSettings', { rovoAccess: 'nobody' })).ok, false);
  assert.deepEqual(await s.call('setSettings', { rovoAccess: 'admins' }), { ok: true, settings: { rovoAccess: 'admins' } });
  assert.equal((await actions.listLegacyForms({}, { principal: { accountId: 'admin-1' } })).total, 1);

  s.state.admin = false;
  const guest = { principal: { accountId: 'guest-1' } };
  for (const answer of [
    await actions.listLegacyForms({}, guest),
    await actions.getLegacyForm({ form: 'Leave Request' }, guest),
    await actions.createJsmForm({ form: 'Leave Request', projectKey: 'HR' }, guest),
    await actions.listServiceProjects({}, guest),
    await actions.listLegacyForms({}, undefined),
  ]) {
    assert.match(answer.error, /only Jira administrators/);
    assert.equal(JSON.stringify(answer).includes(leave.name), false, 'no form name leaks');
  }

  // When Jira cannot say whether the person is an administrator, the plan stays closed too.
  s.state.knownUser = false;
  const unsure = await actions.listLegacyForms({}, { principal: { accountId: 'someone-2' } });
  assert.match(unsure.error, /could not confirm who is asking/);
  assert.equal(JSON.stringify(unsure).includes(leave.name), false);
  assert.equal(s.jiraForms.size, 0);
});
