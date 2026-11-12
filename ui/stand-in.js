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

export const open = (url) => console.log('open', url);

export const enableTheme = () => undefined;
