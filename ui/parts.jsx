// The small pieces every part of the page is built from.
import { useEffect, useRef, useState } from 'react';
import { words } from './ask.js';
import { siteUrl } from './bridge.js';
import { Icon } from './icons.jsx';

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const dayWords = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
export const some = (names, max = 4) => `${names.slice(0, max).join(', ')}${names.length > max ? ` and ${names.length - max} more` : ''}`;

/** A help mark. The explanation shows on hover and on focus, and is what a screen reader reads. */
export function Hint({ children }) {
  return (
    <button type="button" className="hint" data-tip={children}>
      <Icon name="help" />
      <span className="sr-only">{children}</span>
    </button>
  );
}

export function IconButton({ icon, label, ...rest }) {
  return (
    <button type="button" className="icon-btn" aria-label={label} data-tip={label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}

export function Lozenge({ tone = 'neutral', tip, children }) {
  return <span className={`lozenge lozenge-${tone}`} data-tip={tip}>{children}</span>;
}
export const waveTone = { 1: 'success', 2: 'information', 3: 'warning' };
export const statusTone = { converted: 'success', simplified: 'information', skipped: 'warning' };

/** A button that asks once more before it does something that cannot be undone. */
export function ConfirmButton({ icon, label, question, note, confirm, working, onConfirm }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  if (!asking) return <IconButton icon={icon} label={label} onClick={() => { setError(null); setAsking(true); }} />;
  const go = async () => {
    setBusy(true);
    try {
      await onConfirm();
      if (alive.current) setAsking(false);
    } catch (e) {
      if (alive.current) setError(words(e));
    }
    if (alive.current) setBusy(false);
  };
  return (
    <span className="confirm" role="group" aria-label={question}>
      <span>{question}{note && <Hint>{note}</Hint>}</span>
      <button className="danger" disabled={busy} onClick={go}>{busy ? working : confirm}</button>
      <button autoFocus disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
      {error && <span className="error" role="alert">{error}</span>}
    </span>
  );
}

/** Where people fill in a JSM form that is shown on a request type. */
export const portalPath = (c) => `/servicedesk/customer/portal/${c.portalId}/create/${c.requestTypeId}`;
export const inPortal = (c) => Boolean(c.portalId && c.requestTypeId);
/** Live: people can send it from the portal. Waiting: its request type is in no portal group yet. */
export const isLive = (c) => inPortal(c) && !c.hidden;
export const isWaiting = (c) => inPortal(c) && c.hidden === true;
/** Where a project administrator adds a request type to a portal group. */
export const groupsPage = (projectKey) => `/jira/servicedesk/projects/${projectKey}/settings/portal-settings/portal-groups`;

/** Runs when the person comes back to this browser tab, for as long as `on` holds. */
export function useReturn(on, fn) {
  useEffect(() => {
    if (!on) return undefined;
    const back = () => { if (document.visibilityState === 'visible') fn(); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [on, fn]);
}

let site;
/** A path on this Jira site as a whole link. */
export async function fullLink(path) {
  site ??= await siteUrl().catch(() => '');
  return `${site}${path}`;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Jira may not let the page's frame use the clipboard this way; the older way follows.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(area);
  area.select();
  let done = false;
  try {
    done = document.execCommand('copy');
  } catch {
    done = false;
  }
  area.remove();
  return done;
}

/** Copies a link to send to people. When the browser refuses, the link is shown to copy by eye. */
export function CopyLink({ path, label = 'Copy the link to send to people' }) {
  const [state, setState] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const go = async (e) => {
    e.stopPropagation();
    const link = await fullLink(path);
    const copied = await copy(link);
    if (!alive.current) return;
    setState(copied ? 'copied' : link);
    if (copied) setTimeout(() => alive.current && setState(null), 2500);
  };
  if (state && state !== 'copied')
    return <input className="shown-link" readOnly value={state} aria-label="The link to send to people" autoFocus onFocus={(e) => e.target.select()} onClick={(e) => e.stopPropagation()} />;
  return (
    <>
      <IconButton icon={state === 'copied' ? 'check' : 'copy'} label={state === 'copied' ? 'Copied' : label} onClick={go} />
      <span className="sr-only" aria-live="polite">{state === 'copied' ? 'Link copied' : ''}</span>
    </>
  );
}

/** A side matter, opened from an icon in the page header and closed again. */
export function Panel({ title, hint, onClose, children }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <section className="panel" aria-labelledby="panel-h" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <header>
        <div className="heading">
          <h2 id="panel-h" tabIndex={-1} ref={heading}>{title}</h2>
          {hint && <Hint>{hint}</Hint>}
        </div>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </header>
      {children}
    </section>
  );
}
