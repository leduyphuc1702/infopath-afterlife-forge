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

  /** The JSM forms made from this form that are still in Jira. Deleted ones leave the record. */
  async function stillInJira(brief) {
    const made = brief.created ?? [];
    if (made.length === 0) return made;
    const there = await eachLimited(made, 4, async (c) => {
      try {
        const res = await jira.asApp(route`/forms/project/${c.projectKey}/form/${c.formId}`, {
          headers: HEADERS,
        });
        return res.status !== 404;
      } catch {
        return true;
      }
    });
    const live = made.filter((_, i) => there[i]);
    if (live.length !== made.length) await kvs.set(briefKey(brief.id), { ...brief, created: live });
    return live;
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
    const created = await stillInJira(brief);
    return {
      ok: true,
      form: { ...detail, created },
      ...(created.length !== (brief.created ?? []).length && { changed: true }),
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
      })),
    };
  }

  async function createJsmForm({ formId, projectKey, requestTypeId, again = false }) {
    if (!ID.test(String(formId))) return fail('Unknown form.');
    if (!PROJECT_KEY.test(String(projectKey))) return fail('That is not a project key.');
    if (requestTypeId !== undefined && !DIGITS.test(String(requestTypeId)))
      return fail('That is not a request type.');
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

    const body = {
      design,
      ...(requestTypeId !== undefined && {
        publish: {
          portal: {
            portalRequestTypeIds: [Number(requestTypeId)],
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
      return fail('Jira did not answer. Check the project’s forms before trying again.');
    }
    const made = await json(res);
    if (!res.ok || !made.id) {
      if (res.status === 404)
        return fail(`Project ${projectKey} was not found, or it is not a service project.`);
      const said = made.errors?.[0]?.message ?? made.errorMessages?.[0] ?? made.message ?? made.raw ?? '';
      return fail(`Jira did not accept the form (status ${res.status}). ${said}`.trim());
    }

    const created = {
      projectKey,
      formId: made.id,
      ...(requestTypeId !== undefined && { requestTypeId: String(requestTypeId) }),
      when: new Date(now()).toISOString(),
    };
    await kvs.set(briefKey(formId), { ...brief, created: [...live, created] });
    return {
      ok: true,
      ...created,
      name: brief.name,
      questions: brief.conversion.questions,
      formsPage: `/jira/servicedesk/projects/${projectKey}/settings/forms`,
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
    openPlan: forAdmins(async () => ({ ok: true, forms: await allBriefs(), settings: await settings() })),
    listForms: forAdmins(async () => ({ ok: true, forms: await allBriefs() })),
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
      const forms = await allBriefs();
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
          ...(f.sample && { bundledSample: true }),
        })),
      };
    },

    async getLegacyForm(payload, context) {
      const closed = await closedTo(context);
      if (closed) return closed;
      const briefs = await allBriefs();
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
        jsmFormsCreated: found.form.created ?? [],
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
      const result = await createJsmForm({ formId: found.form.id, projectKey });
      if (result.ok) return result;
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
