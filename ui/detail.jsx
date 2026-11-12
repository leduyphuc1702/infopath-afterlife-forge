// One form, opened: create the JSM form, the death certificate, and the field map.
import { useCallback, useEffect, useRef, useState } from 'react';
import { STATUS_WORDS } from '../lib/convert.mjs';
import { words } from './ask.js';
import { open } from './bridge.js';
import { Icon } from './icons.jsx';
import { ask } from './jira.js';
import { ConfirmButton, dayWords, Hint, IconButton, Lozenge, plural, statusTone, waveTone } from './parts.jsx';
import { CAUSE_WORDS, WAVE_SHORT, WAVE_WORDS } from './words.js';

/** Evidence that says the same thing is shown once; where each was found goes in the tooltip. */
function proofs(evidence) {
  const places = new Map();
  for (const e of evidence) places.set(e.what, [...(places.get(e.what) ?? []), e.where]);
  return [...places];
}

function Certificate({ form }) {
  return (
    <section aria-labelledby="cert-h">
      <div className="heading sub">
        <h3 id="cert-h">Death certificate</h3>
        <Hint>Only causes with evidence in the template are listed. Workflows attached outside the form cannot be detected from the file: ask the library owner.</Hint>
      </div>
      {form.causes.length === 0 && <p>Nothing in this template stops it from being moved.</p>}
      <ul className="causes">
        {form.causes.map((c) => (
          <li key={c.id}>
            <div className="cause-head">
              <b>{CAUSE_WORDS[c.id] ?? c.id}</b>
              <Lozenge tone={c.date === '—' ? 'neutral' : 'danger'} tip={c.date === '—' ? 'No end date: this never worked from the cloud' : 'The date it stops working'}>
                {c.date === '—' ? 'Never in the cloud' : c.date}
              </Lozenge>
            </div>
            {proofs(c.evidence).map(([what, places]) => (
              <p key={what} className="evidence">{what} <code data-tip={places.join('\n')}>{places[0].split(' ')[0]}</code></p>
            ))}
            <p className="fix">
              <Icon name="arrow" /><span className="sr-only">Replaced by: </span><span>{c.replacement}</span>
              {c.source && (
                <button className="link" data-tip={c.source.title} onClick={() => open(c.source.url)}>
                  Source<Icon name="external" size={12} />
                </button>
              )}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FieldMap({ form }) {
  const { conversion: s } = form;
  return (
    <section aria-labelledby="map-h">
      <div className="heading sub">
        <h3 id="map-h">The JSM form: {plural(s.questions, 'question')}</h3>
        <Hint>Only the default view is converted, and section titles become headings. JSM forms have no repeating rows, calculations or rule actions, so those parts are simplified. Lists filled from a data source arrive empty. Filled records are counted, not imported.</Hint>
      </div>
      <p className="tally">
        <Lozenge tone="success" tip="Controls carried over as they are">{s.converted} converted</Lozenge>
        <Lozenge tone="information" tip="Controls that work in a simpler shape">{s.simplified} simplified</Lozenge>
        <Lozenge tone="warning" tip="Controls with no place in a JSM form">{s.skipped} not converted</Lozenge>
      </p>
      {form.attention.length > 0 && (
        <div className="callout" role="note">
          <b>Needs your attention</b>
          <ul>{form.attention.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}
      <div className="table-scroll">
        <table className="compact">
          <caption className="sr-only">What happens to each InfoPath field</caption>
          <thead><tr><th scope="col">InfoPath field</th><th scope="col">JSM question</th><th scope="col">Result</th></tr></thead>
          <tbody>
            {form.fields.map((x, i) => (
              <tr key={i}>
                <th scope="row"><span data-tip={x.path}>{x.label}</span><small>{x.control}</small></th>
                <td>{x.targetWords ?? <span className="subtle">None</span>}</td>
                <td className="result">
                  <Lozenge tone={statusTone[x.status]}>{STATUS_WORDS[x.status]}</Lozenge>
                  {x.note && <Hint>{x.note}</Hint>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {form.fieldsOmitted > 0 && (
        <p className="subtle">{plural(form.fieldsOmitted, 'more field')} not listed here. The JSM form still gets every question.</p>
      )}
    </section>
  );
}

const NO_TYPES = { status: 'idle', list: [] };

function Create({ form, targets, deskId, onDesk, onRetryTargets, onCreated }) {
  const [types, setTypes] = useState(NO_TYPES);
  const [type, setType] = useState('');
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const desks = targets?.desks ?? [];
  // A site with one service project needs no choice; otherwise the last choice comes back.
  const desk = desks.some((d) => d.id === deskId) ? deskId : desks.length === 1 ? desks[0].id : '';

  useEffect(() => {
    setType('');
    if (!desk) {
      setTypes(NO_TYPES);
      return undefined;
    }
    let live = true;
    setTypes({ status: 'loading', list: [] });
    ask('listRequestTypes', { serviceDeskId: desk })
      .then((r) => live && setTypes({ status: 'ready', list: r.requestTypes }))
      .catch((e) => live && setTypes({ status: 'error', list: [], error: words(e) }));
    return () => { live = false; };
  }, [desk, round]);

  const target = desks.find((d) => d.id === desk);
  const chosen = types.list.find((t) => t.id === type);
  const earlier = target ? form.created.filter((c) => c.projectKey === target.projectKey) : [];
  const create = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await ask('createForm', {
        id: form.id,
        projectKey: target.projectKey,
        ...(type && { requestTypeId: type }),
        ...(earlier.length > 0 && { again: true }),
      });
      setResult({ ...r, portalId: chosen?.portalId, requestTypeName: chosen?.name });
      setRound((n) => n + 1);
      onCreated();
    } catch (e) {
      setResult({ ok: false, error: words(e) });
    }
    setBusy(false);
  };

  return (
    <section aria-labelledby="create-h" className="create">
      <h3 id="create-h" className="sr-only">Create the JSM form</h3>
      {targets === null && <p className="subtle">Loading your service projects…</p>}
      {targets?.error && (
        <div className="callout danger" role="alert">
          <b>Your service projects could not be listed</b>
          <p>{targets.error} <button className="link" onClick={onRetryTargets}>Try again</button></p>
        </div>
      )}
      {targets?.desks && desks.length === 0 && (
        <p>This site has no service project yet. Create one in Jira Service Management, then reload this page.</p>
      )}
      {desks.length > 0 && (
        <div className="fields">
          <div className="field">
            <label htmlFor="create-desk">Service project</label>
            <select id="create-desk" value={desk} onChange={(e) => { onDesk(e.target.value); setResult(null); }} disabled={busy}>
              <option value="">Choose a project…</option>
              {desks.map((d) => <option key={d.id} value={d.id}>{d.projectName} ({d.projectKey})</option>)}
            </select>
          </div>
          <div className="field">
            <span>
              <label htmlFor="create-type">Request type</label>
              <Hint>Pick a request type to show the form in your customer portal. Without one, the form is saved in the project only. A request type holds one form.</Hint>
            </span>
            <select id="create-type" value={type} onChange={(e) => setType(e.target.value)} disabled={types.status !== 'ready' || busy}>
              <option value="">{types.status === 'loading' ? 'Loading…' : 'None: save as a form only'}</option>
              {types.list.map((t) => <option key={t.id} value={t.id} disabled={t.hasForm}>{t.name}{t.hasForm ? ' (already has a form)' : ''}</option>)}
            </select>
          </div>
          <button className={earlier.length > 0 ? undefined : 'primary'} disabled={!target || busy || types.status === 'loading'} onClick={create}>
            <Icon name="plus" />{busy ? 'Creating…' : earlier.length > 0 ? 'Create another copy' : 'Create JSM form'}
          </button>
        </div>
      )}
      {types.status === 'error' && (
        <p className="error" role="alert">{types.error} The form can still be created without a request type. <button className="link" onClick={() => setRound((n) => n + 1)}>Try again</button></p>
      )}
      {earlier.length > 0 && !busy && !result?.ok && (
        <p className="warn"><Icon name="warning" />Already in {target.projectKey} since {dayWords(earlier[0].when)}. Creating it again adds a second copy.</p>
      )}
      <div aria-live="polite">
        {busy && <p className="sr-only">Jira is building the form. This takes a few seconds.</p>}
        {result?.ok && (
          <div className="callout success">
            <b><Icon name="check" />“{result.name}” is now a JSM form in {result.projectKey}</b>
            <p>
              {plural(result.questions, 'question')}{result.requestTypeName ? `, shown in the portal on “${result.requestTypeName}”` : ''}.
              {form.attention.length > 0 ? ' Go through “Needs your attention” below before customers use it.' : ''}
            </p>
            <p className="actions">
              {result.portalId && <button className="link" onClick={() => open(`/servicedesk/customer/portal/${result.portalId}/create/${result.requestTypeId}`)}>Open it in the portal<Icon name="external" size={12} /></button>}
              <button className="link" onClick={() => open(result.formsPage)}>Open the project’s forms<Icon name="external" size={12} /></button>
            </p>
          </div>
        )}
        {result && !result.ok && <div className="callout danger" role="alert"><b>The form was not created</b><p>{result.error}</p></div>}
      </div>
      {form.created.length > 0 && !result?.ok && (
        <ul className="made" aria-label="JSM forms created from this form">
          {form.created.map((c) => (
            <li key={c.formId}>
              <button
                className="link" data-tip={`Created on ${dayWords(c.when)}${c.requestTypeId ? ', shown in the portal' : ''}. Opens the project’s forms.`}
                onClick={() => open(`/jira/servicedesk/projects/${c.projectKey}/settings/forms`)}
              >
                <Icon name="check" size={12} /><span className="sr-only">Created in </span>{c.projectKey}<Icon name="external" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Detail({ id, targets, deskId, onDesk, onRetryTargets, onChanged, onClose }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try {
      const r = await ask('getForm', { id });
      setForm(r.form);
      setError(null);
      if (r.changed) onChanged();
    } catch (e) {
      setError(words(e));
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const heading = useRef(null);
  useEffect(() => {
    if (!form) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
  }, [form?.id]);

  if (error && !form)
    return (
      <div className="detail">
        <div className="callout danger" role="alert"><b>This form could not be opened</b><p>{error}</p></div>
        <div className="actions"><button onClick={load}>Try again</button><button onClick={onClose}>Close</button></div>
      </div>
    );
  if (!form) return <div className="detail"><p className="subtle">Opening the form…</p></div>;
  const facts = [
    `${form.fileName}${form.version ? `, version ${form.version}` : ''}`,
    `InfoPath ${form.generation}, ${form.browserCompatible ? 'filled in a browser' : 'filled in the InfoPath client'}`,
    `${plural(form.counts.fields, 'field')}, ${plural(form.counts.rules, 'rule')}, ${plural(form.counts.connections, 'data connection')}`,
    ...(form.records !== undefined ? [plural(form.records, 'filled record')] : []),
    `Analysed ${dayWords(form.analysedAt)}`,
  ].join('\n');
  return (
    <article className="detail" aria-labelledby="detail-h" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <header>
        <div className="title">
          <h2 id="detail-h" tabIndex={-1} ref={heading}>{form.name}</h2>
          <Lozenge tone={waveTone[form.wave]} tip={WAVE_WORDS[form.wave]}>Wave {form.wave} · {WAVE_SHORT[form.wave]}</Lozenge>
          <Hint>{facts}</Hint>
        </div>
        <div className="actions">
          <ConfirmButton
            icon="trash"
            label="Remove from the plan"
            question="Remove this form from the plan?"
            note={form.created.length > 0 ? 'The JSM forms already created stay in Jira.' : undefined}
            confirm="Remove"
            working="Removing…"
            onConfirm={async () => { await ask('removeForms', { ids: [id] }); onChanged(); onClose(); }}
          />
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
      </header>
      <Create form={form} targets={targets} deskId={deskId} onDesk={onDesk} onRetryTargets={onRetryTargets} onCreated={() => { load(); onChanged(); }} />
      <Certificate form={form} />
      <FieldMap form={form} />
    </article>
  );
}
