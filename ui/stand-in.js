// Development only (`npm run dev`): answers the admin page's calls without Jira, so the page can
// be worked on in a plain browser. Never part of the deployed bundle.
const forms = new Map();
const desks = [
  { id: '4', projectKey: 'HR', projectName: 'Human Resources' },
  { id: '5', projectKey: 'FAC', projectName: 'Facilities' },
];
const types = [
  { id: '40', name: 'Employee offboarding', portalId: '4', hasForm: false },
  { id: '39', name: 'Employee onboarding', portalId: '4', hasForm: true },
  { id: '42', name: 'Questions for HR', portalId: '4', hasForm: false },
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = ({ design, fields, attention, ...f }) => ({ ...f, causes: f.causes.map((c) => c.id) });

export async function invoke(name, payload) {
  await wait(120);
  switch (name) {
    case 'listForms':
      return { forms: [...forms.values()].sort((a, b) => a.wave - b.wave || a.name.localeCompare(b.name)).map(brief) };
    case 'getForm': {
      const { design, ...form } = forms.get(payload.id);
      return { ok: true, form };
    }
    case 'saveForm':
      forms.set(payload.record.id, { ...payload.record, created: forms.get(payload.record.id)?.created ?? [] });
      return { ok: true };
    case 'removeForm':
      forms.delete(payload.id);
      return { ok: true };
    case 'listTargets':
      return { desks };
    case 'listRequestTypes':
      return { requestTypes: types };
    case 'createForm': {
      const f = forms.get(payload.id);
      const created = { projectKey: payload.projectKey, formId: 'stand-in', when: new Date().toISOString(), ...(payload.requestTypeId && { requestTypeId: payload.requestTypeId }) };
      f.created.push(created);
      return { ok: true, ...created, name: f.name, questions: f.conversion.questions, formsPage: '#forms', needsAttention: f.attention };
    }
    default:
      throw new Error(`stand-in has no ${name}`);
  }
}

export const open = (url) => console.log('open', url);

export const enableTheme = () => undefined;
