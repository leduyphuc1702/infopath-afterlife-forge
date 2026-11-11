// Turns a parsed InfoPath template into a Jira Service Management form design (the JSON the
// Forms REST API accepts), plus a field map that says what happened to every control.
//
// Pure functions: no DOM, no Forge, no network. They run in the admin page and in the tests.

/** JSM question types, with the words the field map shows. */
export const QUESTION_WORDS = {
  ts: 'Short text',
  tl: 'Long text',
  rt: 'Paragraph',
  te: 'Email',
  tu: 'URL',
  no: 'Number',
  da: 'Date',
  dt: 'Date and time',
  ti: 'Time',
  cd: 'Dropdown',
  cs: 'Radio buttons',
  cm: 'Checkboxes',
  at: 'Attachment',
};

export const STATUS_WORDS = {
  converted: 'Converted',
  simplified: 'Simplified',
  skipped: 'Not converted',
};

const INTEGER = new Set([
  'integer', 'int', 'long', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger',
  'nonPositiveInteger', 'negativeInteger', 'unsignedInt', 'unsignedLong', 'unsignedShort',
  'unsignedByte',
]);
const DECIMAL = new Set(['double', 'decimal', 'float']);

const LABEL_MAX = 255;
const clip = (s, n = LABEL_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const localName = (qname) => qname.slice(qname.indexOf(':') + 1);
const builtinOf = (field) => localName(String(field?.xsdType?.builtin ?? 'string'));

/** FNV-1a, spread over a UUID shape, so the same template always gives the same design. */
function stableId(seed) {
  let hex = '';
  for (let round = 0; hex.length < 32; round++) {
    let h = 0x811c9dc5;
    for (const ch of `${round}:${seed}`) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193);
    }
    hex += (h >>> 0).toString(16).padStart(8, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The options an author typed into a drop-down or list box. FormIR records where a list comes
 * from a data source, but typed options stay in the view's XSL, so they are read from there.
 */
export function staticChoices(xsl, ctrlId) {
  if (!xsl || !ctrlId) return [];
  const select = new RegExp(
    `<select\\b[^>]*xd:CtrlId="${escapeRe(ctrlId)}"[^>]*>([\\s\\S]*?)</select>`,
    'i',
  ).exec(xsl);
  if (!select) return [];
  const out = [];
  const option = /<option\b[^>]*?value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
  for (let m; (m = option.exec(select[1])); ) {
    const value = decode(m[1]);
    const label = decode(
      m[2].replace(/<xsl:if\b[\s\S]*?<\/xsl:if>/gi, '').replace(/<[^>]+>/g, ''),
    ).trim();
    if (value === '' && out.length === 0) continue; // the "Select..." placeholder
    out.push({ value, label: label || value });
  }
  return out;
}

function questionType(control, field) {
  const x = (control.xctname ?? '').toLowerCase();
  const builtin = builtinOf(field);
  if (field.kind === 'richText' || x === 'richtext') return 'rt';
  if (x === 'fileattachment' || x === 'inlineimage' || x === 'linkedimage') return 'at';
  if (x === 'checkbox') return 'cm';
  if (x === 'optionbutton') return 'cs';
  if (x === 'dropdown' || x === 'listbox' || x === 'combobox') return 'cd';
  if (x === 'multipleselectionlistbox') return 'cm';
  if (builtin === 'dateTime') return 'dt';
  if (builtin === 'date' || x.startsWith('dtpicker')) return 'da';
  if (builtin === 'time') return 'ti';
  if (INTEGER.has(builtin) || DECIMAL.has(builtin)) return 'no';
  if (builtin === 'anyURI') return 'tu';
  if (/\be-?mail\b/i.test(field.label)) return 'te';
  return 'ts';
}

const KNOWN = new Set([
  'plaintext', 'richtext', 'dropdown', 'listbox', 'combobox', 'multipleselectionlistbox',
  'optionbutton', 'checkbox', 'fileattachment', 'inlineimage', 'linkedimage', 'dtpicker',
  'dtpicker_dttext', 'dtpicker_dtbutton',
]);
const STRUCTURE = /^(section|optionalsection|repeatingsection|repeatingtable|choicegroup|choiceterm|container|scrollableregion|horizontalregion|mastertable|masterdetail|bulletedlist|numberedlist|plainlist|recursivesection)/;

/** What InfoPath called each control, in the words its designer used. */
export const CONTROL_WORDS = {
  plaintext: 'Text box',
  richtext: 'Rich text box',
  dropdown: 'Drop-down list',
  listbox: 'List box',
  combobox: 'Combo box',
  multiselectlistbox: 'Multiple-selection list box',
  dtpicker: 'Date picker',
  dtpicker_dttext: 'Date picker',
  optionbutton: 'Option button',
  checkbox: 'Check box',
  fileattachment: 'File attachment',
  inlineimage: 'Picture',
  linkedimage: 'Picture',
  inkpicture: 'Ink picture',
  expressionbox: 'Calculated value',
  button: 'Button',
  hyperlink: 'Hyperlink',
  bulletedlist: 'Bulleted list',
  numberedlist: 'Numbered list',
  plainlist: 'Plain list',
};
const controlWords = (xctname) =>
  /^\{/.test(xctname ?? '') ? 'ActiveX control' : (CONTROL_WORDS[(xctname ?? '').toLowerCase()] ?? xctname ?? 'Control');

/**
 * @param template  what `parseXsn` returned
 * @param ir        what `buildFormIR` returned for it
 * @param is        `{ isBlankCheck }` from the engine
 */
export function toJsmForm(template, ir, is) {
  const view = ir.views.find((v) => v.isDefault) ?? ir.views[0];
  const xslFile = view?.xslFile && template.files.find((f) => f.name === view.xslFile);
  const xsl = xslFile ? new TextDecoder().decode(xslFile.bytes) : '';
  const fields = new Map(ir.fields.map((f) => [f.id, f]));
  const groups = new Map(ir.groups.map((g) => [g.id, g]));
  const repeatOf = (node) => {
    for (let g = groups.get(node.groupId); g; g = groups.get(g.groupId)) if (g.repeating) return g;
    return undefined;
  };

  const questions = {};
  const layout = [];
  const map = [];
  const attention = [];
  const keys = new Set();
  let nextId = 1;

  const heading = (text) =>
    layout.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text }] });
  let currentGroup;
  const place = (id, group) => {
    // A heading whenever the form moves into another named group, as the paper form did.
    const title = group && group.groupId !== undefined ? group.label : undefined;
    if (title !== currentGroup) {
      currentGroup = title;
      if (title) heading(clip(title, 120));
    }
    layout.push({
      type: 'extension',
      attrs: {
        extensionKey: 'question',
        extensionType: 'com.thinktilt.proforma',
        layout: 'default',
        parameters: { id },
        localId: stableId(`${ir.meta.urn ?? ir.meta.name}:${id}`),
      },
    });
  };
  const uniqueKey = (name) => {
    const base = localName(name).replace(/[^A-Za-z0-9_]/g, '_') || 'question';
    let key = base;
    for (let n = 2; keys.has(key); n++) key = `${base}_${n}`;
    keys.add(key);
    return key;
  };
  const add = (question, group) => {
    const id = nextId++;
    questions[String(id)] = question;
    place(id, group);
    return id;
  };
  const row = (control, field, target, status, note) =>
    map.push({
      label: field?.label ?? control.title ?? control.binding,
      path: field?.path ?? control.binding,
      control: controlWords(control.xctname),
      ...(target && { target, targetWords: QUESTION_WORDS[target] }),
      status,
      ...(note && { note }),
    });

  const requiredIds = new Set(
    ir.validations.filter((v) => is.isBlankCheck(v) && v.matchId).map((v) => v.matchId),
  );
  const otherRules = new Map();
  for (const v of ir.validations)
    if (!is.isBlankCheck(v) && v.matchId)
      otherRules.set(v.matchId, [...(otherRules.get(v.matchId) ?? []), v]);
  const calculated = new Map(ir.calculations.filter((c) => c.targetId).map((c) => [c.targetId, c]));

  const done = new Set();
  const repeats = new Map();
  const controls = view?.controls ?? [];

  for (const control of controls) {
    const x = (control.xctname ?? '').toLowerCase();
    const field = control.targetId ? fields.get(control.targetId) : undefined;

    if (/^\{[0-9a-f-]+\}$/i.test(control.xctname ?? '')) {
      row(control, field, undefined, 'skipped', 'ActiveX control: it cannot run in a browser.');
      continue;
    }
    if (!field) {
      if (x && !STRUCTURE.test(x) && !control.targetId)
        row(control, undefined, undefined, 'skipped',
          x === 'expressionbox' ? 'Expression box: it only shows a calculated value.'
            : x === 'button' ? 'Button: its rules do not carry over to a JSM form.'
              : 'Not bound to a field.');
      continue;
    }
    if (field.dataSource !== 'main') continue;

    const repeat = control.inRepeat ? repeatOf(field) : undefined;
    if (control.inRepeat) {
      const key = repeat?.id ?? 'repeat';
      const bucket = repeats.get(key) ?? { group: repeat, columns: [], attachments: [] };
      const file = questionType(control, field) === 'at';
      const list = file ? bucket.attachments : bucket.columns;
      if (!list.includes(field.label)) list.push(field.label);
      if (!repeats.has(key)) {
        repeats.set(key, bucket);
        bucket.id = add(
          { type: 'tl', label: '', description: '', questionKey: '', validation: { rq: false } },
          groups.get(repeat?.groupId),
        );
      }
      row(control, field, file ? 'at' : 'tl', 'simplified', file
        ? `File column of the repeating table “${repeat?.label ?? 'items'}”: one attachment question holds the files of every row.`
        : `Column of the repeating table “${repeat?.label ?? 'items'}”: one line of text per row.`);
      continue;
    }
    if (done.has(field.id)) continue;

    const type = questionType(control, field);
    const question = {
      type,
      label: clip(field.label || localName(field.name)),
      description: '',
      questionKey: uniqueKey(field.name),
      validation: { rq: Boolean(field.required) || requiredIds.has(field.id) },
    };
    let status = 'converted';
    const notes = [];

    if (type === 'cs') {
      const options = controls.filter((c) => c.targetId === field.id && c.choice);
      question.choices = options.map((c, i) => ({
        id: String(i + 1),
        label: clip(c.choice.label || c.choice.value || `Option ${i + 1}`),
        other: false,
      }));
      const chosen = options.findIndex((c) => c.choice.value === field.default);
      if (chosen >= 0) question.defaultAnswer = { choices: [String(chosen + 1)] };
    } else if (type === 'cm') {
      question.choices = [
        { id: '1', label: clip(control.choice?.label || field.label || 'Yes'), other: false },
      ];
    } else if (type === 'cd') {
      const options = control.choicesFrom ? [] : staticChoices(xsl, control.ctrlId);
      question.choices = options.map((o, i) => ({ id: String(i + 1), label: clip(o.label), other: false }));
      const chosen = options.findIndex((o) => o.value === field.default);
      if (chosen >= 0) question.defaultAnswer = { choices: [String(chosen + 1)] };
      if (control.choicesFrom) {
        status = 'simplified';
        notes.push(`The list came from the data source “${control.choicesFrom.dataSource}”. Add the choices by hand, or link the question to a Jira field or an Assets object.`);
      } else if (options.length === 0) {
        status = 'simplified';
        notes.push('No typed options were found in the view. Add the choices by hand.');
      }
    } else {
      if (type === 'no' && INTEGER.has(builtinOf(field))) question.validation.wh = true;
      if ((type === 'ts' || type === 'tl' || type === 'te' || type === 'tu') && field.default)
        question.defaultAnswer = { text: field.default };
    }

    if (!KNOWN.has(x) && type === 'ts') {
      status = 'simplified';
      notes.push(`Control type “${control.xctname ?? 'unknown'}” has no JSM equivalent; it became a short text question.`);
    }
    const calc = calculated.get(field.id);
    if (calc) {
      status = 'simplified';
      question.description = 'InfoPath calculated this value. Enter it by hand.';
      notes.push(`Was calculated: ${clip(calc.expression, 160)}. JSM forms do not calculate.`);
    }
    for (const v of otherRules.get(field.id) ?? []) {
      status = 'simplified';
      if (v.message?.text && !question.description) question.description = clip(v.message.text);
      notes.push(`Validation rule kept as help text only: ${clip(v.expression ?? '', 160)}`);
    }
    if (control.readOnly && !calc) notes.push('Was read-only in InfoPath.');

    done.add(field.id);
    add(question, groups.get(field.groupId));
    row(control, field, type, status, notes.join(' '));
  }

  for (const bucket of repeats.values()) {
    const q = questions[String(bucket.id)];
    const name = bucket.group?.label || 'Items';
    q.label = clip(name);
    q.questionKey = uniqueKey(bucket.group?.name ?? 'items');
    q.description = clip(bucket.columns.length > 0 ? `One line per item: ${bucket.columns.join(' | ')}` : 'One line per item.');
    attention.push(`Repeating table “${name}” became one long text question. JSM forms have no repeating rows.`);
    if (bucket.attachments.length > 0) {
      add(
        {
          type: 'at',
          label: clip(`${name}: ${bucket.attachments.join(', ')}`),
          description: 'Attach one file per item.',
          questionKey: uniqueKey(`${bucket.group?.name ?? 'items'}_files`),
          validation: { rq: false },
        },
        groups.get(bucket.group?.groupId),
      );
    }
  }

  const otherViews = ir.views.filter((v) => v !== view && !v.isPrint).map((v) => v.caption ?? v.name);
  if (otherViews.length > 0)
    attention.push(`Only the default view “${view?.caption ?? view?.name}” became the form. Other views: ${otherViews.join(', ')}.`);
  const actions = ir.rules.reduce((n, r) => n + r.actions.length, 0);
  if (actions > 0) attention.push(`${actions} rule action${actions === 1 ? '' : 's'} did not carry over. JSM forms only show or hide sections.`);
  for (const c of ir.dataConnections)
    if (!c.isSubmit || c.adapterKind !== 'submitToHostAdapter')
      attention.push(`Data connection “${c.name ?? c.id}” (${c.adapterKind}) is not part of the JSM form.`);
  if (ir.codeBehind.present) attention.push(`Code-behind (${ir.codeBehind.handlers.length} event handler${ir.codeBehind.handlers.length === 1 ? '' : 's'}) does not run in JSM.`);
  if (ir.signatures.blocks.length + ir.signatures.signatureLines.length > 0)
    attention.push('Digital signatures are not part of JSM forms. Use an approval step instead.');

  const count = (s) => map.filter((m) => m.status === s).length;
  return {
    design: {
      conditions: {},
      layout: [{ version: 1, type: 'doc', content: layout }],
      questions,
      sections: {},
      settings: { name: clip(ir.meta.name || 'InfoPath form', 100), submit: { lock: true, pdf: true } },
    },
    map,
    attention,
    stats: {
      questions: Object.keys(questions).length,
      converted: count('converted'),
      simplified: count('simplified'),
      skipped: count('skipped'),
    },
  };
}
