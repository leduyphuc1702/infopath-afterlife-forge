import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as core from '../vendor/afterlife-core.mjs';
import { analyse } from './analyse.js';
import { Problem, words } from './ask.js';
import { enableTheme } from './bridge.js';
import { Detail } from './detail.jsx';
import { fromDrop, fromInput } from './files.js';
import { Icon } from './icons.jsx';
import { ask } from './jira.js';
import { ConfirmButton, Hint, IconButton, Lozenge, Panel, plural, some, waveTone } from './parts.jsx';
import { installTips } from './tips.js';
import { CAUSE_WORDS, GUIDE, SAMPLES, STEPS, WAVE_SHORT, WAVE_WORDS } from './words.js';

/* global APP_VERSION */

// The service project chosen last time, so the next form needs one click less. Jira may refuse
// the page its own storage; then the choice simply lasts until the page is closed.
const memory = {
  get(key) {
    try { return localStorage.getItem(`afterlife.${key}`) ?? ''; } catch { return ''; }
  },
  set(key, value) {
    try { localStorage.setItem(`afterlife.${key}`, value); } catch { /* nothing to do */ }
  },
};

/** The three steps a newcomer takes. It goes away once the first JSM form exists. */
function Stepper({ step }) {
  return (
    <ol className="stepper" aria-label="Getting started">
      {STEPS.map(([title, tip], i) => {
        const state = i + 1 < step ? 'done' : i + 1 === step ? 'now' : 'next';
        return (
          <li key={title} className={state} aria-current={state === 'now' ? 'step' : undefined}>
            <span className="dot">{state === 'done' ? <Icon name="check" /> : i + 1}</span>
            <b>{title}</b>
            {state === 'done' && <span className="sr-only"> (done)</span>}
            <Hint>{tip}</Hint>
          </li>
        );
      })}
    </ol>
  );
}

function Summary({ forms, filter, onFilter }) {
  const waves = { 1: 0, 2: 0, 3: 0 };
  for (const f of forms) waves[f.wave] += 1;
  const made = forms.filter((f) => f.created.length > 0).length;
  const all = filter.wave === '' && filter.made === '';
  return (
    <div className="summary" role="group" aria-label="The plan in numbers. Each number filters the list.">
      <button className="chip" aria-pressed={all} onClick={() => onFilter({ ...filter, wave: '', made: '' })}>
        <b>{forms.length}</b>{forms.length === 1 ? 'form' : 'forms'}
      </button>
      {[1, 2, 3].map((w) => (
        <button
          key={w} className={`chip wave-${w}`} aria-pressed={filter.wave === String(w)} data-tip={`${WAVE_WORDS[w]}. Click to show only these.`}
          onClick={() => onFilter({ ...filter, wave: filter.wave === String(w) ? '' : String(w) })}
        >
          <b>{waves[w]}</b><span>Wave {w}<small>{WAVE_SHORT[w]}</small></span>
        </button>
      ))}
      <button
        className="chip made-chip" aria-pressed={filter.made === 'yes'} data-tip="Forms that already have a JSM form. Click to show only these."
        onClick={() => onFilter({ ...filter, made: filter.made === 'yes' ? '' : 'yes' })}
      >
        <b>{made}</b>created
      </button>
    </div>
  );
}

const SORTS = {
  wave: (a, b) => a.wave - b.wave || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  fields: (a, b) => a.counts.fields - b.counts.fields,
  causes: (a, b) => a.causes.length - b.causes.length,
  made: (a, b) => b.created.length - a.created.length,
};

function Head({ id, sort, onSort, className, tip, children }) {
  const active = sort.key === id;
  return (
    <th scope="col" className={className} aria-sort={active ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined}>
      <button className="sort" data-tip={tip} onClick={() => onSort(id)}>
        {children}<span aria-hidden="true">{active ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}</span>
      </button>
    </th>
  );
}

function Plan({ forms, selected, onSelect, sort, onSort, onClearFilter }) {
  const head = { sort, onSort };
  return (
    <div className="table-scroll">
      <table className="plan">
        <caption className="sr-only">Analysed InfoPath forms. Column headers sort the table; a row opens the form.</caption>
        <thead>
          <tr>
            <Head id="name" {...head}>Form</Head>
            <Head id="wave" tip="1: converts as it is. 2: works, with some parts simplified. 3: has parts to replace by hand." {...head}>Wave</Head>
            <Head id="fields" className="num" {...head}>Fields</Head>
            <Head id="causes" tip="What stops the form from working today" {...head}>Blockers</Head>
            <Head id="made" {...head}>JSM form</Head>
            <td />
          </tr>
        </thead>
        <tbody>
          {forms.length === 0 && (
            <tr className="plain"><td colSpan={6} className="none">No form matches. <button className="link" onClick={onClearFilter}>Show all forms</button></td></tr>
          )}
          {forms.map((f) => {
            const causes = f.causes.map((c) => CAUSE_WORDS[c] ?? c);
            return (
              <tr key={f.id} className={f.id === selected ? 'selected' : undefined} onClick={() => onSelect(f.id)}>
                <th scope="row">
                  <button id={`open-${f.id}`} className="link" aria-expanded={f.id === selected} onClick={(e) => { e.stopPropagation(); onSelect(f.id); }}>{f.name}</button>
                  {f.sample && <Lozenge tip="One of the sample forms that come with the app">Sample</Lozenge>}
                  <small>{f.fileName}</small>
                </th>
                <td><Lozenge tone={waveTone[f.wave]} tip={WAVE_WORDS[f.wave]}>Wave {f.wave}</Lozenge></td>
                <td className="num">{f.counts.fields}</td>
                <td>
                  {causes.length > 0
                    ? <span className="blockers" data-tip={causes.join('\n')}><Icon name="warning" />{causes.length}<span className="sr-only">: {causes.join('; ')}</span></span>
                    : <span className="subtle">None</span>}
                </td>
                <td>
                  {f.created.length > 0
                    ? <Lozenge tone="success"><Icon name="check" size={12} />{[...new Set(f.created.map((c) => c.projectKey))].join(', ')}</Lozenge>
                    : <span className="subtle">Not yet</span>}
                </td>
                <td className="go"><Icon name="chevron" /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RovoAccess({ settings, onSaved, onClose }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const choose = async (rovoAccess) => {
    if (rovoAccess === settings.rovoAccess) return;
    setBusy(true);
    setNote(null);
    try {
      onSaved((await ask('setSettings', { rovoAccess })).settings);
      setNote({ text: 'Saved.' });
    } catch (e) {
      setNote({ text: words(e), error: true });
    }
    setBusy(false);
  };
  const option = (value, title, text) => (
    <span className="choice">
      <label>
        <input type="radio" name="rovo-access" checked={settings.rovoAccess === value} onChange={() => choose(value)} />
        {title}
      </label>
      <Hint>{text}</Hint>
    </span>
  );
  return (
    <Panel title="Who can ask Rovo about these forms" onClose={onClose}>
      <fieldset disabled={busy}>
        <legend className="sr-only">Who can ask Rovo about these forms</legend>
        {option('everyone', 'Everyone who can use Rovo', 'The Rovo agent and the MCP server answer questions about the plan. Creating a form still needs the person asking to administer the project.')}
        {option('admins', 'Jira administrators only', 'Everyone else is told to ask an administrator. Choose this when form names, field names or server names should stay with administrators.')}
      </fieldset>
      <p aria-live="polite" className={note?.error ? 'error' : 'subtle'}>{note?.text}</p>
    </Panel>
  );
}

function Guide({ onClose }) {
  return (
    <Panel
      title="What converts, and what does not"
      hint="Only the default view of a form is converted, and section titles become headings. JSM forms have no repeating rows, calculations or rule actions, so those parts are simplified, and each form says which ones under “Needs your attention”. Lists filled from a data source arrive empty. Filled records are counted, not imported."
      onClose={onClose}
    >
      <div className="table-scroll">
        <table className="compact">
          <thead><tr><th scope="col">In InfoPath</th><th scope="col">In the JSM form</th></tr></thead>
          <tbody>{GUIDE.map(([from, to]) => <tr key={from}><th scope="row">{from}</th><td>{to}</td></tr>)}</tbody>
        </table>
      </div>
    </Panel>
  );
}

function downloadCsv(forms) {
  const lines = [
    ['Form', 'File', 'Wave', 'Fields', 'Rules', 'Data connections', 'Filled records', 'Causes', 'JSM questions', 'Controls converted', 'Controls simplified', 'Controls not converted', 'JSM form created in', 'Analysed'],
    ...forms.map((f) => [
      f.name, f.fileName, f.wave, f.counts.fields, f.counts.rules, f.counts.connections, f.records ?? '',
      f.causes.map((c) => CAUSE_WORDS[c] ?? c).join('; '),
      f.conversion.questions, f.conversion.converted, f.conversion.simplified, f.conversion.skipped,
      f.created.map((c) => `${c.projectKey} (${c.when.slice(0, 10)})`).join('; '),
      f.analysedAt.slice(0, 10),
    ]),
  ];
  // The leading mark makes Excel read the file as UTF-8.
  const csv = `\ufeff${lines.map((l) => l.map((c) => core.csvCell(String(c))).join(',')).join('\r\n')}\r\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'infopath-migration-plan.csv';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function Report({ report }) {
  if (report.failed) return <p className="error" role="alert">{report.failed}</p>;
  return (
    <>
      {report.saved > 0 && <p className="done"><Icon name="check" />{plural(report.saved, 'form')} added to the plan</p>}
      {report.templates === 0 && <p>No InfoPath template (.xsn) was found in those files.</p>}
      {report.errors.slice(0, 5).map((e, i) => (
        <p key={i} className="error" role="alert">
          <b>{e.fileName}</b> was not added. {e.why ?? `It may be damaged or not an InfoPath template${e.code ? ` (${e.code})` : ''}.`}
        </p>
      ))}
      {report.errors.length > 5 && <p className="error">{plural(report.errors.length - 5, 'more file')} could not be added either.</p>}
      {report.tooLarge.length > 0 && <p>Left out {plural(report.tooLarge.length, 'file')} over 50 MB: {some(report.tooLarge)}.</p>}
      {report.skipped.length > 0 && <p>Left out {plural(report.skipped.length, 'file')} that {report.skipped.length === 1 ? 'is' : 'are'} not .xsn or .xml: {some(report.skipped)}.</p>}
    </>
  );
}

function Status({ progress, report }) {
  return (
    <div aria-live="polite" className="status">
      {progress && (
        <p className="reading">
          <progress aria-label="Reading the templates" {...(progress.total > 0 && { value: progress.done, max: progress.total })} />
          {progress.total > 0 ? `Reading ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : 'Opening the files…'}
        </p>
      )}
      {report && !progress && <Report report={report} />}
    </div>
  );
}

const NO_FILTER = { text: '', wave: '', made: '' };
const carriesFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

function App() {
  const [forms, setForms] = useState(null);
  const [settings, setSettings] = useState(null);
  const [targets, setTargets] = useState(null);
  const [problem, setProblem] = useState(null);
  const [selected, setSelected] = useState(null);
  const [progress, setProgress] = useState(null);
  const [report, setReport] = useState(null);
  const [over, setOver] = useState(false);
  const [panel, setPanel] = useState(null);
  const [deskId, setDeskId] = useState(() => memory.get('desk'));
  const [filter, setFilter] = useState(NO_FILTER);
  const [sort, setSort] = useState({ key: 'wave', dir: 1 });
  const files = useRef(null);
  const folder = useRef(null);

  const fault = (e) => setProblem({ text: words(e), denied: e.denied === true });
  const loadTargets = useCallback(() => {
    setTargets(null);
    ask('listTargets').then((r) => setTargets({ desks: r.desks })).catch((e) => setTargets({ error: words(e) }));
  }, []);
  // The plan is asked for from several places. Only the newest answer is shown, so a slow old
  // one cannot put back a list that has changed since.
  const asked = useRef(0);
  const showPlan = useCallback(async (call, then) => {
    const mine = ++asked.current;
    try {
      const r = await ask(call);
      if (mine !== asked.current) return;
      setForms(r.forms);
      setProblem(null);
      then?.(r);
    } catch (e) {
      if (mine === asked.current) fault(e);
    }
  }, []);
  const openPlan = useCallback(
    () => showPlan('openPlan', (r) => { setSettings(r.settings); loadTargets(); }),
    [showPlan, loadTargets],
  );
  const reload = useCallback(() => showPlan('listForms'), [showPlan]);
  useEffect(() => {
    enableTheme();
    installTips();
    openPlan();
  }, [openPlan]);

  const take = async (list, sample = false) => {
    setReport(null);
    setProgress({ done: 0, total: 0 });
    let added;
    try {
      added = await analyse(await list, { core, ask, sample, onProgress: (done, total) => setProgress({ done, total }) });
      setReport(added);
    } catch (e) {
      if (e.denied) fault(e);
      else setReport({ failed: words(e) });
    }
    setProgress(null);
    await reload();
    // One form added: there is nothing to choose from, so it opens.
    if (added?.ids.length === 1) setSelected(added.ids[0]);
  };
  const samples = () =>
    take(
      Promise.all(
        SAMPLES.map(async (name) => {
          const res = await fetch(`./samples/${name}.xsn`).catch(() => undefined);
          if (!res?.ok) throw new Problem('The sample forms could not be loaded. Reload the page and try again.');
          return { name: `${name}.xsn`, file: new File([await res.arrayBuffer()], `${name}.xsn`) };
        }),
      ),
      true,
    );
  const close = () => {
    const id = selected;
    setSelected(null);
    requestAnimationFrame(() => document.getElementById(`open-${id}`)?.focus());
  };
  const toggle = (name) => setPanel((now) => (now === name ? null : name));
  const shut = () => {
    const name = panel;
    setPanel(null);
    requestAnimationFrame(() => document.getElementById(`panel-${name}`)?.focus());
  };
  const chooseDesk = (id) => {
    setDeskId(id);
    memory.set('desk', id);
  };

  const all = forms ?? [];
  const sampleIds = all.filter((f) => f.sample).map((f) => f.id);
  const made = all.filter((f) => f.created.length > 0).length;
  const filtered = filter.text !== '' || filter.wave !== '' || filter.made !== '';
  const shown = useMemo(() => {
    const q = filter.text.trim().toLowerCase();
    return all
      .filter((f) => !q || f.name.toLowerCase().includes(q) || f.fileName.toLowerCase().includes(q))
      .filter((f) => !filter.wave || String(f.wave) === filter.wave)
      .filter((f) => !filter.made || f.created.length > 0)
      .sort((a, b) => sort.dir * SORTS[sort.key](a, b) || SORTS.wave(a, b));
  }, [forms, filter, sort]);
  const busy = Boolean(progress);

  if (problem?.denied)
    return (
      <main>
        <div className="callout danger" role="alert">
          <b>This page is for Jira administrators</b>
          <p>{problem.text}</p>
        </div>
      </main>
    );

  const pickers = (
    <>
      <input ref={files} type="file" multiple accept=".xsn,.xml" hidden onChange={(e) => { take(fromInput(e.target.files)); e.target.value = ''; }} />
      <input ref={folder} type="file" webkitdirectory="" hidden onChange={(e) => { take(fromInput(e.target.files)); e.target.value = ''; }} />
    </>
  );

  return (
    <main
      className={over ? 'over' : undefined}
      onDragOver={(e) => { if (!carriesFiles(e)) return; e.preventDefault(); if (!busy) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => { if (!carriesFiles(e)) return; e.preventDefault(); setOver(false); if (!busy) take(fromDrop(e.dataTransfer)); }}
    >
      <header className="top">
        <div className="heading">
          <h1>Move InfoPath forms to Jira Service Management</h1>
          <Hint>Microsoft’s end date for InfoPath was July 14, 2026. Add your templates to see what each form needs, then turn it into a Jira Service Management form in one click. Rovo can answer questions about every form you add.</Hint>
        </div>
        {forms !== null && (
          <div className="actions">
            <IconButton id="panel-guide" icon="swap" label="What converts, and what does not" aria-expanded={panel === 'guide'} onClick={() => toggle('guide')} />
            {settings && <IconButton id="panel-rovo" icon="sliders" label="Who can ask Rovo about these forms" aria-expanded={panel === 'rovo'} onClick={() => toggle('rovo')} />}
          </div>
        )}
      </header>
      {panel === 'guide' && <Guide onClose={shut} />}
      {panel === 'rovo' && <RovoAccess settings={settings} onSaved={setSettings} onClose={shut} />}

      {problem && (
        <div className="callout danger" role="alert">
          <b>The plan could not be loaded</b>
          <p>{problem.text} <button className="link" onClick={forms === null ? openPlan : reload}>Try again</button></p>
        </div>
      )}
      {forms === null && !problem && <p className="subtle">Loading the plan…</p>}
      {forms !== null && made === 0 && <Stepper step={all.length === 0 ? 1 : selected ? 3 : 2} />}

      {forms !== null && all.length === 0 && (
        <section className="drop" aria-label="Add InfoPath templates" aria-busy={busy}>
          <Icon name="upload" size={32} />
          <p>
            <b>Drop your InfoPath templates here</b>
            <Hint>.xsn files, or a whole folder of them. Add filled .xml records to have them counted per form. Files are read in your browser and never uploaded.</Hint>
          </p>
          <div className="actions">
            <button className="primary" onClick={() => files.current.click()} disabled={busy}><Icon name="plus" />Add templates</button>
            <IconButton icon="folder" label="Add a whole folder" onClick={() => folder.current.click()} disabled={busy} />
            <button onClick={samples} disabled={busy}><Icon name="flask" />Try the {SAMPLES.length} sample forms</button>
          </div>
          <Status progress={progress} report={report} />
        </section>
      )}

      {all.length > 0 && (
        <>
          <div className="plan-head">
            <h2>Migration plan</h2>
            <div className="actions">
              {all.length > 5 && (
                <label className="search">
                  <Icon name="search" />
                  <span className="sr-only">Filter by form or file name</span>
                  <input type="search" placeholder="Filter" value={filter.text} onChange={(e) => setFilter({ ...filter, text: e.target.value })} />
                </label>
              )}
              <button onClick={() => files.current.click()} disabled={busy} data-tip="Add templates. You can also drop them anywhere on this page."><Icon name="plus" />Add</button>
              <IconButton icon="folder" label="Add a whole folder" onClick={() => folder.current.click()} disabled={busy} />
              <IconButton icon="download" label="Export the plan (CSV)" onClick={() => downloadCsv(all)} />
              {sampleIds.length > 0 && (
                <ConfirmButton
                  icon="trash"
                  label="Remove the sample forms"
                  question={`Remove the ${plural(sampleIds.length, 'sample form')}?`}
                  note="JSM forms created from them stay in Jira."
                  confirm="Remove"
                  working="Removing…"
                  onConfirm={async () => {
                    await ask('removeForms', { ids: sampleIds });
                    if (sampleIds.includes(selected)) setSelected(null);
                    setReport(null);
                    await reload();
                  }}
                />
              )}
            </div>
          </div>
          <Status progress={progress} report={report} />
          <Summary forms={all} filter={filter} onFilter={setFilter} />
          <span className="sr-only" aria-live="polite">{filtered ? `Showing ${shown.length} of ${all.length}` : ''}</span>
          <Plan
            forms={shown}
            selected={selected}
            onSelect={(id) => (id === selected ? close() : setSelected(id))}
            sort={sort}
            onSort={(key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }))}
            onClearFilter={() => setFilter(NO_FILTER)}
          />
        </>
      )}
      {selected && <Detail key={selected} id={selected} targets={targets} deskId={deskId} onDesk={chooseDesk} onRetryTargets={loadTargets} onChanged={reload} onClose={close} />}

      {pickers}
      <footer>
        InfoPath Afterlife {APP_VERSION}
        <Hint>The analysis and the form designs are stored on this Jira site only.</Hint>
      </footer>
    </main>
  );
}

class Boundary extends Component {
  state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  render() {
    if (!this.state.broken) return this.props.children;
    return (
      <main>
        <div className="callout danger" role="alert">
          <b>This page ran into a problem</b>
          <p>Reload the page to continue. Your plan is stored in Jira and is not affected.</p>
        </div>
      </main>
    );
  }
}

createRoot(document.getElementById('root')).render(<Boundary><App /></Boundary>);
