// An in-memory stand-in for Forge storage and the Jira REST calls the backend makes. The tests
// and `npm run dev` use it. It is never part of the deployed app.

const VALUE_LIMIT = 240 * 1024;

export function fakeForge(options = {}) {
  const state = {
    admin: true,
    // true, false, or the keys of the projects the caller administers.
    projectAdmin: true,
    // Set to false to act like a caller Jira cannot identify.
    knownUser: true,
    // How many of the next permission checks Jira fails with a server error.
    permissionFailures: 0,
    pageSize: 100,
    desks: [
      { id: '4', projectKey: 'HR', projectName: 'Human Resources' },
      { id: '5', projectKey: 'FAC', projectName: 'Facilities' },
    ],
    requestTypes: {
      4: [
        { id: '40', name: 'Employee offboarding', portalId: '4', issueTypeId: '10002', groupIds: ['20'] },
        { id: '39', name: 'Employee onboarding', portalId: '4', issueTypeId: '10002', groupIds: ['20'] },
        { id: '42', name: 'Questions for HR', portalId: '4', issueTypeId: '10001', groupIds: ['12'] },
      ],
      5: [
        { id: '50', name: 'Report a fault', portalId: '5', issueTypeId: '10011', groupIds: ['30'] },
        { id: '51', name: 'Book a room', portalId: '5', issueTypeId: '10012', groupIds: ['30'] },
        { id: '52', name: 'Order a key', portalId: '5', issueTypeId: '10012', groupIds: ['30'] },
      ],
    },
    // The work types of each project. HR has Jira's plain service request; Facilities does not.
    issueTypes: {
      HR: [
        { id: '10002', name: 'Task', subtask: false },
        { id: '10003', name: 'Sub-task', subtask: true },
        { id: '10001', name: '[System] Service request', subtask: false },
      ],
      FAC: [
        { id: '10011', name: 'Fault', subtask: false },
        { id: '10012', name: 'Facilities request', subtask: false },
      ],
    },
    // Request types that already show a form in the portal.
    taken: new Set(['4/39']),
    // Set to false to act like a site that has not approved the app's request-type permission.
    canMakeTypes: true,
    // Set to true to have Jira refuse every new form, and every request type taken back.
    refuseForms: false,
    refuseDeletes: false,
    // Set to true to have Jira fail every list of request types.
    failTypeLists: false,
    calls: [],
    ...options,
  };
  const store = new Map();
  const jiraForms = new Map();
  let made = 0;
  let madeTypes = 100;

  const put = (key, value) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > VALUE_LIMIT)
      throw new Error(`value for ${key} is over the storage limit`);
    store.set(key, structuredClone(value));
  };
  const kvs = {
    get: async (key) => structuredClone(store.get(key)),
    set: async (key, value) => put(key, value),
    delete: async (key) => void store.delete(key),
    query() {
      let prefix = '';
      let size = 10;
      let from = 0;
      const q = {
        where: (_field, condition) => ((prefix = condition.prefix), q),
        limit: (n) => ((size = n), q),
        cursor: (c) => ((from = Number(c)), q),
        async getMany() {
          const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
          const page = keys.slice(from, from + size);
          return {
            results: page.map((key) => ({ key, value: structuredClone(store.get(key)) })),
            nextCursor: from + size < keys.length ? String(from + size) : undefined,
          };
        },
      };
      return q;
    },
    transact() {
      const steps = [];
      const t = {
        set: (key, value) => (steps.push(() => put(key, value)), t),
        delete: (key) => (steps.push(() => store.delete(key)), t),
        async execute() {
          const before = new Map(store);
          try {
            for (const step of steps) step();
          } catch (e) {
            store.clear();
            for (const [k, v] of before) store.set(k, v);
            throw e;
          }
        },
      };
      return t;
    },
  };

  const where = { beginsWith: (prefix) => ({ prefix }) };
  const route = (strings, ...values) =>
    strings.reduce((out, s, i) => out + s + (i < values.length ? encodeURIComponent(values[i]) : ''), '');
  const reply = (status, body = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  const pageOf = (all, url) => {
    const start = Number(url.searchParams.get('start') ?? 0);
    const values = all.slice(start, start + state.pageSize);
    return reply(200, { values, isLastPage: start + values.length >= all.length });
  };

  const jira = {
    async asUser(path) {
      state.calls.push(`user ${path}`);
      if (!state.knownUser) throw new Error('no user');
      const url = new URL(path, 'https://jira.test');
      if (url.pathname === '/rest/api/3/mypermissions') {
        if (state.permissionFailures > 0) {
          state.permissionFailures -= 1;
          return reply(503);
        }
        const wanted = url.searchParams.get('permissions');
        const mine = state.projectAdmin;
        const have =
          wanted === 'ADMINISTER'
            ? state.admin
            : Array.isArray(mine) ? mine.includes(url.searchParams.get('projectKey')) : mine;
        return reply(200, { permissions: { [wanted]: { havePermission: have } } });
      }
      return reply(404);
    },
    async asApp(path, init = {}) {
      state.calls.push(`app ${init.method ?? 'GET'} ${path}`);
      const url = new URL(path, 'https://jira.test');
      const p = url.pathname;
      let m;
      if (p === '/rest/servicedeskapi/servicedesk') return pageOf(state.desks, url);
      if (p === '/rest/api/3/serverInfo') return reply(200, { baseUrl: 'https://jira.test' });
      if ((m = p.match(/^\/rest\/api\/3\/project\/([^/]+)$/)))
        return state.issueTypes[m[1]] ? reply(200, { key: m[1], issueTypes: state.issueTypes[m[1]] }) : reply(404);
      if ((m = p.match(/^\/rest\/servicedeskapi\/servicedesk\/(\d+)\/requesttype$/))) {
        const types = state.requestTypes[m[1]];
        if (!types) return reply(404);
        if (init.method !== 'POST') return state.failTypeLists ? reply(503) : pageOf(types, url);
        if (init.headers?.['X-ExperimentalApi'] !== 'opt-in') return reply(404);
        if (!state.canMakeTypes) return reply(401, { message: 'Unauthorized; scope does not match' });
        const body = JSON.parse(init.body);
        if (!body.name || body.name.length > 255 || !body.issueTypeId)
          return reply(400, { errorMessage: 'Request name and work type must not be empty.' });
        const type = { id: String(++madeTypes), name: body.name, description: body.description, helpText: body.helpText, issueTypeId: body.issueTypeId, portalId: m[1], groupIds: [] };
        types.push(type);
        return reply(201, type);
      }
      if ((m = p.match(/^\/rest\/servicedeskapi\/servicedesk\/(\d+)\/requesttype\/(\d+)$/))) {
        const types = state.requestTypes[m[1]] ?? [];
        const at = types.findIndex((t) => t.id === m[2]);
        if (at < 0) return reply(404);
        if (init.method !== 'DELETE') return reply(200, types[at]);
        if (state.refuseDeletes) return reply(403);
        types.splice(at, 1);
        state.taken.delete(`${m[1]}/${m[2]}`);
        return reply(204);
      }
      if ((m = p.match(/^\/forms\/servicedesk\/(\d+)\/requesttype\/(\d+)\/form$/)))
        return reply(state.taken.has(`${m[1]}/${m[2]}`) ? 200 : 404);
      if ((m = p.match(/^\/forms\/project\/([^/]+)\/form$/)) && init.method === 'POST') {
        const desk = state.desks.find((d) => d.projectKey === m[1]);
        if (!desk) return reply(404, { errors: [{ message: 'No such project.' }] });
        const body = JSON.parse(init.body);
        if (!body.design?.questions) return reply(400, { errors: [{ message: 'The design has no questions.' }] });
        if (state.refuseForms) return reply(400, { errors: [{ message: 'The form is not valid.' }] });
        const id = `00000000-0000-4000-8000-${String(++made).padStart(12, '0')}`;
        jiraForms.set(`${m[1]}/${id}`, body);
        for (const t of body.publish?.portal?.portalRequestTypeIds ?? []) state.taken.add(`${desk.id}/${t}`);
        return reply(200, { id });
      }
      if ((m = p.match(/^\/forms\/project\/([^/]+)\/form\/([^/]+)$/)))
        return reply(jiraForms.has(`${m[1]}/${m[2]}`) ? 200 : 404);
      return reply(404);
    },
  };

  /** What a project administrator does in Jira's portal settings: the app itself cannot. */
  const addToPortalGroup = (deskId, requestTypeId, groupId = '12') => {
    const type = state.requestTypes[deskId].find((t) => t.id === String(requestTypeId));
    type.groupIds = [...new Set([...(type.groupIds ?? []), groupId])];
  };

  return { kvs, where, route, jira, state, store, jiraForms, addToPortalGroup };
}
