---
name: infopath-migration-plan
description: Build an ordered plan for moving a team's Microsoft InfoPath forms to Jira Service Management, explain what stops one form from working, or create the JSM form for it. Use when the user asks which legacy forms to migrate first, what a form needs, or to convert a form.
license: MIT
allowed-tools: list-legacy-forms get-legacy-form list-service-projects create-jsm-form
---

# InfoPath migration plan

A Jira admin has analysed the organisation's InfoPath templates with the InfoPath Afterlife app.
The actions below return that analysis. It is the only source of truth: never add a form,
a field, a date or a number that the actions did not return, and never estimate time or cost.

## Which forms first

1. Call `list-legacy-forms`. If it returns no forms, tell the user that a Jira admin must first
   add the templates under Settings, Apps, InfoPath Afterlife, and stop.
2. Answer in a few lines:
   - Name the wave 1 forms, one line each with the number of fields. They convert to a native
     JSM form as they are, so they go first.
   - One line for wave 2: how many forms, and that some parts are simplified in the native JSM
     form (repeating tables become one long text question, calculated values are typed by
     hand, only the default view is kept).
   - One line for wave 3: how many forms, and that a person must replace parts by hand (SQL or
     web-service connections, code-behind, ActiveX controls, digital signatures).
   - Say which forms already have a JSM form (`jsmFormsCreated`).
3. Name the forms of wave 2 and wave 3 only when the user asks for them or for the whole plan.

## Writing the whole plan

Only when the user asks for the full plan or a document. Order by wave, then by name. Give the
totals per wave, then one line per form: name, number of fields, and the causes of death that
set it apart. Every form depends on InfoPath itself, which is going away: say that once, not
on every line. If `filledRecords` is present for a form, mention it: forms with many filled
records are in real use and deserve attention first within their wave.

## Explaining one form

Call `get-legacy-form` with the form name (part of the name is enough). From the result:

- Lead with the causes of death, one line each: the cause, its date, the evidence found in
  the template, and what replaces it.
- Then repeat every line of `needsAttention` unchanged.
- Say the wave and what it means in one line.
- Show conversion counts and field details only when asked. `status` is `converted`,
  `simplified` or `skipped`; `note` says why.

If the action answers with `error` and `knownForms`, show the known names and ask which one
the user meant.

## Creating the JSM form

Call `create-jsm-form` only when the user asks to create or convert a form. It needs a service
project. If the user did not name one, call `list-service-projects`: it returns the service
projects this person administers, which are the only ones they can add a form to. Show them
with name and key and ask which one. Never guess a project. The action refuses when the user
does not administer the project, and when the form was already created there; pass the
refusal on as it is.

After a successful call, say where the form is (Project settings, Forms), how many questions
it has, and repeat `needsAttention` so the user knows what to finish by hand. The form is not
shown in the customer portal until an admin attaches it to a request type, which the app's
admin page can do in the same step.
