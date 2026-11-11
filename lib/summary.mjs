// The record this app keeps about one legacy form: what Rovo and the admin page read later.
// Small on purpose: Forge key-value storage holds 240 KiB per value.

export const slug = (name) =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'form';

const MAX_BYTES = 200_000;

/** What takes the place of each dated cause once the form lives in Jira Service Management. */
const REPLACEMENT_WORDS = {
  'forms-services-spo': 'A JSM form in the customer portal, created from this page',
  'infopath-client': 'A JSM form filled in any browser, created from this page',
  'browser-xslt': 'Nothing to replace: a JSM form does not use XSLT',
};

export function summarise(row, ir, conversion, when) {
  const record = {
    id: slug(row.name),
    name: row.name,
    fileName: row.fileName,
    ...(row.urn && { urn: row.urn }),
    ...(ir.meta.solutionVersion && { version: ir.meta.solutionVersion }),
    generation: row.generation,
    browserCompatible: row.browserCompatible,
    wave: row.wave,
    counts: row.counts,
    coverage: row.coverage,
    ...(row.nativePercent !== undefined && { nativePercent: row.nativePercent }),
    ...(row.records !== undefined && { records: row.records }),
    causes: row.causes.map((c) => ({
      id: c.id,
      date: c.dateWords,
      replacement: REPLACEMENT_WORDS[c.id] ?? c.replacement,
      ...(c.source && { source: c.source }),
      evidence: c.evidence.slice(0, 5).map((e) => ({
        what: e.what,
        where: `${e.located.file}${e.located.path ? ` ${e.located.path}` : ''}`,
        ...(e.replacement && { replacement: e.replacement }),
      })),
    })),
    conversion: conversion.stats,
    attention: conversion.attention,
    fields: conversion.map,
    design: conversion.design,
    analysedAt: when,
    created: [],
  };
  // A very large form keeps its design and loses the per-field notes first.
  if (JSON.stringify(record).length > MAX_BYTES)
    record.fields = record.fields.map(({ note, ...rest }) => rest);
  if (JSON.stringify(record).length > MAX_BYTES) record.fields = record.fields.slice(0, 100);
  return record;
}
