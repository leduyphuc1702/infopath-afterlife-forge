// How every part of the page asks Jira for something.
import { makeAsk } from './ask.js';
import { invoke } from './bridge.js';

export const ask = makeAsk(invoke);
