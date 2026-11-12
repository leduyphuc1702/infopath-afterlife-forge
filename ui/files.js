// Turns what a person dropped or chose into a flat list of named files. A dropped folder is
// walked to the bottom, and each file is named by its path inside the folder.

const WANTED = /\.(xsn|xml)$/i;
// Files the operating system leaves in folders. Nobody chose them, so they are not reported.
const NOISE = /(^|\/)(\.[^/]*|thumbs\.db|desktop\.ini)$/i;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export const isTemplate = (name) => /\.xsn$/i.test(name);

async function walk(entry, path, out) {
  if (entry.isFile) {
    const file = await new Promise((ok, no) => entry.file(ok, no));
    out.push({ name: `${path}${entry.name}`, file });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  // A folder is handed over in batches; an empty batch ends it.
  for (;;) {
    const batch = await new Promise((ok, no) => reader.readEntries(ok, no));
    if (batch.length === 0) break;
    for (const child of batch) await walk(child, `${path}${entry.name}/`, out);
  }
}

/**
 * The first step must run inside the drop handler itself: the browser empties the transfer as
 * soon as the handler returns.
 */
export function fromDrop(dataTransfer) {
  const plain = [...(dataTransfer.files ?? [])].map((file) => ({ name: file.name, file }));
  const entries = [...(dataTransfer.items ?? [])]
    .filter((item) => item.kind === 'file')
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));
  if (entries.length === 0 || entries.some((e) => !e)) return Promise.resolve(plain);
  return (async () => {
    const out = [];
    for (const entry of entries) await walk(entry, '', out);
    return out;
  })();
}

export const fromInput = (fileList) =>
  [...fileList].map((file) => ({ name: file.webkitRelativePath || file.name, file }));

/**
 * Splits the list into files worth reading and names to report. Two files with one name both
 * stay, the second with a number, so neither replaces the other.
 */
export function sortOut(list) {
  const keep = [];
  const skipped = [];
  const tooLarge = [];
  const seen = new Map();
  for (const item of list) {
    if (NOISE.test(item.name)) continue;
    if (!WANTED.test(item.name)) {
      skipped.push(item.name);
      continue;
    }
    if (item.file?.size > MAX_FILE_BYTES) {
      tooLarge.push(item.name);
      continue;
    }
    const key = item.name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    keep.push(n === 1 ? item : { ...item, name: item.name.replace(/(\.[^./]+)$/, ` (${n})$1`) });
  }
  return { keep, skipped, tooLarge };
}
