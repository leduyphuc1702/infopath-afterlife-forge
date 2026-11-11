import { invoke as forgeInvoke, router, view } from '@forge/bridge';

export const invoke = (name, payload) => forgeInvoke(name, payload);
export const open = (url) => router.open(url);
export const enableTheme = () => view.theme.enable();
