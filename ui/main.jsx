import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as core from '../vendor/afterlife-core.mjs';
import { STATUS_WORDS, toJsmForm } from '../lib/convert.mjs';
import { summarise } from '../lib/summary.mjs';
import { enableTheme, invoke, open } from './bridge.js';

const SAMPLES = [
  '01-leave-request', '02-expense-report', '04-purchase-request', '05-new-hire-onboarding',
  '08-big-form', '12-vendor-onboarding', '16-equipment-loan', '20-course-evaluation',
  '44-contract-approval-task', '45-policy-acknowledgement', '46-vendor-onboarding-code',
];

const WAVE_WORDS = {
  1: 'Converts to a native JSM form as it is',
  2: 'Works; some parts are simplified in a native form',
  3: 'Has parts a person must replace by hand',
};
const CAUSE_WORDS = {
  'forms-services-spo': 'InfoPath Forms Services is removed from SharePoint Online',
  'infopath-client': 'InfoPath 2013 is out of support',
  'browser-xslt': 'Browsers stop running XSLT',
  'internal-sql': 'SQL connection inside the company network',
  'internal-service': 'Web service inside the company network',
  'code-behind': 'Code-behind',
  activex: 'ActiveX control',
  signatures: 'Digital signatures',
};
const ERROR_WORDS = {
  INTERNAL: 'The file could not be read.',
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function analyse(files, onProgress) {
  const inputs = [];
  for (const f of files) inputs.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  const result = await core.triageFiles(inputs);
  const byName = new Map();
  for (const f of inputs)
    if (f.name.toLowerCase().endsWith('.xsn') && !byName.has(f.name)) byName.set(f.name, f);
  const rows = result.rows.filter((r) => r.kind === 'form' && r.templateId === r.fileName);
  const errors = result.rows.filter((r) => r.kind === 'error');
  const ignored = inputs.filter((f) => !/\.(xsn|xml)$/i.test(f.name)).map((f) => f.name);
  const when = new Date().toISOString();
  let done = 0;
  for (const row of rows) {
    const template = await core.parseXsn(byName.get(row.fileName).bytes);
    const ir = core.buildFormIR(template);
    const record = summarise(row, ir, toJsmForm(template, ir, core), when);
    const saved = await invoke('saveForm', { record });
    if (!saved.ok) errors.push({ kind: 'error', fileName: row.fileName, code: 'INTERNAL', why: saved.error });
    onProgress(++done, rows.length);
  }
  return { saved: done, errors, ignored };
}

function Lozenge({ tone = 'neutral', children, title }) {
  return <span className={`lozenge lozenge-${tone}`} title={title}>{children}</span>;
}
const waveTone = { 1: 'success', 2: 'information', 3: 'warning' };
const statusTone = { converted: 'success', simplified: 'information', skipped: 'warning' };

function Summary({ forms }) {
  const waves = { 1: 0, 2: 0, 3: 0 };
  for (const f of forms) waves[f.wave] += 1;
  const made = forms.filter((f) => f.created.length > 0).length;
  return (
    <div className="summary" role="group" aria-label="Migration plan">
      <div className="stat"><b>{forms.length}</b><span>{forms.length === 1 ? 'form' : 'forms'} analysed</span></div>
      {[1, 2, 3].map((w) => (
        <div className="stat" key={w} title={WAVE_WORDS[w]}>
          <b>{waves[w]}</b><span>Wave {w}</span><small>{WAVE_WORDS[w]}</small>
        </div>
      ))}
      <div className="stat"><b>{made}</b><span>JSM {made === 1 ? 'form' : 'forms'} created</span></div>
    </div>
  );
}

function Plan({ forms, selected, onSelect }) {
  return (
    <div className="table-scroll">
      <table>
        <caption className="sr-only">Analysed InfoPath forms, in migration order</caption>
        <thead>
          <tr>
            <th scope="col">Form</th><th scope="col">Wave</th>
            <th scope="col" className="num">Fields</th><th scope="col" className="num">Rules</th>
            <th scope="col" className="num">Data connections</th>
            <th scope="col">What stops it</th><th scope="col">JSM form</th>
          </tr>
        </thead>
        <tbody>
          {forms.map((f) => (
            <tr key={f.id} className={f.id === selected ? 'selected' : undefined}>
              <th scope="row">
                <button className="link" onClick={() => onSelect(f.id)} aria-expanded={f.id === selected}>{f.name}</button>
                <small>{f.fileName} · InfoPath {f.generation}</small>
              </th>
              <td><Lozenge tone={waveTone[f.wave]} title={WAVE_WORDS[f.wave]}>Wave {f.wave}</Lozenge></td>
              <td className="num">{f.counts.fields}</td>
              <td className="num">{f.counts.rules}</td>
              <td className="num">{f.counts.connections}</td>
              <td>{plural(f.causes.length, 'cause')}</td>
              <td>{f.created.length > 0
                ? <Lozenge tone="success">Created in {[...new Set(f.created.map((c) => c.projectKey))].join(', ')}</Lozenge>
                : <span className="subtle">Not yet</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Certificate({ form }) {
  return (
    <section aria-labelledby="cert-h">
      <h3 id="cert-h">Death certificate</h3>
      <p className="subtle">Only causes with evidence in the template are listed.</p>
      <ul className="causes">
        {form.causes.map((c) => (
          <li key={c.id}>
            <div className="cause-head">
              <b>{CAUSE_WORDS[c.id] ?? c.id}</b>
              <Lozenge tone={c.date === '—' ? 'neutral' : 'danger'}>{c.date === '—' ? 'No date: never worked from the cloud' : c.date}</Lozenge>
            </div>
            {c.evidence.map((e, i) => <p key={i} className="evidence">{e.what} <code>{e.where}</code></p>)}
            <p><span className="subtle">Replaced by:</span> {c.replacement}</p>
            {c.source && <button className="link" onClick={() => open(c.source.url)}>{c.source.title}</button>}
          </li>
        ))}
      </ul>
      <p className="subtle">Workflows attached outside the form cannot be detected from the file. Ask the library owner.</p>
    </section>
  );
}

function FieldMap({ form }) {
  const { conversion: s } = form;
  return (
    <section aria-labelledby="map-h">
      <h3 id="map-h">What the JSM form will contain</h3>
      <p>
        {plural(s.questions, 'question')}: {s.converted} controls converted as they are, {s.simplified} simplified, {s.skipped} not converted.
      </p>
      {form.attention.length > 0 && (
        <div className="callout" role="note">
          <b>Needs your attention</b>
          <ul>{form.attention.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}
      <div className="table-scroll">
        <table className="compact">
          <thead><tr><th scope="col">InfoPath field</th><th scope="col">Control</th><th scope="col">JSM question</th><th scope="col">Result</th><th scope="col">Note</th></tr></thead>
          <tbody>
            {form.fields.map((x, i) => (
              <tr key={i}>
                <th scope="row">{x.label}<small><code>{x.path}</code></small></th>
                <td>{x.control}</td>
                <td>{x.targetWords ?? '—'}</td>
                <td><Lozenge tone={statusTone[x.status]}>{STATUS_WORDS[x.status]}</Lozenge></td>
                <td className="note">{x.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Create({ form, desks, onCreated }) {
  const [desk, setDesk] = useState('');
  const [types, setTypes] = useState(null);
  const [type, setType] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    setType('');
    setTypes(null);
    if (!desk) return;
    let live = true;
    invoke('listRequestTypes', { serviceDeskId: desk }).then((r) => live && setTypes(r.requestTypes));
    return () => { live = false; };
  }, [desk]);

  const target = desks.find((d) => d.id === desk);
  const chosen = types?.find((t) => t.id === type);
  const create = async () => {
    setBusy(true);
    setResult(null);
    const r = await invoke('createForm', { id: form.id, projectKey: target.projectKey, ...(type && { requestTypeId: type }) })
      .catch(() => ({ ok: false, error: 'Jira did not answer. Check the project’s forms before trying again.' }));
    setBusy(false);
    setResult(r.ok ? { ...r, portalId: chosen?.portalId, requestTypeName: chosen?.name } : r);
    if (r.ok) onCreated();
  };

  return (
    <section aria-labelledby="create-h" className="create">
      <h3 id="create-h">Create the JSM form</h3>
      <div className="fields">
        <label>Service project
          <select value={desk} onChange={(e) => setDesk(e.target.value)}>
            <option value="">Choose a project…</option>
            {desks.map((d) => <option key={d.id} value={d.id}>{d.projectName} ({d.projectKey})</option>)}
          </select>
        </label>
        <label>Show it in the portal on
          <select value={type} onChange={(e) => setType(e.target.value)} disabled={!types}>
            <option value="">{desk && !types ? 'Loading request types…' : 'No request type yet (save as a form only)'}</option>
            {(types ?? []).map((t) => <option key={t.id} value={t.id} disabled={t.hasForm}>{t.name}{t.hasForm ? ' (already has a form)' : ''}</option>)}
          </select>
        </label>
        <button className="primary" disabled={!target || busy} onClick={create}>{busy ? 'Creating…' : 'Create JSM form'}</button>
      </div>
      <div aria-live="polite">
        {result?.ok && (
          <div className="callout success">
            <b>“{result.name}” is now a JSM form in {result.projectKey}</b>
            <p>{plural(result.questions, 'question')} created{result.requestTypeName ? `, shown in the portal on “${result.requestTypeName}”` : ''}.</p>
            <p className="actions">
              <button className="link" onClick={() => open(result.formsPage)}>Open the project’s forms</button>
              {result.portalId && <button className="link" onClick={() => open(`/servicedesk/customer/portal/${result.portalId}/create/${result.requestTypeId}`)}>Open it in the portal</button>}
            </p>
          </div>
        )}
        {result && !result.ok && <div className="callout danger" role="alert"><b>The form was not created</b><p>{result.error}</p></div>}
      </div>
      {form.created.length > 0 && (
        <p className="subtle">Already created: {form.created.map((c) => `${c.projectKey} on ${c.when.slice(0, 10)}`).join('; ')}.</p>
      )}
    </section>
  );
}

function Detail({ id, desks, onChanged, onClose }) {
  const [form, setForm] = useState(null);
  const load = useCallback(() => invoke('getForm', { id }).then((r) => setForm(r.ok ? r.form : null)), [id]);
  useEffect(() => { setForm(null); load(); }, [load]);
  const heading = useRef(null);
  useEffect(() => { if (form) heading.current?.focus(); }, [form?.id]);
  if (!form) return <div className="detail"><p className="subtle">Loading…</p></div>;
  return (
    <article className="detail" aria-labelledby="detail-h">
      <header>
        <div>
          <h2 id="detail-h" tabIndex={-1} ref={heading}>{form.name}</h2>
          <p className="subtle">
            {form.fileName}{form.version ? ` · version ${form.version}` : ''} · InfoPath {form.generation} · {form.browserCompatible ? 'filled in a browser' : 'filled in the InfoPath client'}
            {form.records !== undefined ? ` · ${plural(form.records, 'filled record')}` : ''}
          </p>
        </div>
        <div className="actions">
          <Lozenge tone={waveTone[form.wave]}>Wave {form.wave}: {WAVE_WORDS[form.wave]}</Lozenge>
          <button onClick={async () => { await invoke('removeForm', { id }); onChanged(); onClose(); }}>Remove from the plan</button>
          <button onClick={onClose}>Close</button>
        </div>
      </header>
      <Create form={form} desks={desks} onCreated={() => { load(); onChanged(); }} />
      <div className="columns">
        <Certificate form={form} />
        <FieldMap form={form} />
      </div>
    </article>
  );
}

function App() {
  const [forms, setForms] = useState(null);
  const [desks, setDesks] = useState([]);
  const [selected, setSelected] = useState(null);
  const [progress, setProgress] = useState(null);
  const [report, setReport] = useState(null);
  const [over, setOver] = useState(false);
  const input = useRef(null);

  const [down, setDown] = useState(false);
  const reload = useCallback(
    () => invoke('listForms').then((r) => { setForms(r.forms); setDown(false); }).catch(() => setDown(true)),
    [],
  );
  useEffect(() => {
    enableTheme();
    reload();
    invoke('listTargets').then((r) => setDesks(r.desks)).catch(() => setDesks([]));
  }, [reload]);

  const take = async (files) => {
    if (files.length === 0) return;
    setReport(null);
    setProgress({ done: 0, total: files.filter((f) => /\.xsn$/i.test(f.name)).length });
    try {
      const r = await analyse(files, (done, total) => setProgress({ done, total }));
      setReport(r);
    } catch (e) {
      setReport({ saved: 0, errors: [{ fileName: 'These files', code: 'INTERNAL' }], ignored: [] });
    }
    setProgress(null);
    await reload();
  };
  const samples = async () => {
    setProgress({ done: 0, total: SAMPLES.length });
    const files = [];
    for (const name of SAMPLES) {
      const res = await fetch(`./samples/${name}.xsn`);
      files.push(new File([await res.arrayBuffer()], `${name}.xsn`));
    }
    await take(files);
  };
  const exportCsv = async () => {
    const lines = [['Form', 'File', 'Wave', 'Fields', 'Rules', 'Data connections', 'Causes', 'JSM form created in'],
      ...forms.map((f) => [f.name, f.fileName, f.wave, f.counts.fields, f.counts.rules, f.counts.connections, f.causes.join(' '), f.created.map((c) => c.projectKey).join(' ')])];
    const csv = lines.map((l) => l.map((c) => core.csvCell(String(c))).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'infopath-migration-plan.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const sorted = useMemo(() => forms ?? [], [forms]);
  return (
    <main>
      <header className="top">
        <h1>InfoPath Afterlife</h1>
        <p>
          Microsoft’s end date for InfoPath was July 14, 2026. Add your templates to see what each form needs, then
          turn it into a Jira Service Management form in one step. Rovo can answer questions about every form you add.
        </p>
        <p className="subtle">Templates are read in your browser and never uploaded. Only the analysis and the form design are saved to this Jira site.</p>
      </header>

      <section
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take([...e.dataTransfer.files]); }}
      >
        <p><b>Drop InfoPath templates here</b> (.xsn files; add filled .xml records to count them)</p>
        <div className="actions">
          <button className="primary" onClick={() => input.current.click()} disabled={Boolean(progress)}>Choose files</button>
          <button onClick={samples} disabled={Boolean(progress)}>Try the {SAMPLES.length} sample forms</button>
          <input ref={input} type="file" multiple accept=".xsn,.xml" hidden onChange={(e) => { take([...e.target.files]); e.target.value = ''; }} />
        </div>
        <div aria-live="polite" className="status">
          {progress && <p>Reading… {progress.done} of {progress.total}</p>}
          {report && !progress && (
            <>
              {report.saved > 0 && <p>{plural(report.saved, 'form')} analysed and saved.</p>}
              {report.saved === 0 && report.errors.length === 0 && <p>No InfoPath template (.xsn) was found in those files.</p>}
              {report.errors.map((e, i) => (
                <p key={i} className="error" role="alert"><b>{e.fileName}</b> could not be read ({e.code}). {e.why ?? ERROR_WORDS[e.code] ?? 'It may be damaged or not an InfoPath template.'}</p>
              ))}
              {report.ignored.length > 0 && <p>Skipped {plural(report.ignored.length, 'file')} (not .xsn or .xml): {report.ignored.slice(0, 5).join(', ')}{report.ignored.length > 5 ? '…' : ''}</p>}
            </>
          )}
        </div>
      </section>

      {down && <p className="error" role="alert">The plan could not be loaded from Jira. Reload the page to try again.</p>}
      {forms === null && !down && <p className="subtle">Loading the plan…</p>}
      {forms !== null && forms.length === 0 && <p className="empty">No forms yet. Add your templates, or try the sample forms to see how it works.</p>}
      {sorted.length > 0 && (
        <>
          <div className="plan-head">
            <h2>Migration plan</h2>
            <button onClick={exportCsv}>Export plan (CSV)</button>
          </div>
          <Summary forms={sorted} />
          <Plan forms={sorted} selected={selected} onSelect={(id) => setSelected(id === selected ? null : id)} />
        </>
      )}
      {selected && <Detail key={selected} id={selected} desks={desks} onChanged={reload} onClose={() => setSelected(null)} />}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
