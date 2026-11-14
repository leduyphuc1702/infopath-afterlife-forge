// Everything the backend does, with Jira and storage handed in. The deployed app, the tests and
// the local preview all run this same code; only what stands behind `jira` and `kvs` differs.

import { CAUSE_WORDS } from '../lib/causes.mjs';

export const ID = /^[a-z0-9-]{1,80}$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,19}$/;
const DIGITS = /^\d+$/;
// Forge key-value storage holds 240 KiB per value.
export const VALUE_BYTES = 240 * 1024 - 1024;
const ADMIN_MEMORY_MS = 60_000;
const PERMISSION_PAUSES_MS = [150, 400];
// Rovo is offered at most this many service projects to choose from.
const MOST_OFFERED = 30;
const HEADERS = { Accept: 'application/json' };
// Jira marks the calls that create and delete a request type as experimental and wants this said.
const EXPERIMENTAL = { ...HEADERS, 'X-ExperimentalApi': 'opt-in' };
// Jira takes a request type name of up to 255 characters.
const TYPE_NAME_MOST = 250;

// One form is three values, so the plan loads without the field lists and the designs.
const briefKey = (id) => `brief:${id}`;
const detailKey = (id) => `form:${id}`;
const designKey = (id) => `design:${id}`;
const BRIEFS = 'brief:';
const SETTINGS_KEY = 'settings';
const DEFAULT_SETTINGS = { rovoAccess: 'everyone' };

export const WAVE_WORDS = {
  1: 'Wave 1: converts to a native JSM form as it is',
  2: 'Wave 2: works, with some parts simplified in the native JSM form',
  3: 'Wave 3: has parts a person must replace by hand',
};

const fail = (error, extra) => ({ ok: false, error, ...extra });
const portalPath = (c) => `/servicedesk/customer/portal/${c.portalId}/create/${c.requestTypeId}`;
const inPortal = (c) => Boolean(c.portalId && c.requestTypeId);
// Jira shows a request type in the portal, and lets people send it from there, only when it is in
// a portal group. The app can read the groups of a request type; Jira gives it no way to set them.
const isLive = (c) => inPortal(c) && !c.hidden;
const isWaiting = (c) => inPortal(c) && c.hidden === true;
const groupsPage = (projectKey) => `/jira/servicedesk/projects/${projectKey}/settings/portal-settings/portal-groups`;
/** Is this request type, as Jira describes it, in no portal group? Undefined when Jira does not say. */
const hiddenOf = (t) => (Array.isArray(t?.groupIds) ? t.groupIds.length === 0 : undefined);
/** The record with what Jira says about its portal groups. The same object when nothing changed. */
function withGroups(c, t) {
  const hidden = hiddenOf(t);
  if (hidden === undefined || hidden === (c.hidden === true)) return c;
  const { hidden: _was, ...rest } = c;
  return hidden ? { ...rest, hidden: true } : rest;
}
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const day = (iso) => String(iso).slice(0, 10);

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

async function eachLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function wellFormed(r) {
  const num = Number.isFinite;
  return Boolean(
    r && typeof r === 'object' &&
      ID.test(String(r.id)) &&
      typeof r.name === 'string' && r.name.length > 0 && r.name.length <= 300 &&
      typeof r.fileName === 'string' && r.fileName.length <= 1000 &&
      [1, 2, 3].includes(r.wave) &&
      r.counts && num(r.counts.fields) && num(r.counts.rules) && num(r.counts.connections) &&
      Array.isArray(r.causes) &&
      r.causes.every((c) => c && typeof c.id === 'string' && Array.isArray(c.evidence)) &&
      Array.isArray(r.fields) && Array.isArray(r.attention) &&
      r.conversion && num(r.conversion.questions) &&
      r.design && typeof r.design === 'object' &&
      r.design.questions && typeof r.design.questions === 'object',
  );
}

/** What the plan lists about one form. */
function briefOf(r, created) {
  return {
    id: r.id,
    name: r.name,
    fileName: r.fileName,
    ...(r.urn && { urn: r.urn }),
    ...(r.sample === true && { sample: true }),
    generation: r.generation,
    browserCompatible: r.browserCompatible,
    wave: r.wave,
    counts: r.counts,
    ...(r.coverage && { coverage: r.coverage }),
    ...(r.nativePercent !== undefined && { nativePercent: r.nativePercent }),
    ...(r.records !== undefined && { records: r.records }),
    causes: r.causes.map((c) => c.id),
    conversion: r.conversion,
    created,
    analysedAt: r.analysedAt,
  };
}

// Two templates can carry the same name. They are the same form only when the file and the
// template's own identifier both match; anything else gets its own row instead of replacing one.
const sameTemplate = (a, b) => a.fileName === b.fileName && (a.urn ?? '') === (b.urn ?? '');

const byPlanOrder = (a, b) =>
  a.wave - b.wave || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

function find(briefs, wanted) {
  const q = String(wanted ?? '').trim().toLowerCase();
  if (!q) return { many: [] };
  const slug = q.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const exact = briefs.filter(
    (f) => f.id === slug || f.name.toLowerCase() === q || f.fileName.toLowerCase() === q,
  );
  if (exact.length === 1) return { form: exact[0] };
  const pool =
    exact.length > 1
      ? exact
      : briefs.filter((f) => f.name.toLowerCase().includes(q) || (slug && f.id.includes(slug)));
  return pool.length === 1 ? { form: pool[0] } : { many: pool };
}

/**
 * @param kvs    Forge key-value storage
 * @param where  its `WhereConditions`
 * @param route  the Forge `route` tag, which escapes what is put into a path
 * @param jira   `{ asUser(path, init), asApp(path, init) }`, each answering like `fetch`
 * @param now    the clock, in milliseconds
 * @param wait   pauses for so many milliseconds
 * @param warn   takes one line for the app's log; it never carries anything about a person
 */
export function createBackend({
  kvs,
  where,
  route,
  jira,
  now = Date.now,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  warn = () => {},
}) {
  const admins = new Map();

  /**
   * Does the person asking hold this permission? 'yes', 'no', or 'unknown' when Jira cannot say.
   * Jira now and then fails one such call, so it is asked again before giving up.
   */
  async function holds(permission, path) {
    for (let attempt = 0; ; attempt++) {
      let trouble;
      try {
        const res = await jira.asUser(path, { headers: HEADERS });
        if (res.ok)
          return (await json(res))?.permissions?.[permission]?.havePermission === true ? 'yes' : 'no';
        if (res.status !== 429 && res.status < 500) return 'no';
        trouble = `status ${res.status}`;
      } catch {
        trouble = 'no answer';
      }
      if (attempt === PERMISSION_PAUSES_MS.length) {
        warn(`The ${permission} permission check failed: ${trouble}.`);
        return 'unknown';
      }
      await wait(PERMISSION_PAUSES_MS[attempt]);
    }
  }

  /** Is the person asking a Jira administrator? */
  function isAdmin(accountId) {
    const held = accountId ? admins.get(accountId) : undefined;
    if (held && now() - held.at < ADMIN_MEMORY_MS) return held.answer;
    const answer = holds('ADMINISTER', route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
    if (accountId) {
      admins.set(accountId, { answer, at: now() });
      // Only a clear answer is remembered.
      answer.then((a) => a === 'unknown' && admins.delete(accountId));
    }
    return answer;
  }

  /** The person asking must administer the project: the app itself could, but they might not. */
  const administers = (projectKey) =>
    holds(
      'ADMINISTER_PROJECTS',
      route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=ADMINISTER_PROJECTS`,
    );

  async function allBriefs() {
    const out = [];
    let cursor;
    do {
      let query = kvs.query().where('key', where.beginsWith(BRIEFS)).limit(100);
      if (cursor) query = query.cursor(cursor);
      const page = await query.getMany();
      out.push(...page.results.map((r) => r.value));
      cursor = page.nextCursor;
    } while (cursor);
    return out.sort(byPlanOrder);
  }

  const settings = async () => ({ ...DEFAULT_SETTINGS, ...((await kvs.get(SETTINGS_KEY)) ?? {}) });

  const NOT_SURE = { error: 'Jira could not confirm who is asking just now. Try again in a moment.' };

  /** Every page of a Jira Service Management list. */
  async function everyPage(pathFrom) {
    const values = [];
    for (let page = 0, start = 0; page < 50; page++) {
      const res = await jira.asApp(pathFrom(start), { headers: HEADERS });
      if (!res.ok) return { ok: false, status: res.status };
      const body = await json(res);
      const got = body.values ?? [];
      values.push(...got);
      if (body.isLastPage !== false || got.length === 0) break;
      start += got.length;
    }
    return { ok: true, values };
  }

  /** Does Jira still have this? Only a clear "not found" counts as gone. */
  async function gone(path) {
    try {
      return (await jira.asApp(path, { headers: HEADERS })).status === 404;
    } catch {
      return false;
    }
  }

  /** What Jira says about a request type now: its description, `{ gone: true }`, or undefined when it cannot say. */
  async function typeNow(deskId, requestTypeId) {
    try {
      const res = await jira.asApp(route`/rest/servicedeskapi/servicedesk/${deskId}/requesttype/${requestTypeId}`, {
        headers: HEADERS,
      });
      if (res.status === 404) return { gone: true };
      return res.ok ? await json(res) : undefined;
    } catch {
      return undefined;
    }
  }

  const offItsType = ({ requestTypeId: _id, requestTypeName: _name, portalId: _portal, serviceDeskId: _desk, newRequestType: _new, hidden: _hidden, ...rest }) => rest;

  /**
   * The record of a form on a request type, as Jira has it now: whether the request type is in a
   * portal group, and, for a record written before the app kept them, its portal and name.
   * When Jira cannot say, the record stays as it is and is asked about again next time.
   */
  async function withType(c) {
    if (!c.requestTypeId) return c;
    let deskId = c.serviceDeskId;
    if (!deskId || !c.portalId) {
      const found = await deskOf(c.projectKey);
      if (!found.ok) return c;
      deskId = found.desk.id;
    }
    const t = await typeNow(deskId, c.requestTypeId);
    if (!t) return c;
    if (t.gone) return offItsType(c);
    const whole =
      c.portalId && c.serviceDeskId
        ? c
        : { ...c, ...(t.name && { requestTypeName: t.name }), portalId: String(t.portalId ?? deskId), serviceDeskId: deskId };
    return withGroups(whole, t);
  }

  /**
   * The JSM forms made from this form that are still in Jira. Deleted ones leave the record, and
   * one that was taken off its request type is no longer said to be in the portal.
   */
  async function stillInJira(brief) {
    const made = brief.created ?? [];
    if (made.length === 0) return made;
    const kept = await eachLimited(made, 4, async (was) => {
      if (await gone(route`/forms/project/${was.projectKey}/form/${was.formId}`)) return undefined;
      const c = await withType(was);
      if (
        c.serviceDeskId && inPortal(c) &&
        (await gone(route`/forms/servicedesk/${c.serviceDeskId}/requesttype/${c.requestTypeId}/form`))
      )
        return offItsType(c);
      return c;
    });
    const live = kept.filter(Boolean);
    if (live.length !== made.length || live.some((c, i) => c !== made[i]))
      await kvs.set(briefKey(brief.id), { ...brief, created: live });
    return live;
  }

  /**
   * The plan with what Jira says now about portal groups: one list of request types per service
   * project that has a form on one. A project Jira cannot list keeps what the plan had.
   */
  async function planBriefs() {
    const briefs = await allBriefs();
    const desks = new Set();
    for (const b of briefs) for (const c of b.created ?? []) if (c.serviceDeskId && inPortal(c)) desks.add(c.serviceDeskId);
    if (desks.size === 0) return briefs;
    const types = new Map();
    await eachLimited([...desks], 4, async (desk) => {
      try {
        const list = await everyPage(
          (start) => route`/rest/servicedeskapi/servicedesk/${desk}/requesttype?start=${start}&limit=100`,
        );
        if (list.ok) for (const t of list.values) types.set(`${desk}/${t.id}`, t);
      } catch {
        // Shown as the plan had it.
      }
    });
    return Promise.all(
      briefs.map(async (b) => {
        const made = b.created ?? [];
        const now = made.map((c) => {
          const t = c.serviceDeskId && types.get(`${c.serviceDeskId}/${c.requestTypeId}`);
          return t ? withGroups(c, t) : c;
        });
        if (now.every((c, i) => c === made[i])) return b;
        const next = { ...b, created: now };
        await kvs.set(briefKey(b.id), next);
        return next;
      }),
    );
  }

  async function saveForm({ record }) {
    if (!wellFormed(record)) return fail('That is not a form record.');
    const { design, created: _never, ...detail } = record;

    let id = record.id;
    let before;
    for (let n = 2; n < 1000; n++) {
      before = await kvs.get(briefKey(id));
      if (!before || sameTemplate(before, record)) break;
      id = `${record.id.slice(0, 75)}-${n}`;
    }
    detail.id = id;

    if (bytes(design) > VALUE_BYTES)
      return fail(`This form is too large to keep: its design alone is ${Math.ceil(bytes(design) / 1024)} KB and Jira storage holds 240 KB per value.`);
    // A very large form keeps every field and loses the notes first, then the last fields.
    if (bytes(detail) > VALUE_BYTES) detail.fields = detail.fields.map(({ note, ...rest }) => rest);
    if (bytes(detail) > VALUE_BYTES) {
      const all = detail.fields.length;
      while (detail.fields.length > 0 && bytes(detail) > VALUE_BYTES)
        detail.fields = detail.fields.slice(0, Math.floor(detail.fields.length * 0.8));
      detail.fieldsOmitted = all - detail.fields.length;
    }
    if (bytes(detail) > VALUE_BYTES) return fail('This form is too large to keep.');

    const brief = briefOf(detail, before ? (before.created ?? []) : []);
    try {
      await kvs
        .transact()
        .set(briefKey(id), brief)
        .set(detailKey(id), detail)
        .set(designKey(id), design)
        .execute();
    } catch {
      return fail('Jira storage did not accept this form. Try again in a moment.');
    }
    return { ok: true, id };
  }

  async function getForm({ id }) {
    if (!ID.test(String(id))) return fail('Unknown form.');
    const [brief, detail] = await Promise.all([kvs.get(briefKey(id)), kvs.get(detailKey(id))]);
    if (!brief || !detail) return fail('This form is no longer in the plan.');
    const before = brief.created ?? [];
    const created = await stillInJira(brief);
    return {
      ok: true,
      form: { ...detail, created },
      ...((created.length !== before.length || created.some((c, i) => c !== before[i])) && { changed: true }),
    };
  }

  async function removeForms({ ids }) {
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => ID.test(String(id))))
      return fail('Unknown form.');
    // The plan row goes first, so a form is never listed without the rest of its record.
    await eachLimited(ids, 4, async (id) => {
      await kvs.delete(briefKey(id));
      await Promise.all([kvs.delete(detailKey(id)), kvs.delete(designKey(id))]);
    });
    return { ok: true, removed: ids.length };
  }

  async function listTargets() {
    const list = await everyPage((start) => route`/rest/servicedeskapi/servicedesk?start=${start}&limit=100`);
    if (!list.ok) return fail(`Jira did not list the service projects (status ${list.status}).`);
    return {
      ok: true,
      desks: list.values
        .map((d) => ({ id: String(d.id), projectKey: d.projectKey, projectName: d.projectName }))
        .sort((a, b) => a.projectName.localeCompare(b.projectName)),
    };
  }

  /** The service projects the person asking administers: the only ones they can add a form to. */
  async function ownTargets() {
    const all = await listTargets();
    if (!all.ok) return all;
    const desks = all.desks.slice(0, MOST_OFFERED);
    const answers = await eachLimited(desks, 4, (d) => administers(d.projectKey));
    if (desks.length > 0 && answers.every((a) => a === 'unknown')) return fail(NOT_SURE.error);
    return { ok: true, desks: desks.filter((_, i) => answers[i] === 'yes') };
  }

  async function listRequestTypes({ serviceDeskId }) {
    if (!DIGITS.test(String(serviceDeskId))) return fail('That is not a service project.');
    const desk = String(serviceDeskId);
    const list = await everyPage(
      (start) => route`/rest/servicedeskapi/servicedesk/${desk}/requesttype?start=${start}&limit=100`,
    );
    if (!list.ok) return fail(`Jira did not list the request types (status ${list.status}).`);
    // A request type shows one form in the portal, so say which ones already have theirs.
    const taken = await eachLimited(list.values, 6, async (t) => {
      try {
        const res = await jira.asApp(route`/forms/servicedesk/${desk}/requesttype/${t.id}/form`, {
          headers: HEADERS,
        });
        return res.status === 200;
      } catch {
        return false;
      }
    });
    return {
      ok: true,
      requestTypes: list.values.map((t, i) => ({
        id: String(t.id),
        name: t.name,
        portalId: String(t.portalId),
        hasForm: taken[i],
        ...(hiddenOf(t) === true && { hidden: true }),
      })),
    };
  }

  const noProject = (projectKey) =>
    fail(`Project ${projectKey} was not found, or it is not a service project.`);

  /** The service desk behind a project key. The key is the one the person was checked against. */
  async function deskOf(projectKey) {
    const all = await listTargets();
    if (!all.ok) return all;
    const desk = all.desks.find((d) => d.projectKey === projectKey);
    return desk ? { ok: true, desk } : noProject(projectKey);
  }

  /**
   * The work type a new request type gets. A request type cannot change it later, so the choice
   * follows the project: its plain "Service request" type when it has one, otherwise the work type
   * most of its request types already use.
   */
  async function workTypeFor(desk) {
    let ofProject = [];
    try {
      const res = await jira.asApp(route`/rest/api/3/project/${desk.projectKey}`, { headers: HEADERS });
      if (res.ok) ofProject = ((await json(res)).issueTypes ?? []).filter((t) => !t.subtask);
    } catch {
      // The request types below still say which work types the project uses.
    }
    const plain = ofProject.find((t) => /^(\[system\]\s*)?service request$/i.test(String(t.name).trim()));
    if (plain) return { id: String(plain.id), name: plain.name };

    const types = await everyPage(
      (start) => route`/rest/servicedeskapi/servicedesk/${desk.id}/requesttype?start=${start}&limit=100`,
    );
    const uses = new Map();
    for (const t of types.ok ? types.values : [])
      if (t.issueTypeId) uses.set(String(t.issueTypeId), (uses.get(String(t.issueTypeId)) ?? 0) + 1);
    const [most] = [...uses].sort((a, b) => b[1] - a[1]);
    const id = most?.[0] ?? (ofProject[0] && String(ofProject[0].id));
    if (!id) return undefined;
    return { id, name: ofProject.find((t) => String(t.id) === id)?.name };
  }

  /** Makes the request type a form is shown on, named after the form. */
  async function makeRequestType(desk, brief) {
    const workType = await workTypeFor(desk);
    if (!workType)
      return fail(`Project ${desk.projectKey} has no work type a request type can use. Nothing was created.`);
    const name = brief.name.slice(0, TYPE_NAME_MOST);
    const words = `Replaces the InfoPath form “${brief.name.slice(0, 200)}”.`;
    let res;
    try {
      res = await jira.asApp(route`/rest/servicedeskapi/servicedesk/${desk.id}/requesttype`, {
        method: 'POST',
        headers: { ...EXPERIMENTAL, 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueTypeId: workType.id, name, description: words, helpText: words }),
      });
    } catch {
      return fail('Jira did not answer. Check the project’s request types before trying again.');
    }
    const made = await json(res);
    if (!res.ok || !made.id) {
      const said = made.errorMessage ?? made.errors?.[0]?.message ?? made.message ?? '';
      return fail(
        res.status === 401 || res.status === 403
          ? `Jira did not let the app create a request type in ${desk.projectKey} (status ${res.status}). Nothing was created. A Jira administrator may still have to approve the app’s update under Settings, Apps, Manage apps.`
          : `Jira did not create the request type (status ${res.status}). Nothing was created. ${said}`.trim(),
      );
    }
    return {
      ok: true,
      type: {
        id: String(made.id),
        name: made.name ?? name,
        portalId: String(made.portalId ?? desk.id),
        made: true,
        // Jira puts a new request type in no portal group.
        hidden: hiddenOf(made) !== false,
        ...(workType.name && { workType: workType.name }),
      },
    };
  }

  /** A request type that exists already. It must belong to the project the person was checked on. */
  async function readRequestType(desk, requestTypeId) {
    let res;
    try {
      res = await jira.asApp(route`/rest/servicedeskapi/servicedesk/${desk.id}/requesttype/${requestTypeId}`, {
        headers: HEADERS,
      });
    } catch {
      return fail('Jira did not answer. Nothing was created. Try again in a moment.');
    }
    if (!res.ok)
      return fail(
        res.status === 404
          ? `That request type is not in project ${desk.projectKey}. Nothing was created.`
          : `Jira did not show the request type (status ${res.status}). Nothing was created.`,
      );
    const t = await json(res);
    return {
      ok: true,
      type: { id: String(requestTypeId), name: t.name, portalId: String(t.portalId ?? desk.id), hidden: hiddenOf(t) === true },
    };
  }

  /** Takes back a request type made a moment ago, when its form could not be created. */
  async function dropRequestType(desk, type) {
    try {
      const res = await jira.asApp(route`/rest/servicedeskapi/servicedesk/${desk.id}/requesttype/${type.id}`, {
        method: 'DELETE',
        headers: EXPERIMENTAL,
      });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  /**
   * @param requestTypeId   show the form on this request type, or
   * @param newRequestType  make a request type named after the form and show it there.
   *                        With neither, the form is saved in the project only.
   */
  async function createJsmForm({ formId, projectKey, requestTypeId, newRequestType = false, again = false }) {
    if (!ID.test(String(formId))) return fail('Unknown form.');
    if (!PROJECT_KEY.test(String(projectKey))) return fail('That is not a project key.');
    if (requestTypeId !== undefined && !DIGITS.test(String(requestTypeId)))
      return fail('That is not a request type.');
    if (requestTypeId !== undefined && newRequestType)
      return fail('Choose a new request type or an existing one, not both.');
    const [brief, design, detail] = await Promise.all([
      kvs.get(briefKey(formId)),
      kvs.get(designKey(formId)),
      kvs.get(detailKey(formId)),
    ]);
    if (!brief || !design)
      return fail('This form has not been analysed yet. Open InfoPath Afterlife in Jira settings and add its template.');
    const allowed = await administers(projectKey);
    if (allowed === 'unknown')
      return fail('Jira could not confirm who is asking, so nothing was created. Use the InfoPath Afterlife page in Jira settings.');
    if (allowed !== 'yes')
      return fail(`You need to administer project ${projectKey} to add a form to it.`, { notAdmin: true });

    const live = await stillInJira(brief);
    const earlier = live.find((c) => c.projectKey === projectKey);
    if (earlier && !again)
      return fail(
        `“${brief.name}” was already created in ${projectKey} on ${day(earlier.when)}. Nothing was created. To add a second copy, use the InfoPath Afterlife page in Jira settings.`,
        { duplicate: true },
      );

    // The request type the form is shown on, if any.
    let desk;
    let type;
    if (newRequestType || requestTypeId !== undefined) {
      const found = await deskOf(projectKey);
      if (!found.ok) return found;
      desk = found.desk;
      const got = newRequestType ? await makeRequestType(desk, brief) : await readRequestType(desk, requestTypeId);
      if (!got.ok) return got;
      type = got.type;
    }
    // A request type made here goes away again when its form cannot be created.
    const undo = async (error) => {
      if (!type?.made || (await dropRequestType(desk, type))) return fail(error);
      return fail(`${error} An empty request type “${type.name}” was left in ${projectKey}: delete it under Project settings, Request types.`);
    };

    const body = {
      design,
      ...(type && {
        publish: {
          portal: {
            portalRequestTypeIds: [Number(type.id)],
            submitOnCreate: true,
            validateOnCreate: true,
          },
        },
      }),
    };
    let res;
    try {
      res = await jira.asApp(route`/forms/project/${projectKey}/form`, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      return undo('Jira did not answer. Check the project’s forms before trying again.');
    }
    const made = await json(res);
    if (!res.ok || !made.id) {
      if (res.status === 404) return undo(noProject(projectKey).error);
      const said = made.errors?.[0]?.message ?? made.errorMessages?.[0] ?? made.message ?? made.raw ?? '';
      return undo(`Jira did not accept the form (status ${res.status}). ${said}`.trim());
    }

    const created = {
      projectKey,
      formId: made.id,
      ...(type && {
        requestTypeId: type.id,
        requestTypeName: type.name,
        portalId: type.portalId,
        serviceDeskId: desk.id,
        ...(type.made && { newRequestType: true }),
        ...(type.hidden && { hidden: true }),
      }),
      when: new Date(now()).toISOString(),
    };
    await kvs.set(briefKey(formId), { ...brief, created: [...live, created] });
    return {
      ok: true,
      ...created,
      name: brief.name,
      questions: brief.conversion.questions,
      formsPage: `/jira/servicedesk/projects/${projectKey}/settings/forms`,
      ...(type && {
        portalPath: portalPath(created),
        ...(type.hidden && { portalGroupsPage: groupsPage(projectKey) }),
      }),
      ...(type?.workType && { workType: type.workType }),
      needsAttention: detail?.attention ?? [],
    };
  }

  async function setSettings({ rovoAccess }) {
    if (rovoAccess !== 'everyone' && rovoAccess !== 'admins') return fail('Unknown setting.');
    await kvs.set(SETTINGS_KEY, { rovoAccess });
    return { ok: true, settings: { rovoAccess } };
  }

  // The admin page. Jira shows it to administrators only; the backend checks again, because it
  // acts with the app's own permissions.
  const forAdmins = (fn) => async (req) => {
    const answer = await isAdmin(req?.context?.accountId);
    // Nothing has run yet, so the page can simply ask again.
    if (answer === 'unknown')
      return fail('Jira could not confirm your permissions just now. Try again in a moment.', { retry: true });
    if (answer !== 'yes')
      return fail('Only Jira administrators can use InfoPath Afterlife.', { denied: true });
    try {
      return await fn(req.payload ?? {});
    } catch {
      return fail('Something went wrong on the Jira side. Try again in a moment.');
    }
  };

  const resolvers = {
    openPlan: forAdmins(async () => ({ ok: true, forms: await planBriefs(), settings: await settings() })),
    listForms: forAdmins(async () => ({ ok: true, forms: await planBriefs() })),
    getForm: forAdmins(getForm),
    saveForm: forAdmins(saveForm),
    removeForms: forAdmins(removeForms),
    listTargets: forAdmins(listTargets),
    listRequestTypes: forAdmins(listRequestTypes),
    createForm: forAdmins((p) =>
      createJsmForm({
        formId: p.id,
        projectKey: p.projectKey,
        requestTypeId: p.requestTypeId,
        newRequestType: p.newRequestType === true,
        again: p.again === true,
      }),
    ),
    setSettings: forAdmins(setSettings),
  };

  // Rovo actions: the agent, the skill and the MCP server share them.

  const NOT_FOR_YOU = {
    error:
      'On this site only Jira administrators can read the InfoPath migration plan. A Jira administrator can open it to everyone under Settings, Apps, InfoPath Afterlife.',
  };
  const OFFER = 'Use list-service-projects to offer the ones this person administers.';
  const nextStep = (c) =>
    `A project administrator adds the request type “${c.requestTypeName}” to a portal group: project settings, Portal, Portal groups, open a group, Add request form. Until then Jira keeps it out of the portal and people cannot send it.`;

  /** The site's address, so a link can be given in full. Without it the path alone is given. */
  let site;
  async function siteBase() {
    if (site === undefined) {
      try {
        const res = await jira.asApp(route`/rest/api/3/serverInfo`, { headers: HEADERS });
        const base = res.ok ? (await json(res)).baseUrl : undefined;
        if (typeof base === 'string' && /^https:\/\//.test(base)) site = base.replace(/\/+$/, '');
      } catch {
        // Asked again next time.
      }
    }
    return site ?? '';
  }
  /** What Rovo is told about the JSM forms made from one InfoPath form. */
  const madeForRovo = (created, base) =>
    (created ?? []).map((c) => ({
      project: c.projectKey,
      created: day(c.when),
      ...(c.requestTypeName && { requestType: c.requestTypeName }),
      ...(inPortal(c) && {
        state: c.hidden ? 'waiting for a portal group' : 'live in the portal',
        portalLink: `${base}${portalPath(c)}`,
      }),
      ...(isWaiting(c) && { nextStep: nextStep(c), portalGroupsPage: `${base}${groupsPage(c.projectKey)}` }),
    }));
  /** The answer to give instead of the plan, when this person may not read it. */
  async function closedTo(context) {
    if ((await settings()).rovoAccess !== 'admins') return undefined;
    const answer = await isAdmin(context?.principal?.accountId);
    return answer === 'yes' ? undefined : answer === 'no' ? NOT_FOR_YOU : NOT_SURE;
  }
  const noMatch = (wanted, found, briefs) =>
    found.many.length > 1
      ? {
          error: `More than one analysed form matches “${wanted ?? ''}”. Ask which one is meant.`,
          matchingForms: found.many.map((f) => ({ name: f.name, file: f.fileName })),
        }
      : {
          error: `No analysed form matches “${wanted ?? ''}”.`,
          knownForms: briefs.map((f) => f.name),
        };

  const actions = {
    async listLegacyForms(_payload, context) {
      const closed = await closedTo(context);
      if (closed) return closed;
      const forms = await planBriefs();
      if (forms.length === 0)
        return {
          forms: [],
          note: 'No InfoPath templates have been analysed yet. A Jira admin can add them in Settings, Apps, InfoPath Afterlife.',
        };
      const waves = { 1: 0, 2: 0, 3: 0 };
      for (const f of forms) waves[f.wave] += 1;
      return {
        total: forms.length,
        waves,
        waveRules: WAVE_WORDS,
        forms: forms.map((f) => ({
          name: f.name,
          file: f.fileName,
          wave: f.wave,
          fields: f.counts.fields,
          rules: f.counts.rules,
          dataConnections: f.counts.connections,
          ...(f.nativePercent !== undefined && { nativePercent: f.nativePercent }),
          ...(f.records !== undefined && { filledRecords: f.records }),
          causesOfDeath: f.causes.map((id) => CAUSE_WORDS[id] ?? id),
          jsmFormsCreated: (f.created ?? []).map((c) => c.projectKey),
          ...((f.created ?? []).some(isLive) && { liveInPortal: true }),
          ...((f.created ?? []).some(isWaiting) && { waitingForPortalGroup: true }),
          ...(f.sample && { bundledSample: true }),
        })),
      };
    },

    async getLegacyForm(payload, context) {
      const closed = await closedTo(context);
      if (closed) return closed;
      const briefs = await planBriefs();
      const found = find(briefs, payload?.form);
      if (!found.form) return noMatch(payload?.form, found, briefs);
      const f = await kvs.get(detailKey(found.form.id));
      if (!f) return noMatch(payload?.form, { many: [] }, briefs);
      const shown = f.fields.slice(0, 80);
      const omitted = f.fields.length - shown.length + (f.fieldsOmitted ?? 0);
      return {
        name: f.name,
        file: f.fileName,
        infoPathVersion: f.generation,
        filledInBrowser: f.browserCompatible,
        wave: f.wave,
        waveMeaning: WAVE_WORDS[f.wave],
        counts: f.counts,
        coverage: f.coverage,
        causesOfDeath: f.causes.map((c) => ({
          cause: CAUSE_WORDS[c.id] ?? c.id,
          date: c.date,
          evidence: c.evidence.map((e) => e.what),
          replacement: c.replacement,
          source: c.source?.url,
        })),
        conversion: f.conversion,
        needsAttention: f.attention,
        fields: shown.map((x) => ({
          label: x.label,
          infoPathControl: x.control,
          jsmQuestion: x.targetWords ?? 'none',
          status: x.status,
          ...(x.note && { note: x.note }),
        })),
        ...(omitted > 0 && { fieldsNotListedHere: omitted }),
        jsmFormsCreated: madeForRovo(found.form.created, await siteBase()),
      };
    },

    async createJsmForm(payload, context) {
      const closed = await closedTo(context);
      if (closed) return closed;
      const briefs = await allBriefs();
      const found = find(briefs, payload?.form);
      if (!found.form) return noMatch(payload?.form, found, briefs);
      const projectKey = String(payload?.projectKey ?? '').trim().toUpperCase();
      if (!projectKey)
        return { error: `No service project was named, so nothing was created. ${OFFER}` };
      const result = await createJsmForm({ formId: found.form.id, projectKey, newRequestType: true });
      if (result.ok)
        return {
          ok: true,
          name: result.name,
          project: result.projectKey,
          questions: result.questions,
          requestType: result.requestTypeName,
          ...(result.workType && { workType: result.workType }),
          liveInPortal: !result.hidden,
          portalLink: `${await siteBase()}${result.portalPath}`,
          ...(result.hidden && {
            nextStep: nextStep(result),
            portalGroupsPage: `${await siteBase()}${result.portalGroupsPage}`,
          }),
          needsAttention: result.needsAttention,
        };
      // A project that does not exist and one the person may not change get the same answer.
      if (result.notAdmin)
        return {
          error: `This person does not administer a service project with the key ${projectKey}, so nothing was created. ${OFFER}`,
        };
      return { error: result.error };
    },

    async listServiceProjects(_payload, context) {
      const closed = await closedTo(context);
      if (closed) return closed;
      const mine = await ownTargets();
      if (!mine.ok) return { error: mine.error };
      const serviceProjects = mine.desks.map((d) => ({ key: d.projectKey, name: d.projectName }));
      return serviceProjects.length > 0
        ? { serviceProjects }
        : {
            serviceProjects,
            note: 'This person administers no service project on this site, so they cannot create a JSM form. A project administrator can.',
          };
    },
  };

  return { resolvers, actions };
}
