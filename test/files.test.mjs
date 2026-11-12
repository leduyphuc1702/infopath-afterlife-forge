import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromDrop, fromInput, isTemplate, MAX_FILE_BYTES, sortOut } from '../ui/files.js';

const file = (name, size = 10) => ({ name, size });
const fileEntry = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(file(name)) });
// A browser hands a folder over in batches, so the stand-in does too.
const dirEntry = (name, children, batch = 2) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader() {
    let at = 0;
    return { readEntries: (ok) => ok(children.slice(at, (at += batch))) };
  },
});
const item = (entry) => ({ kind: 'file', webkitGetAsEntry: () => entry });

test('a dropped folder is walked to the bottom and files are named by their path', async () => {
  const tree = dirEntry('export', [
    dirEntry('hr', [fileEntry('template.xsn'), fileEntry('a.xml'), fileEntry('b.xml')]),
    dirEntry('finance', [fileEntry('template.xsn'), dirEntry('old', [fileEntry('template.xsn')])]),
    fileEntry('readme.txt'),
  ]);
  const got = await fromDrop({ items: [item(tree), item(fileEntry('loose.xsn'))], files: [] });
  assert.deepEqual(got.map((f) => f.name), [
    'export/hr/template.xsn', 'export/hr/a.xml', 'export/hr/b.xml',
    'export/finance/template.xsn', 'export/finance/old/template.xsn',
    'export/readme.txt', 'loose.xsn',
  ]);
});

test('without folder support the plain file list is used', async () => {
  const files = [file('a.xsn'), file('b.xml')];
  assert.deepEqual((await fromDrop({ files })).map((f) => f.name), ['a.xsn', 'b.xml']);
  assert.deepEqual((await fromDrop({ files, items: [{ kind: 'file' }, { kind: 'file' }] })).map((f) => f.name), ['a.xsn', 'b.xml']);
  assert.deepEqual((await fromDrop({ files, items: [{ kind: 'string' }] })).map((f) => f.name), ['a.xsn', 'b.xml']);
});

test('a chosen folder keeps the path of each file', () => {
  const got = fromInput([{ name: 'template.xsn', webkitRelativePath: 'hr/template.xsn' }, { name: 'x.xsn', webkitRelativePath: '' }]);
  assert.deepEqual(got.map((f) => f.name), ['hr/template.xsn', 'x.xsn']);
});

test('only templates and records are read; the rest is named, and system files are passed over', () => {
  const list = ['a.XSN', 'b.xml', 'notes.docx', '.DS_Store', 'hr/.hidden.xsn', 'hr/Thumbs.db', 'hr/desktop.ini', 'photo.png'].map((name) => ({ name, file: file(name) }));
  const { keep, skipped, tooLarge } = sortOut(list);
  assert.deepEqual(keep.map((f) => f.name), ['a.XSN', 'b.xml']);
  assert.deepEqual(skipped, ['notes.docx', 'photo.png']);
  assert.deepEqual(tooLarge, []);
  assert.deepEqual([isTemplate('a.XSN'), isTemplate('b.xml')], [true, false]);
});

test('two files with one name both stay, and a huge file is not read', () => {
  const list = [
    { name: 'template.xsn', file: file('template.xsn') },
    { name: 'Template.xsn', file: file('Template.xsn') },
    { name: 'template.xsn', file: file('template.xsn') },
    { name: 'video.xml', file: file('video.xml', MAX_FILE_BYTES + 1) },
  ];
  const { keep, tooLarge } = sortOut(list);
  assert.deepEqual(keep.map((f) => f.name), ['template.xsn', 'Template (2).xsn', 'template (3).xsn']);
  assert.deepEqual(tooLarge, ['video.xml']);
});
