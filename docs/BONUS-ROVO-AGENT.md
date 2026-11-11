# Bonus write-up: Rovo agent (and skill)

## What was built

- A **Rovo agent**, `rovo:agent` key `afterlife-agent`, named "InfoPath Afterlife".
- A **Rovo skill**, `rovo:skill` key `infopath-migration-plan`
  (`skills/infopath-migration-plan/SKILL.md`), which the agent declares in `skills`.
- Three **actions** the agent and the skill use:

| Action | Verb | What it returns |
|---|---|---|
| `list-legacy-forms` | GET | Every analysed InfoPath form: wave, fields, rules, data connections, causes of death, filled records, and where a JSM form was already created |
| `get-legacy-form` | GET | One form's death certificate (causes, dates, evidence, what replaces each) and its field-by-field conversion map |
| `create-jsm-form` | CREATE | Creates the JSM form for one analysed form in a named service project |

All of it is in `manifest.yml`, `prompts/agent.md`, the skill folder and `src/index.js`.

## Why an agent, and what context it adds

The people who decide the order of a migration are rarely the people who can read a template.
An HR lead knows which form matters; only the analysis knows that the form calls a SQL
database that never worked from the cloud. Before this app that knowledge sat inside cabinet
files that the ended product was needed to open. The agent puts it one question away:

- "Which InfoPath forms should we migrate first?" → the plan by wave, from
  `list-legacy-forms`.
- "What stops the Expense Report form from working?" → causes with their evidence, and what
  was simplified, from `get-legacy-form`.
- "Create the JSM form for Leave Request in project HR" → the form is created, and the agent
  repeats what a person still has to finish.

## How it is kept honest

- The agent has no knowledge of the forms except what the actions return. The prompt and the
  skill both say: never invent a form, a field, a date or a number, and never estimate time or
  cost, because the analysis holds neither.
- A form name that matches nothing returns the list of known names instead of a guess.
- With nothing analysed, `list-legacy-forms` returns a note that sends the user to the admin
  page.
- `create-jsm-form` runs only for a person who administers the target project. The check is
  made as the user (`asUser`), and when Jira cannot say who is asking, the action refuses.
- The skill tells the agent to repeat the "needs attention" lines unchanged, so the limits of
  a conversion reach the person who asked.

## What was verified

The three action handlers were run inside the Forge runtime on a real site, against real
storage, with the eleven sample forms: the list returned 11 forms in waves 3 / 2 / 6; the
single-form action returned Expense Report with its cause, 12 field lines and two attention
lines; an unknown name returned the known names; a create request with no user was refused.

The agent itself has not yet been used in Rovo Chat inside Jira. Its wording may need tuning
after the first conversations.
