# InfoPath Afterlife for Jira Service Management

A Forge app that reads a team's old Microsoft InfoPath form templates, says what stops each
one from working, turns each into a native Jira Service Management (JSM) form in one step, and
gives Rovo the same knowledge so anyone can ask about the migration in plain words.

Built for Codegeist 2026, Business category.

## The problem

Microsoft set July 14, 2026 as the end of InfoPath:

- InfoPath Forms Services "will be removed from SharePoint Online for all tenants after
  July 14, 2026"
  ([Microsoft, June 2023](https://techcommunity.microsoft.com/t5/microsoft-sharepoint-blog/support-update-for-infopath-forms-services-in-microsoft-365/ba-p/3858190)).
- Extended support for InfoPath 2013 ended the same day
  ([Microsoft Lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/infopath-2013)).

HR, finance, legal and facilities teams still hold folders of `.xsn` templates: leave requests,
expense reports, purchase requests, onboarding checklists. Nobody remembers what is inside
them. A template is a cabinet file of XML, XSLT and schemas, so the people who must decide
what to move first cannot open it without the product that just ended.

## What the app does

The admin page has three steps, shown at the top until the first form is created: **Add**
templates, **Open** a form, **Create** the JSM form. Explanations sit behind a help icon next
to each heading, so the page stays short.

1. **Reads the templates.** A Jira admin drops `.xsn` files on the app's page in Jira
   settings. Each file is read in the admin's browser. Nothing is uploaded.
2. **Builds the migration plan.** Every form gets a wave:
   - Wave 1 converts to a native JSM form as it is.
   - Wave 2 works, with some parts simplified in the native form.
   - Wave 3 has parts a person must replace by hand (SQL connections, code-behind, ActiveX,
     digital signatures).
3. **Writes a death certificate per form.** Each cause is listed only when the template holds
   evidence for it, with the file and path of that evidence, the date, the source, and what
   replaces it.
4. **Creates the JSM form.** One button turns the form's default view into a JSM form in a
   service project and, if the admin picks a request type, shows it in the customer portal.
   A field map shows what happened to every InfoPath control, and a "Needs your attention"
   list names what a person still has to finish.
5. **Gives Rovo the context.** A Rovo agent, a Rovo skill and an MCP server share four
   actions: the plan, one form's analysis, the service projects the person asking administers,
   and creating a form. Someone who never
   saw InfoPath can ask "Which forms should we migrate first?" or "What stops the Expense
   Report form from working?" and get an answer taken from the analysis, not from guesses.

## Why it fits the theme

The Business category asks apps to "give business teams the context to act decisively". The
context here is knowledge that used to be locked inside files nobody could read: which forms
exist, how big they are, what they depend on, and what breaks. The app moves that knowledge
into Jira, where the admin page, Rovo and any MCP client can use it, and then lets the team
act on it in the same place.

## Measured results

All numbers come from the scripts in this repository or from calls to a real Jira site.

| What was measured | Result |
|---|---|
| Our 47 sample templates converted | 47 of 47 |
| Generated form designs accepted by the JSM Forms API on a real site | 47 of 47 |
| Questions created across those 47 forms | 540 |
| InfoPath controls converted as they are | 495 |
| Controls simplified (the field map says how) | 90 |
| Controls not converted (an ActiveX control) | 1 |
| A converted form published to a portal request type, then read back | worked |
| Admin page used inside Jira: 11 sample forms added, a form opened, its JSM form created, the form shown in the customer portal | worked |
| Rovo agent used in Rovo Chat inside Jira: the plan, one form, and creating a form after Rovo's confirm step | worked |
| Outbound network calls made by the app | none: the deployed version is eligible for Runs on Atlassian |

The 47 sample templates were written for this project and are MIT licensed. Eleven of them
ship with the app so anyone can try it without owning an InfoPath form.

Some things are **not yet tried on a real site**: connecting an outside MCP client, a person
who does not administer the project asking Rovo to create a form, the "Jira administrators
only" setting, and the dark theme. See "Limits".

## How it works

```
 Admin's browser (Custom UI in Jira settings)          Forge backend              Jira
 ┌───────────────────────────────────────────┐   ┌───────────────────────┐   ┌───────────┐
 │ .xsn file                                 │   │ resolver              │   │ Forms API │
 │   → engine: parse, build form model,      │   │   saveForm / listForms│   │ /forms/…  │
 │     triage (wave, causes, evidence)       │──▶│   createForm ─────────│──▶│           │
 │   → lib/convert: JSM form design          │   │ Forge key-value store │   └───────────┘
 │   → lib/summary: one record per form      │   │   form:<id>           │
 └───────────────────────────────────────────┘   │ Rovo actions          │◀── Rovo agent,
                                                 │   list, get, create,  │    skill, MCP
                                                 │   service projects    │
                                                 └───────────────────────┘
```

- `vendor/afterlife-core.mjs` is the InfoPath engine: it opens the cabinet file, parses the
  manifest, schemas and views, and classifies each part. It is a generated bundle of the
  MIT-licensed `@afterlife/core` package from the companion project
  [InfoPath Afterlife](#how-this-was-built). `scripts/vendor-core.mjs` regenerates it.
- `lib/convert.mjs` maps the default view's controls to JSM form questions. It is pure: no
  DOM, no Forge, no network, and the same template always gives the same design.
- `lib/summary.mjs` builds the record the app keeps about one form.
- `src/plan.mjs` is the backend: storage, the Forms API calls and the four Rovo actions. It
  takes Forge as a parameter, so the tests run it against a stand-in (`lib/fake-forge.mjs`).
  `src/index.js` only wires it to the real Forge modules.
- `ui/` is the admin page (React, Atlassian design tokens, follows the Jira theme).
- `prompts/agent.md` and `skills/infopath-migration-plan/SKILL.md` tell Rovo how to use the
  actions.

### What converts to what

| InfoPath control | JSM question |
|---|---|
| Text box | Short text; Number, Date, Time, Date and time or URL by the field's schema type; Email when the label says e-mail |
| Rich text box | Paragraph |
| Drop-down list, list box, combo box | Dropdown, with the options typed into the view |
| Option buttons | Radio buttons, one choice per button |
| Check box | Checkboxes with one choice |
| Date picker | Date |
| File attachment, picture | Attachment |
| Repeating table or section | One long text question, "one line per item", listing the columns |
| Calculated field | A question to fill by hand, with a note |
| Required field | Required question |
| Other validation rule | Help text on the question |
| ActiveX control, button, expression box | Not converted; listed in the field map |

Section titles become headings. Only the default view is converted; other views are named in
"Needs your attention", together with rule actions, data connections, code-behind and digital
signatures.

## Privacy and data

- Template files never leave the admin's browser. There is no upload and no external service:
  the manifest declares no egress.
- The app stores one record per form in Forge key-value storage on the site where it is
  installed: names, counts, causes with their evidence, the field map and the JSM form design.
  Evidence for a data connection names the connection and its server only; connection strings
  and credentials are not stored.
- Filled `.xml` records are matched to their template and counted. Their content is not saved.
- Creating a form needs the person asking to administer the target project. The app checks
  this as the user, and refuses when Jira cannot say who is asking.
- An admin chooses who may ask Rovo about the forms: everyone who can use Rovo (the default),
  or Jira administrators only.

## Install and try

Full steps are in [docs/SETUP.md](docs/SETUP.md). In short:

```
npm install
npm run build
forge register        # your own copy of the app
forge deploy
forge install --product jira
```

Then open Jira → Settings → Apps → **InfoPath Afterlife** and press **Try the 11 sample
forms**.

## Limits

- **Not yet tried on a real site:** the MCP server from an outside client (a site admin has to
  switch the tools on first), a create request from a person who does not administer the
  project, the "Jira administrators only" setting, and the dark theme. The refusal and the
  setting are covered by tests against a stand-in for Forge, not by a run in Jira.
- JSM forms have no repeating rows, no calculations and no rule actions, so those parts are
  simplified, and the app says so for each field instead of hiding it.
- The app attaches a form to an existing request type. It does not create request types: Jira
  refused that call for app permissions.
- Lists filled from a data source arrive empty. The field map tells the admin to add the
  choices or link the question to a Jira field or an Assets object.
- Filled records are counted, not imported.
- Workflows attached to a form library outside the template cannot be seen in the file.

## Development

| Command | What it does |
|---|---|
| `npm test` | 50 tests: every sample template converts to a well-formed design; file intake; analysis; the page's calls; the backend and the four actions against a stand-in for Forge |
| `AFTERLIFE_SAMPLES=<dir> npm test` | The same over any folder of `.xsn` files |
| `npm run dev` | Admin page at `http://127.0.0.1:4340` with an in-memory stand-in for Jira |
| `npm run build` | Builds the admin page into `static/admin` |
| `npm run vendor` | Regenerates the engine bundle from a checkout of the engine next to this folder |
| `forge lint` | Checks the manifest |

Node 22 is required.

## How this was built

This repository was written by hand with the help of an AI coding assistant. **It was not
built with Kiro.**

The InfoPath engine it bundles comes from a separate project, InfoPath Afterlife, a web viewer
for InfoPath forms whose code was written with Kiro for another hackathon. That engine reaches
this repository only as the generated file `vendor/afterlife-core.mjs`; the commit it was
built from is named in the file's first line. Everything else here (the converter, the
backend, the admin page, the Rovo agent, skill and MCP server) was written during the
Codegeist 2026 submission period.

## Licence

MIT, see [LICENSE](LICENSE). Bundled third-party code is listed in
[THIRD-PARTY.md](THIRD-PARTY.md).

InfoPath, SharePoint and Microsoft are trademarks of Microsoft. Jira, Jira Service Management,
Rovo and Forge are trademarks of Atlassian. This project is not affiliated with either company.
