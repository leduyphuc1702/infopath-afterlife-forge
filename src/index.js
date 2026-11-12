import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { createBackend } from './plan.mjs';

// The logic lives in plan.mjs. This file only hands it the real Jira and the real storage.
const backend = createBackend({
  kvs,
  where: WhereConditions,
  route,
  jira: {
    asUser: (path, init) => api.asUser().requestJira(path, init),
    asApp: (path, init) => api.asApp().requestJira(path, init),
  },
  warn: (line) => console.warn(line),
});

const resolver = new Resolver();
for (const [name, fn] of Object.entries(backend.resolvers)) resolver.define(name, fn);
export const handler = resolver.getDefinitions();

export const listLegacyForms = (payload, context) => backend.actions.listLegacyForms(payload, context);
export const getLegacyForm = (payload, context) => backend.actions.getLegacyForm(payload, context);
export const createJsmFormAction = (payload, context) => backend.actions.createJsmForm(payload, context);
export const listServiceProjects = (payload, context) => backend.actions.listServiceProjects(payload, context);
