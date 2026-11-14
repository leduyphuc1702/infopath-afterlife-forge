// One place for everything that talks to Jira. Inside Jira it is the Forge bridge. With
// `npm run dev` there is no Jira, so the same calls go to a stand-in that keeps forms in memory.
// The Forge bridge refuses to load outside Jira, so only one of the two is ever imported.

/* global DEV_STANDIN */
const impl = DEV_STANDIN ? await import('./stand-in.js') : await import('./forge.js');

export const invoke = (name, payload) => impl.invoke(name, payload);
export const open = (url) => impl.open(url);
export const enableTheme = () => impl.enableTheme();
/** The site's address, for a link the person copies and sends on. */
export const siteUrl = () => impl.siteUrl();
