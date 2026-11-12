# Bonus write-up: Rovo agent (and skill)

## What was built

- A **Rovo agent**, `rovo:agent` key `afterlife-agent`, named "InfoPath Afterlife".
- A **Rovo skill**, `rovo:skill` key `infopath-migration-plan`
  (`skills/infopath-migration-plan/SKILL.md`), which the agent declares in `skills`.
- Four **actions** the agent and the skill use:

| Action | Verb | What it returns |
|---|---|---|
| `list-legacy-forms` | GET | Every analysed InfoPath form: wave, fields, rules, data connections, causes of death, filled records, and where a JSM form was already created |
| `get-legacy-form` | GET | One form's death certificate (causes, dates, evidence, what replaces each) and its field-by-field conversion map |
| `list-service-projects` | GET | The service projects the person asking administers, the only ones they can add a form to |
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
- "Create the JSM form for Leave Request" → the agent calls `list-service-projects`, shows
  the projects the person administers and asks which one. After the answer Rovo shows its
  "Please review" step, and only a confirmed request creates the form. The agent then repeats
  what a person still has to finish.

## How it is kept honest

- The agent has no knowledge of the forms except what the actions return. The prompt and the
  skill both say: never invent a form, a field, a date or a number, and never estimate time or
  cost, because the analysis holds neither.
- A form name that matches nothing returns the list of known names instead of a guess.
- With nothing analysed, `list-legacy-forms` returns a note that sends the user to the admin
  page.
- `create-jsm-form` runs only for a person who administers the target project. The check is
  made as the user (`asUser`), and when Jira cannot say who is asking, the action refuses.
- The agent never guesses a project: the prompt tells it to ask, and `list-service-projects`
  returns only projects the person can add a form to.
- An admin can limit the agent to Jira administrators from the app's page. Everyone else is
  then told to ask an administrator.
- The skill tells the agent to repeat the "needs attention" lines unchanged, so the limits of
  a conversion reach the person who asked.

## What was verified

The agent was used in Rovo Chat inside Jira on a real site, with the eleven sample forms:

- "Which InfoPath forms should we migrate first?" → it called `list-legacy-forms` and
  answered with the three wave 1 forms and one line each for waves 2 and 3.
- "What stops the Expense Report form from working?" → it called `get-legacy-form` and
  answered with the causes and their evidence.
- "Create the JSM form for Leave Request" → it called `list-service-projects`, offered the
  projects, took "Human Resources", showed Rovo's "Please review" step, and created the form
  after the confirmation.

The handlers were also run directly inside the Forge runtime: an unknown form name returned
the known names, and a create request with no user was refused.

Not yet tried on a real site: a create request from a person who does not administer the
project, and the "Jira administrators only" setting. Both are covered by tests that run the
backend against a stand-in for Forge.
