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
        { id: '40', name: 'Employee offboarding', portalId: '4' },
        { id: '39', name: 'Employee onboarding', portalId: '4' },
        { id: '42', name: 'Questions for HR', portalId: '4' },
      ],
      5: [{ id: '50', name: 'Report a fault', portalId: '5' }],
    },
    // Request types that already show a form in the portal.
    taken: new Set(['4/39']),
    calls: [],
    ...options,
  };
  const store = new Map();
  const jiraForms = new Map();
  let made = 0;

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
      if ((m = p.match(/^\/rest\/servicedeskapi\/servicedesk\/(\d+)\/requesttype$/)))
        return state.requestTypes[m[1]] ? pageOf(state.requestTypes[m[1]], url) : reply(404);
      if ((m = p.match(/^\/forms\/servicedesk\/(\d+)\/requesttype\/(\d+)\/form$/)))
        return reply(state.taken.has(`${m[1]}/${m[2]}`) ? 200 : 404);
      if ((m = p.match(/^\/forms\/project\/([^/]+)\/form$/)) && init.method === 'POST') {
        const desk = state.desks.find((d) => d.projectKey === m[1]);
        if (!desk) return reply(404, { errors: [{ message: 'No such project.' }] });
        const body = JSON.parse(init.body);
        if (!body.design?.questions) return reply(400, { errors: [{ message: 'The design has no questions.' }] });
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

  return { kvs, where, route, jira, state, store, jiraForms };
}
