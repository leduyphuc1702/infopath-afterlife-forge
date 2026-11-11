import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const PREFIX = 'form:';
const keyOf = (id) => `${PREFIX}${id}`;
const ID = /^[a-z0-9-]{1,80}$/;

const fail = (message) => ({ ok: false, error: message });

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

async function allForms() {
  const out = [];
  let cursor;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith(PREFIX)).limit(100);
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany();
    out.push(...page.results.map((r) => r.value));
    cursor = page.nextCursor;
  } while (cursor);
  return out.sort((a, b) => a.wave - b.wave || a.name.localeCompare(b.name));
}

/** What the plan needs about one form: no design, no field list. */
const brief = (f) => ({
  id: f.id,
  name: f.name,
  fileName: f.fileName,
  generation: f.generation,
  browserCompatible: f.browserCompatible,
  wave: f.wave,
  counts: f.counts,
  coverage: f.coverage,
  nativePercent: f.nativePercent,
  records: f.records,
  causes: f.causes.map((c) => c.id),
  conversion: f.conversion,
  created: f.created ?? [],
  analysedAt: f.analysedAt,
});

function find(forms, wanted) {
  const q = String(wanted ?? '').trim().toLowerCase();
  if (!q) return undefined;
  const slug = q.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (
    forms.find((f) => f.id === slug || f.name.toLowerCase() === q) ??
    forms.find((f) => f.fileName.toLowerCase() === q) ??
    forms.find((f) => f.name.toLowerCase().includes(q) || f.id.includes(slug))
  );
}

/**
 * The person asking must administer the project: the app itself could, but they might not.
 * Returns 'yes', 'no', or 'unknown' when Jira gives no user to ask as. Only 'yes' creates.
 */
async function administers(projectKey) {
  let res;
  try {
    res = await api
      .asUser()
      .requestJira(
        route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=ADMINISTER_PROJECTS`,
        { headers: { Accept: 'application/json' } },
      );
  } catch {
    return 'unknown';
  }
  if (!res.ok) return 'no';
  const body = await json(res);
  return body?.permissions?.ADMINISTER_PROJECTS?.havePermission === true ? 'yes' : 'no';
}

async function serviceDesks() {
  const res = await api.asApp().requestJira(route`/rest/servicedeskapi/servicedesk?limit=100`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return [];
  return ((await json(res)).values ?? []).map((d) => ({
    id: d.id,
    projectKey: d.projectKey,
    projectName: d.projectName,
  }));
}

async function createJsmForm({ formId, projectKey, requestTypeId }) {
  if (!ID.test(String(formId))) return fail('Unknown form.');
  if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(String(projectKey))) return fail('That is not a project key.');
  if (requestTypeId !== undefined && !/^\d+$/.test(String(requestTypeId)))
    return fail('That is not a request type.');
  const record = await kvs.get(keyOf(formId));
  if (!record) return fail('This form has not been analysed yet. Open InfoPath Afterlife in Jira settings and add its template.');
  const allowed = await administers(projectKey);
  if (allowed === 'unknown')
    return fail('Jira could not confirm who is asking, so nothing was created. Use the InfoPath Afterlife page in Jira settings.');
  if (allowed !== 'yes')
    return fail(`You need to administer project ${projectKey} to add a form to it.`);

  const body = {
    design: record.design,
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
  const res = await api.asApp().requestJira(route`/forms/project/${projectKey}/form`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const made = await json(res);
  if (!res.ok || !made.id)
    return fail(`Jira did not accept the form (status ${res.status}). ${made.errors?.[0]?.message ?? made.raw ?? ''}`.trim());

  const created = {
    projectKey,
    formId: made.id,
    ...(requestTypeId !== undefined && { requestTypeId: String(requestTypeId) }),
    when: new Date().toISOString(),
  };
  await kvs.set(keyOf(formId), { ...record, created: [...(record.created ?? []), created] });
  return {
    ok: true,
    ...created,
    name: record.name,
    questions: record.conversion.questions,
    formsPage: `/jira/servicedesk/projects/${projectKey}/settings/forms`,
    needsAttention: record.attention,
  };
}

// ---------------------------------------------------------------------------------------------
// The admin page

const resolver = new Resolver();

resolver.define('listForms', async () => ({ forms: (await allForms()).map(brief) }));

resolver.define('getForm', async ({ payload }) => {
  if (!ID.test(String(payload?.id))) return fail('Unknown form.');
  const record = await kvs.get(keyOf(payload.id));
  if (!record) return fail('Unknown form.');
  const { design, ...rest } = record;
  return { ok: true, form: rest };
});

resolver.define('saveForm', async ({ payload }) => {
  const r = payload?.record;
  if (!r || !ID.test(String(r.id)) || typeof r.name !== 'string' || !r.design?.questions)
    return fail('That is not a form record.');
  if (JSON.stringify(r).length > 230_000) return fail('This form is too large to keep.');
  const before = await kvs.get(keyOf(r.id));
  await kvs.set(keyOf(r.id), { ...r, created: before?.created ?? [] });
  return { ok: true };
});

resolver.define('removeForm', async ({ payload }) => {
  if (!ID.test(String(payload?.id))) return fail('Unknown form.');
  await kvs.delete(keyOf(payload.id));
  return { ok: true };
});

resolver.define('listTargets', async () => ({ desks: await serviceDesks() }));

resolver.define('listRequestTypes', async ({ payload }) => {
  if (!/^\d+$/.test(String(payload?.serviceDeskId))) return { requestTypes: [] };
  const desk = String(payload.serviceDeskId);
  const res = await api
    .asApp()
    .requestJira(route`/rest/servicedeskapi/servicedesk/${desk}/requesttype?limit=100`, {
      headers: { Accept: 'application/json' },
    });
  if (!res.ok) return { requestTypes: [] };
  const types = (await json(res)).values ?? [];
  // A request type shows one form in the portal, so say which ones already have theirs.
  const taken = await Promise.all(
    types.map(async (t) => {
      const f = await api
        .asApp()
        .requestJira(route`/forms/servicedesk/${desk}/requesttype/${t.id}/form`, {
          headers: { Accept: 'application/json' },
        });
      return f.status === 200;
    }),
  );
  return {
    requestTypes: types.map((t, i) => ({
      id: t.id,
      name: t.name,
      portalId: t.portalId,
      hasForm: taken[i],
    })),
  };
});

resolver.define('createForm', async ({ payload }) =>
  createJsmForm({
    formId: payload?.id,
    projectKey: payload?.projectKey,
    requestTypeId: payload?.requestTypeId,
  }),
);

export const handler = resolver.getDefinitions();

// ---------------------------------------------------------------------------------------------
// Rovo actions (the agent and the MCP server share them)

const WAVE_WORDS = {
  1: 'Wave 1: converts to a native JSM form as it is',
  2: 'Wave 2: works, with some parts simplified in the native JSM form',
  3: 'Wave 3: has parts a person must replace by hand',
};

export async function listLegacyForms() {
  const forms = await allForms();
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
      wave: f.wave,
      fields: f.counts.fields,
      rules: f.counts.rules,
      dataConnections: f.counts.connections,
      nativePercent: f.nativePercent,
      filledRecords: f.records,
      causesOfDeath: f.causes.map((c) => c.id),
      jsmFormsCreated: (f.created ?? []).map((c) => c.projectKey),
    })),
  };
}

export async function getLegacyForm(payload) {
  const forms = await allForms();
  const f = find(forms, payload?.form);
  if (!f)
    return {
      error: `No analysed form matches “${payload?.form ?? ''}”.`,
      knownForms: forms.map((x) => x.name),
    };
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
      id: c.id,
      date: c.date,
      evidence: c.evidence.map((e) => e.what),
      replacement: c.replacement,
      source: c.source?.url,
    })),
    conversion: f.conversion,
    needsAttention: f.attention,
    fields: f.fields.slice(0, 80).map((x) => ({
      label: x.label,
      infoPathControl: x.control,
      jsmQuestion: x.targetWords ?? 'none',
      status: x.status,
      ...(x.note && { note: x.note }),
    })),
    jsmFormsCreated: f.created ?? [],
  };
}

export async function createJsmFormAction(payload) {
  const forms = await allForms();
  const f = find(forms, payload?.form);
  if (!f)
    return {
      error: `No analysed form matches “${payload?.form ?? ''}”.`,
      knownForms: forms.map((x) => x.name),
    };
  const projectKey = String(payload?.projectKey ?? '').trim().toUpperCase();
  const result = await createJsmForm({ formId: f.id, projectKey });
  return result.ok ? result : { error: result.error };
}
