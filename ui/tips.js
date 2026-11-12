// One tooltip for the whole page. Anything with a data-tip attribute shows it on hover and on
// keyboard focus; Escape or moving away puts it back. It is drawn over the page, so a table
// that scrolls sideways cannot cut it off.
const GAP = 6;
const EDGE = 8;

export function installTips(doc = document) {
  const tip = doc.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  doc.body.append(tip);

  let owner = null;
  const hide = () => {
    tip.hidden = true;
    owner = null;
  };
  const show = (el) => {
    const text = el.getAttribute('data-tip');
    if (!text) return hide();
    owner = el;
    tip.textContent = text;
    tip.hidden = false;
    const at = el.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const { clientWidth, clientHeight } = doc.documentElement;
    const left = Math.min(at.left + at.width / 2 - box.width / 2, clientWidth - box.width - EDGE);
    const below = at.bottom + GAP;
    const above = at.top - GAP - box.height;
    const top = below + box.height > clientHeight - EDGE && above > EDGE ? above : below;
    // Measurements come back as drawn; under a CSS zoom the style lengths are counted before it.
    const zoom = tip.currentCSSZoom || 1;
    tip.style.left = `${Math.max(EDGE, left) / zoom}px`;
    tip.style.top = `${top / zoom}px`;
  };
  const tipped = (e) => (e.target instanceof Element ? e.target.closest('[data-tip]') : null);

  doc.addEventListener('mouseover', (e) => {
    const el = tipped(e);
    if (!el) hide();
    else if (el !== owner) show(el);
  });
  doc.addEventListener('focusin', (e) => {
    const el = tipped(e);
    if (el) show(el);
    else hide();
  });
  doc.addEventListener('focusout', hide);
  // A tap on a help mark opens it; a click on anything else has done its work.
  doc.addEventListener('click', (e) => {
    const el = tipped(e);
    if (el?.classList.contains('hint')) show(el);
    else hide();
  });
  doc.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  // Tabbing to a help mark below the fold scrolls the page, so the tooltip follows its owner.
  doc.addEventListener('scroll', () => (owner?.isConnected ? show(owner) : hide()), true);
  doc.documentElement.addEventListener('mouseleave', hide);
}
