# Bonus write-up: MCP server (`rovo:mcp`)

## What was built

One `rovo:mcp` module, key `afterlife-mcp`, named "InfoPath Afterlife". It exposes the app's
four actions as MCP tools:

| Tool | Inputs | Result |
|---|---|---|
| `list-legacy-forms` | none | The migration plan: totals per wave, and one entry per analysed InfoPath form |
| `get-legacy-form` | `form` (name or part of it) | Causes of death with evidence, conversion counts, the attention list and the field map |
| `list-service-projects` | none | The service projects the person asking administers |
| `create-jsm-form` | `form`, `projectKey` | Creates the JSM form in that service project and returns where it is and what still needs a person |

The Rovo agent in this app uses the same four actions, so a person in Rovo Chat and a client
over MCP get the same answers from the same code.

`skills/infopath-migration-plan/SKILL.md` describes how to use the tools: how to order a
plan, how to explain one form, and when a form may be created.

## Why an MCP server

A migration is planned outside Jira as much as inside it: in a planning document, in a coding
assistant writing the replacement for a form's code-behind, in a script that reports progress.
Those tools speak MCP. With this server they can ask the site which legacy forms exist, what
each one depends on and whether its JSM form exists yet, without anyone exporting a
spreadsheet. A developer rewriting the logic of one form can have their assistant read which
events its code-behind handled, and on which fields, straight from `get-legacy-form`.

## Safety

- The tools read only what the admin page saved on this site. Template files are never
  stored, so they cannot be reached through MCP.
- `create-jsm-form` is the only tool that changes anything. It requires the invoking user to
  administer the target project and refuses when Jira provides no user.
- External exposure is off until a site admin switches it on for this installation, and each
  tool can be switched separately. An admin who wants read-only access leaves
  `create-jsm-form` off.
- The app has no egress, so nothing a tool returns can be sent elsewhere by the app.

## Connecting

1. Atlassian Administration → Apps → Sites → your site → Connected apps → InfoPath Afterlife:
   switch on the tools.
2. Add the remote MCP server `https://mcp.atlassian.com/forge/<appId>` to the client;
   `<appId>` is the UUID at the end of `app.id` in `manifest.yml`.
3. Approve the consent screen.

## What was verified

The four handlers behind the tools were used on a real site through the Rovo agent (see the
agent write-up for the results). The manifest passes `forge lint` and deploys.

Connecting an external MCP client has not been done yet: it needs a site admin to switch the
tools on in Atlassian Administration.
