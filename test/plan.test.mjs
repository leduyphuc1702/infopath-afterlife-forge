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

test('one click makes a request type named after the form and shows the form on it', async () => {
  const s = setup();
  await s.call('saveForm', { record: leave });
  const r = await s.call('createForm', { id: leave.id, projectKey: 'HR', newRequestType: true });
  assert.equal(r.ok, true);
  assert.deepEqual([r.requestTypeName, r.newRequestType, r.portalId], [leave.name, true, '4']);
  assert.equal(r.portalPath, `/servicedesk/customer/portal/4/create/${r.requestTypeId}`);
  // Jira puts a new request type in no portal group, so the form is not live yet.
  assert.equal(r.hidden, true);
  assert.equal(r.portalGroupsPage, '/jira/servicedesk/projects/HR/settings/portal-settings/portal-groups');
  assert.equal(r.workType, '[System] Service request', 'the plain service request, not the most used type');

  const type = s.state.requestTypes[4].find((t) => t.id === r.requestTypeId);
  assert.deepEqual([type.name, type.issueTypeId], [leave.name, '10001']);
  assert.match(type.description, /Replaces the InfoPath form “Leave Request”/);
  assert.deepEqual(s.jiraForms.get(`HR/${r.formId}`).publish.portal.portalRequestTypeIds, [Number(r.requestTypeId)]);

  const [made] = (await s.call('listForms')).forms[0].created;
  assert.deepEqual(
    [made.requestTypeId, made.requestTypeName, made.portalId, made.serviceDeskId, made.newRequestType, made.hidden],
    [r.requestTypeId, leave.name, '4', '4', true, true],
  );

  // A project without that work type gets the one most of its request types use.
  const fac = await s.call('createForm', { id: leave.id, projectKey: 'FAC', newRequestType: true });
  assert.equal(fac.workType, 'Facilities request');
  assert.equal(s.state.requestTypes[5].at(-1).issueTypeId, '10012');
});

test('a request type is taken back when its form cannot be created', async () => {
  const s = setup({ refuseForms: true });
  await s.call('saveForm', { record: leave });
  const r = await s.call('createForm', { id: leave.id, projectKey: 'HR', newRequestType: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not accept the form/);
  assert.equal(/was left/.test(r.error), false);
  assert.equal(s.state.requestTypes[4].length, 3, 'no request type is left behind');

  s.state.refuseDeletes = true;
  const left = await s.call('createForm', { id: leave.id, projectKey: 'HR', newRequestType: true });
  assert.match(left.error, /An empty request type “Leave Request” was left in HR/);
  assert.deepEqual((await s.call('listForms')).forms[0].created, [], 'and nothing is recorded as created');
});

test('a site that has not approved the request-type permission is told so, and nothing is created', async () => {
  const s = setup({ canMakeTypes: false });
  await s.call('saveForm', { record: leave });
  const r = await s.call('createForm', { id: leave.id, projectKey: 'HR', newRequestType: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /Nothing was created.*approve the app’s update/);
  assert.equal(s.jiraForms.size, 0);
  // The other two ways still work.
  assert.equal((await s.call('createForm', { id: leave.id, projectKey: 'HR', requestTypeId: '40' })).ok, true);
});

test('an existing request type must belong to the project, and its name and portal are recorded', async () => {
  const s = setup();
  await s.call('saveForm', { record: leave });
  const other = await s.call('createForm', { id: leave.id, projectKey: 'HR', requestTypeId: '50' });
  assert.equal(other.ok, false);
  assert.match(other.error, /not in project HR/);
  assert.equal((await s.call('createForm', { id: leave.id, projectKey: 'HR', requestTypeId: '40', newRequestType: true })).ok, false);
  assert.equal(s.jiraForms.size, 0);

  const r = await s.call('createForm', { id: leave.id, projectKey: 'HR', requestTypeId: '40' });
  assert.deepEqual([r.ok, r.requestTypeName, r.portalId, r.newRequestType], [true, 'Employee offboarding', '4', undefined]);
  assert.equal(r.portalPath, '/servicedesk/customer/portal/4/create/40');
  assert.deepEqual([r.hidden, r.portalGroupsPage], [undefined, undefined], 'it is in a portal group, so the form is live');
  assert.equal(s.state.requestTypes[4].length, 3, 'no request type was made');
});

test('a form waits for a portal group, and the plan notices when its request type gets one', async () => {
  const s = setup();
  await s.call('saveForm', { record: leave });
  const r = await s.call('createForm', { id: leave.id, projectKey: 'HR', newRequestType: true });
  const hidden = async (call = 'listForms') => (await s.call(call)).forms[0].created[0].hidden;
  assert.equal(await hidden(), true);

  // A project administrator adds the request type to a portal group in Jira.
  s.addToPortalGroup('4', r.requestTypeId);
  assert.equal(await hidden('openPlan'), undefined);
  const key = [...s.store.keys()].find((k) => (s.store.get(k).created ?? []).length === 1);
  assert.equal('hidden' in s.store.get(key).created[0], false, 'and that is kept');
  assert.equal((await s.call('getForm', { id: leave.id })).changed, undefined);

  // Taken out of every group again, it waits again. Opening the form notices as well.
  s.state.requestTypes[4].find((t) => t.id === r.requestTypeId).groupIds = [];
  const read = await s.call('getForm', { id: leave.id });
  assert.deepEqual([read.changed, read.form.created[0].hidden], [true, true]);
  assert.equal(await hidden(), true);

  // When Jira cannot list the request types, the plan shows what it had.
  s.addToPortalGroup('4', r.requestTypeId);
  s.state.failTypeLists = true;
  assert.equal(await hidden(), true);
  s.state.failTypeLists = false;
  assert.equal(await hidden(), undefined);
});

test('an existing request type that is in no portal group is offered as hidden, and its form waits too', async () => {
  const s = setup();
  s.state.requestTypes[4].find((t) => t.id === '42').groupIds = [];
  const { requestTypes } = await s.call('listRequestTypes', { serviceDeskId: '4' });
  assert.deepEqual(requestTypes.map((t) => [t.id, t.hidden]), [['40', undefined], ['39', undefined], ['42', true]]);
  await s.call('saveForm', { record: leave });
  const r = await s.call('createForm', { id: leave.id, projectKey: 'HR', requestTypeId: '42' });
  assert.deepEqual([r.ok, r.hidden, r.newRequestType], [true, true, undefined]);
  assert.match(r.portalGroupsPage, /\/HR\/settings\/portal-settings\/portal-groups$/);
});

test('a form taken off its request type is no longer said to be in the portal', async () => {
  const s = setup();
  await s.call('saveForm', { record: leave });
  const made = await s.call('createForm', { id: leave.id, projectKey: 'HR', newRequestType: true });
  assert.equal((await s.call('getForm', { id: leave.id })).changed, undefined);
  s.state.taken.delete(`4/${made.requestTypeId}`);
  const read = await s.call('getForm', { id: leave.id });
  assert.equal(read.changed, true);
  assert.deepEqual(Object.keys(read.form.created[0]).sort(), ['formId', 'projectKey', 'when']);
  assert.equal((await s.call('getForm', { id: leave.id })).changed, undefined, 'and that is remembered');
});

test('a form shown in the portal by an earlier version of the app gets its portal link', async () => {
  const s = setup();
  await s.call('saveForm', { record: leave });
  const made = await s.call('createForm', { id: leave.id, projectKey: 'HR', requestTypeId: '40' });
  const key = [...s.store.keys()].find((k) => (s.store.get(k).created ?? []).length === 1);
  const old = s.store.get(key);
  const { projectKey, formId, requestTypeId, when } = old.created[0];
  s.store.set(key, { ...old, created: [{ projectKey, formId, requestTypeId, when }] });

  const read = await s.call('getForm', { id: leave.id });
  assert.equal(read.changed, true);
  const now = read.form.created[0];
  assert.deepEqual(
    [now.formId, now.requestTypeId, now.requestTypeName, now.portalId, now.serviceDeskId],
    [made.formId, '40', 'Employee offboarding', '4', '4'],
  );
  assert.equal((await s.call('getForm', { id: leave.id })).changed, undefined, 'and that is remembered');

  s.store.set(key, { ...old, created: [{ projectKey, formId, requestTypeId: '999', when }] });
  const lost = await s.call('getForm', { id: leave.id });
  assert.deepEqual(Object.keys(lost.form.created[0]).sort(), ['formId', 'projectKey', 'when'], 'a request type that is gone is forgotten');
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
  // Rovo's form gets its own request type. Rovo says the one step that is left, and where.
  assert.deepEqual([made.project, made.requestType, made.workType], ['HR', 'Leave Request', '[System] Service request']);
  assert.equal(made.portalLink, 'https://jira.test/servicedesk/customer/portal/4/create/101');
  assert.equal(made.liveInPortal, false);
  assert.match(made.nextStep, /adds the request type “Leave Request” to a portal group/);
  assert.equal(made.portalGroupsPage, 'https://jira.test/jira/servicedesk/projects/HR/settings/portal-settings/portal-groups');
  const told = await actions.getLegacyForm({ form: 'Leave Request' }, {});
  assert.deepEqual(told.jsmFormsCreated, [
    {
      project: 'HR', created: '2026-11-12', requestType: 'Leave Request',
      state: 'waiting for a portal group', portalLink: made.portalLink,
      nextStep: made.nextStep, portalGroupsPage: made.portalGroupsPage,
    },
  ]);
  const waiting = (await actions.listLegacyForms({}, {})).forms[0];
  assert.deepEqual([waiting.liveInPortal, waiting.waitingForPortalGroup], [undefined, true]);
  // Once a project administrator has added it to a portal group, Rovo says it is live.
  s.addToPortalGroup('4', '101');
  const live = (await actions.listLegacyForms({}, {})).forms[0];
  assert.deepEqual([live.liveInPortal, live.waitingForPortalGroup], [true, undefined]);
  assert.deepEqual((await actions.getLegacyForm({ form: 'Leave Request' }, {})).jsmFormsCreated, [
    { project: 'HR', created: '2026-11-12', requestType: 'Leave Request', state: 'live in the portal', portalLink: made.portalLink },
  ]);
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
