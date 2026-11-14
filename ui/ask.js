// How the page asks the backend for something, and what it tells the person when that fails.

/** Something went wrong and there are words for it that the person can act on. */
export class Problem extends Error {
  constructor(message, flags = {}) {
    super(message);
    Object.assign(this, flags);
  }
}

export const words = (e) =>
  e instanceof Problem ? e.message : 'Something went wrong on this page. Reload it and try again.';

const PAUSES_MS = [600, 1500];

/**
 * @param invoke  calls one backend function: `(name, payload) => answer`
 * @param wait    pauses for so many milliseconds
 */
export function makeAsk(invoke, wait = (ms) => new Promise((done) => setTimeout(done, ms))) {
  return async function ask(name, payload) {
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await invoke(name, payload);
      } catch {
        throw new Problem('Jira did not answer. Check your connection, then try again.');
      }
      // The backend says so when it stopped before doing anything, so asking again is safe.
      if (r?.retry === true && attempt < PAUSES_MS.length) {
        await wait(PAUSES_MS[attempt]);
        continue;
      }
      if (!r || r.ok === false)
        throw new Problem(r?.error ?? 'Jira did not answer. Try again in a moment.', {
          denied: r?.denied === true,
          // Why a form was not created, for the part of the page that creates several in a row.
          duplicate: r?.duplicate === true,
          notAdmin: r?.notAdmin === true,
        });
      return r;
    }
  };
}
