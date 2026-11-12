// The small pieces every part of the page is built from.
import { useEffect, useRef, useState } from 'react';
import { words } from './ask.js';
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
