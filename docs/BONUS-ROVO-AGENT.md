# Bonus write-up: Rovo agent (and skill)

## What was built

- A **Rovo agent**, `rovo:agent` key `afterlife-agent`, named "InfoPath Afterlife".
- A **Rovo skill**, `rovo:skill` key `infopath-migration-plan`
  (`skills/infopath-migration-plan/SKILL.md`), which the agent declares in `skills`.
- Four **actions** the agent and the skill use:

| Action | Verb | What it returns |
|---|---|---|
| `list-legacy-forms` | GET | Every analysed InfoPath form: wave, fields, rules, data connections, causes of death, filled records, where a JSM form was already created, and whether it is live in the portal or still waits for a portal group |
| `get-legacy-form` | GET | One form's death certificate (causes, dates, evidence, what replaces each), its field-by-field conversion map, and for each JSM form made from it the portal link and whether it is live or waiting for a portal group |
| `list-service-projects` | GET | The service projects the person asking administers, the only ones they can add a form to |
| `create-jsm-form` | CREATE | Replaces one analysed form in a named service project: makes a request type named after it, puts the JSM form on it, and returns the customer portal link, whether the form is live yet, and the step left when it is not |

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
  "Please review" step, and only a confirmed request creates anything. The app then makes a
  request type named after the form and puts the JSM form on it. The agent says that one
  step is left (a project administrator adds the request type to a portal group), links that
  settings page, gives the link people will use, and repeats what a person still has to
  finish.
- "Where do people fill in the Leave Request form now?" → the portal link when the form is
  live, or the step that is left when it is not, from `get-legacy-form`. The person asking
  never has to open the admin page.

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
- The agent never builds a link. The backend puts the portal link together from the site's own
  address and the ids Jira returned, and the prompt tells the agent to pass it on as it is.
- The agent never calls a form live on its own. Jira lets people send a request type only
  when it is in a portal group, so the backend reads the groups of each request type from
  Jira and returns `liveInPortal`. While that is false the agent passes on the step that is
  left, word for word, with the link to the settings page.
- When the form cannot be created, the request type made for it a moment earlier is taken
  back, so a failed request leaves nothing in the project.

## What was verified

The agent was used in Rovo Chat inside Jira on a real site, with the eleven sample forms:

- "Which InfoPath forms should we migrate first?" → it called `list-legacy-forms` and
  answered with the three wave 1 forms and one line each for waves 2 and 3.
- "What stops the Expense Report form from working?" → it called `get-legacy-form` and
  answered with the causes and their evidence.
- "Create the JSM form for Leave Request" → it called `list-service-projects`, offered the
  projects, took "Human Resources", showed Rovo's "Please review" step, and created the form
  after the confirmation.

With version 1.1.0, again in Rovo Chat inside Jira:

- "Where do people fill in the Course Evaluation form now? And the Vendor Onboarding form?"
  → for Course Evaluation, whose request type had been added to a portal group, it gave the
  portal link. For Vendor Onboarding, still in no group, it said the form is not live yet,
  named the step for a project administrator, linked the project's Portal groups page, and
  gave the link people will use afterwards.
- "Replace the Equipment Loan form in the Facilities project (FAC)." → Rovo showed "Please
  review" with the form and the project key. After the confirmation the agent answered that
  the request type "Equipment Loan" was created with a form of 6 questions, that one step is
  left before people can use it, linked the Portal groups page of that project, and gave the
  link people will use once it is done.

The handlers were also run directly inside the Forge runtime: an unknown form name returned
the known names, and a create request with no user was refused.

Not yet tried on a real site: a create request from a person who does not administer the
project, and the "Jira administrators only" setting. Both are covered by tests that run the
backend against a stand-in for Forge.
