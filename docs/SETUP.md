# Setup

Two ways to get the app onto a Jira site: the install link from the submission, or your own
copy built from this repository. Either way you need a Jira Cloud site with **Jira Service
Management** and a user who is a Jira admin on it.

## A. Install from the link

1. Open the install link given in the submission while signed in as a site admin.
2. Choose your site and the product **Jira**, then accept the permissions listed below.
3. Continue at "First run".

## B. Build and install your own copy

You need Node 22 and the Forge CLI.

```
npm install -g @forge/cli
forge login
```

Then, in this folder:

```
npm install
npm test              # 50 tests: conversion, file intake, analysis, backend and actions
npm run build         # builds the admin page into static/admin
forge register        # creates your own app id and writes it to manifest.yml
forge deploy
forge install --product jira --site <your-site>.atlassian.net
```

`npm run vendor` is not needed. The InfoPath engine is already in `vendor/`; that script only
regenerates it from a checkout of the engine.

## Permissions the app asks for

| Scope | Why |
|---|---|
| `storage:app` | Keeps one record per analysed form in Forge key-value storage |
| `read:jira-work` | Reads forms and whether a request type already has one |
| `read:jira-user` | Checks that the person creating a form administers the project |
| `read:servicedesk-request` | Lists service projects and their request types |
| `manage:jira-project` | Creates the form in the project |

The app makes no outbound network calls.

## First run

1. In Jira, open **Settings (gear) → Apps → InfoPath Afterlife** in the left menu.
   The page shows three steps: **Add**, **Open**, **Create**. Hover a help icon (?) for the
   explanation of anything on the page.
2. **Add.** Press **Try the 11 sample forms**. The page reads eleven bundled templates in your
   browser and saves their analysis. You should see:

   | | |
   |---|---|
   | Forms | 11 |
   | Wave 1, Ready | 3 (Big Form, Course Evaluation, Vendor Onboarding) |
   | Wave 2, Simplified | 2 (Equipment Loan, New Hire Onboarding) |
   | Wave 3, Manual work | 6 (Contract Approval Task, Expense Report, Leave Request, Policy Acknowledgement, Purchase Request, Vendor Onboarding with code-behind) |

3. **Open.** Click **Purchase Request**. The page shows its death certificate (three causes,
   each with the evidence found in the file) and the field map: 13 questions, 8 controls
   converted as they are and 8 simplified.
4. **Create.** Choose a service project. Optionally choose a request type that has no form
   yet, to show the form in the customer portal. Press **Create JSM form**. It takes ten to
   twenty seconds.
5. Follow **Open it in the portal** if you chose a request type, or **Open the project's
   forms** to see the new form in Project settings → Forms.
6. The download icon above the table exports the plan as CSV.

To use your own templates, drop `.xsn` files, or a whole folder, anywhere on the page. Add
filled `.xml` records in the same drop to have them counted per form. Files that are not
InfoPath templates are named in the status line and skipped.

The sliders icon at the top right sets who may ask Rovo about the forms: everyone who can use
Rovo (the default), or Jira administrators only.

## Rovo agent

1. Open Rovo Chat in Jira and choose the agent **InfoPath Afterlife**.
2. Try the conversation starters:
   - "Which InfoPath forms should we migrate first?"
   - "What stops the Expense Report form from working?"
   - "Create the JSM form for Leave Request". The agent lists the service projects you
     administer and asks which one. Rovo then shows a **Please review** step; the form is
     created only after you confirm.

The conversation starters appear in a new chat only. The agent answers only from what the
admin page saved. With no forms analysed it says so and
points to the admin page.

## MCP server

The same four actions are exposed as MCP tools.

1. A site or organisation admin switches the tools on: Atlassian Administration → Apps →
   Sites → your site → Connected apps → InfoPath Afterlife. External MCP exposure is off by
   default and is set per installation.
2. In an MCP client, add the remote server `https://mcp.atlassian.com/forge/<appId>`, where
   `<appId>` is the UUID at the end of `app.id` in `manifest.yml`.
3. Approve the consent screen and pick the site.

Tools: `list-legacy-forms`, `get-legacy-form` (input `form`), `list-service-projects`,
`create-jsm-form` (inputs `form` and `projectKey`).

## Removing test data

- In the admin page, open a form and press **Remove from the plan** to delete its record.
- Forms created in a project are ordinary JSM forms: delete them under Project settings →
  Forms.
- `forge uninstall` removes the app and its storage from the site.

## Local preview without Jira

```
npm run dev
```

opens the admin page at `http://127.0.0.1:4340` with an in-memory stand-in for Jira: analysis
and conversion are real, storage and "Create JSM form" are faked. It is for working on the
page, not for judging the app.
