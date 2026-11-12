// The record this app keeps about one legacy form: what Rovo and the admin page read later.
// The backend splits it into the plan row, the detail and the JSM form design, and trims a very
// large field list to what Forge storage holds.

export const slug = (name) =>
  name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'form';

/** What takes the place of each dated cause once the form lives in Jira Service Management. */
const REPLACEMENT_WORDS = {
  'forms-services-spo': 'A native JSM form in the customer portal',
  'infopath-client': 'A native JSM form, filled in any browser',
  'browser-xslt': 'Nothing to replace: a JSM form does not use XSLT',
};

export function summarise(row, ir, conversion, when, { sample = false } = {}) {
  return {
    id: slug(row.name),
    name: row.name,
    fileName: row.fileName,
    ...(row.urn && { urn: row.urn }),
    ...(sample && { sample: true }),
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
  };
}
