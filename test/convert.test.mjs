import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import * as core from '../vendor/afterlife-core.mjs';
import { QUESTION_WORDS, staticChoices, toJsmForm } from '../lib/convert.mjs';
import { summarise } from '../lib/summary.mjs';

const dir = new URL('../static/admin/samples/', import.meta.url);
const all = process.env.AFTERLIFE_SAMPLES ?? dir.pathname;
const names = existsSync(all) ? readdirSync(all, { recursive: true }).filter((f) => String(f).toLowerCase().endsWith('.xsn')).sort() : [];

async function convert(file) {
  const template = await core.parseXsn(new Uint8Array(readFileSync(`${all}/${file}`)));
  const ir = core.buildFormIR(template);
  return { ir, out: toJsmForm(template, ir, core) };
}

test('there are sample forms to convert', () => assert.ok(names.length > 0));

for (const file of names) {
  test(`design is well formed: ${process.env.AFTERLIFE_SAMPLES ? `form ${names.indexOf(file) + 1}` : file}`, async () => {
    const { ir, out } = await convert(file);
    const { questions, layout, settings, sections, conditions } = out.design;
    assert.ok(settings.name.length > 0 && settings.name.length <= 100);
    assert.deepEqual([sections, conditions], [{}, {}]);
    const placed = layout[0].content.filter((n) => n.type === 'extension').map((n) => String(n.attrs.parameters.id));
    assert.deepEqual(placed.slice().sort(), Object.keys(questions).sort(), 'every question is placed exactly once');
    assert.equal(new Set(layout[0].content.filter((n) => n.attrs?.localId).map((n) => n.attrs.localId)).size, placed.length);
    const keys = Object.values(questions).map((q) => q.questionKey);
    assert.equal(new Set(keys).size, keys.length, 'question keys are unique');
    for (const q of Object.values(questions)) {
      assert.ok(q.type in QUESTION_WORDS, q.type);
      assert.ok(q.label.length > 0 && q.label.length <= 255, 'label');
      assert.equal(typeof q.validation.rq, 'boolean');
      if (q.choices) assert.equal(new Set(q.choices.map((c) => c.id)).size, q.choices.length);
      // A required question with one box would force every customer to tick it.
      if (q.type === 'cm' && q.choices.length === 1) assert.equal(q.validation.rq, false, `${q.label}: a single check box is never required`);
      for (const id of q.defaultAnswer?.choices ?? []) assert.ok(q.choices.some((c) => c.id === id));
    }
    assert.equal(out.stats.converted + out.stats.simplified + out.stats.skipped, out.map.length);
    // Same input, same design.
    assert.deepEqual((await convert(file)).out.design, out.design);
    const row = (await core.triageFiles([{ name: file, bytes: new Uint8Array(readFileSync(`${all}/${file}`)) }])).rows[0];
    const record = summarise(row, ir, out, '2026-01-01T00:00:00Z');
    assert.ok(JSON.stringify(record).length < 240 * 1024, 'fits one storage value');
  });
}

test('typed options are read from the view, without the placeholder', () => {
  const xsl = '<select xd:CtrlId="CTRL4" xd:xctname="dropdown"><option value=""><xsl:if test="a">x</xsl:if>Select...</option><option value="HR"><xsl:if test="b"><xsl:attribute name="selected">selected</xsl:attribute></xsl:if>Human &amp; Resources</option></select>';
  assert.deepEqual(staticChoices(xsl, 'CTRL4'), [{ value: 'HR', label: 'Human & Resources' }]);
  assert.deepEqual(staticChoices(xsl, 'CTRL5'), []);
});
