---
name: infopath-migration-plan
description: Build an ordered plan for moving a team's Microsoft InfoPath forms to Jira Service Management, explain what stops one form from working, or create the JSM form for it. Use when the user asks which legacy forms to migrate first, what a form needs, or to convert a form.
license: MIT
allowed-tools: list-legacy-forms get-legacy-form create-jsm-form
---

# InfoPath migration plan

A Jira admin has analysed the organisation's InfoPath templates with the InfoPath Afterlife app.
The three actions below return that analysis. It is the only source of truth: never add a form,
a field, a date or a number that the actions did not return, and never estimate time or cost.

## Writing the plan

1. Call `list-legacy-forms`. If it returns no forms, tell the user that a Jira admin must first
   add the templates under Settings, Apps, InfoPath Afterlife, and stop.
2. Order the work by wave, then by name:
   - Wave 1 converts to a native JSM form as it is. These go first.
   - Wave 2 works, with some parts simplified in the native JSM form (repeating tables become
     one long text question, calculated values are typed by hand, only the default view is kept).
   - Wave 3 has parts a person must replace by hand: SQL or web-service connections,
     code-behind, ActiveX controls, digital signatures.
3. Give the totals per wave, then one line per form: name, wave, number of fields, and the
   causes of death. Say which forms already have a JSM form (`jsmFormsCreated`).
4. If `filledRecords` is present for a form, mention it: forms with many filled records are
   in real use and deserve attention first within their wave.

## Explaining one form

Call `get-legacy-form` with the form name (part of the name is enough). From the result:

- Start with the wave and what it means.
- List each cause of death with its date, the evidence found in the template, and what
  replaces it.
- Summarise the conversion: how many controls convert as they are, how many are simplified,
  how many are not converted. Then repeat every line of `needsAttention` unchanged.
- Show field details only when asked. `status` is `converted`, `simplified` or `skipped`;
  `note` says why.

If the action answers with `error` and `knownForms`, show the known names and ask which one
the user meant.

## Creating the JSM form

Call `create-jsm-form` only when the user asks to create or convert a form and has named the
service project. Ask for the project key if it is missing. The action refuses when the user
does not administer that project; pass the refusal on as it is.

After a successful call, say where the form is (Project settings, Forms), how many questions
it has, and repeat `needsAttention` so the user knows what to finish by hand. The form is not
shown in the customer portal until an admin attaches it to a request type, which the app's
admin page can do in the same step.
