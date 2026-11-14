// Development only (`npm run dev`): answers the admin page's calls without Jira, so the page can
// be worked on in a plain browser. It runs the real backend logic over an in-memory Jira.
// Never part of the deployed bundle.
//   ?as=guest     the person is not a Jira administrator
//   ?desks=none   the site has no service project
import { createBackend } from '../src/plan.mjs';
import { fakeForge } from '../lib/fake-forge.mjs';

const params = new URLSearchParams(location.search);
const forge = fakeForge({
  admin: params.get('as') !== 'guest',
  ...(params.get('desks') === 'none' && { desks: [] }),
});
const backend = createBackend(forge);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function invoke(name, payload) {
  await wait(name === 'createForm' ? 900 : 120);
  const fn = backend.resolvers[name];
  if (!fn) throw new Error(`stand-in has no ${name}`);
  return fn({ payload, context: { accountId: 'dev' } });
}

// Opening a project's portal groups stands for the step an administrator takes there: every
// request type of that project that is in no group is put in one.
export const open = (url) => {
  console.log('open', url);
  const m = String(url).match(/\/projects\/([^/]+)\/settings\/portal-settings\/portal-groups$/);
  const desk = m && forge.state.desks.find((d) => d.projectKey === m[1]);
  for (const t of (desk && forge.state.requestTypes[desk.id]) || [])
    if (t.groupIds?.length === 0) forge.addToPortalGroup(desk.id, t.id);
};

export const enableTheme = () => undefined;

export const siteUrl = async () => 'https://your-site.atlassian.net';
