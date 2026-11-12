// Reads the files a person added, analyses every template in the browser and saves each form to
// the plan.
import { toJsmForm } from '../lib/convert.mjs';
import { slug, summarise } from '../lib/summary.mjs';
import { isTemplate, sortOut } from './files.js';
import { Problem } from './ask.js';

const TOGETHER = 4;

/**
 * @param list        `[{ name, file }]`, as `files.js` returns them
 * @param core        the analysis engine
 * @param ask         asks the backend, as `makeAsk` returns it
 * @param sample      true for the bundled sample forms
 * @param onProgress  `(done, total)`, never called once this function has settled
 * @returns what happened to every file. Throws only when the person is not allowed to save.
 */
export async function analyse(list, { core, ask, sample = false, onProgress = () => {}, now = () => new Date() }) {
  const { keep, skipped, tooLarge } = sortOut(list);
  const inputs = [];
  for (const f of keep) inputs.push({ name: f.name, bytes: new Uint8Array(await f.file.arrayBuffer()) });
  const templates = new Map(inputs.filter((f) => isTemplate(f.name)).map((f) => [f.name, f]));
  const report = { saved: 0, ids: [], errors: [], skipped, tooLarge, templates: templates.size };
  if (templates.size === 0) return report;
  onProgress(0, templates.size);

  const result = await core.triageFiles(inputs);
  for (const r of result.rows) if (r.kind === 'error') report.errors.push({ fileName: r.fileName, code: r.code });
  const rows = result.rows.filter((r) => r.kind === 'form');
  const when = now().toISOString();
  let done = report.errors.length;
  let refused;
  const save = async (row) => {
    try {
      const template = await core.parseXsn(templates.get(row.fileName).bytes);
      const ir = core.buildFormIR(template);
      const kept = await ask('saveForm', { record: summarise(row, ir, toJsmForm(template, ir, core), when, { sample }) });
      report.saved += 1;
      report.ids.push(kept.id);
    } catch (e) {
      if (e.denied) {
        refused ??= e;
        return;
      }
      report.errors.push({ fileName: row.fileName, why: e instanceof Problem ? e.message : undefined });
    }
    onProgress(++done, templates.size);
  };
  // Forms are saved a few at a time. Forms that share a name go one after the other, so the
  // backend can tell them apart and give each its own row.
  const lanes = new Map();
  for (const row of rows) lanes.set(slug(row.name), [...(lanes.get(slug(row.name)) ?? []), row]);
  const queue = [...lanes.values()];
  const worker = async () => {
    for (let lane = queue.shift(); lane && !refused; lane = queue.shift())
      for (const row of lane) if (!refused) await save(row);
  };
  // Every save that has started is waited for, so nothing reports progress after this returns.
  await Promise.all(Array.from({ length: Math.min(TOGETHER, queue.length) }, worker));
  if (refused) throw refused;
  return report;
}
