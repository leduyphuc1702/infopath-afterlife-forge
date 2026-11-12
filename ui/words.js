// The words the page uses in more than one place.

export const SAMPLES = [
  '01-leave-request', '02-expense-report', '04-purchase-request', '05-new-hire-onboarding',
  '08-big-form', '12-vendor-onboarding', '16-equipment-loan', '20-course-evaluation',
  '44-contract-approval-task', '45-policy-acknowledgement', '46-vendor-onboarding-code',
];

export const WAVE_SHORT = { 1: 'Ready', 2: 'Simplified', 3: 'Manual work' };
export const WAVE_WORDS = {
  1: 'Converts to a native JSM form as it is',
  2: 'Works; some parts are simplified in a native form',
  3: 'Has parts a person must replace by hand',
};
export { CAUSE_WORDS } from '../lib/causes.mjs';
export const GUIDE = [
  ['Text box', 'Short text. Number, Date, Time, Date and time or URL when the field’s type says so; Email when the label says e-mail'],
  ['Rich text box', 'Paragraph'],
  ['Drop-down list, list box, combo box', 'Dropdown, with the options typed into the form'],
  ['Option buttons', 'Radio buttons, one choice per button'],
  ['Check box', 'Checkboxes with one choice'],
  ['Date picker', 'Date'],
  ['File attachment, picture', 'Attachment'],
  ['Repeating table or section', 'One long text question, one line per row'],
  ['Calculated field', 'A question to fill in by hand, with a note'],
  ['Required field', 'Required question'],
  ['Other validation rule', 'Help text on the question'],
  ['ActiveX control, button, expression box', 'Not converted; named in the field map'],
];
export const STEPS = [
  ['Add templates', 'Drop your .xsn files anywhere on this page, or try the sample forms. Files are read in your browser and never uploaded.'],
  ['Open a form', 'Each form gets a wave and a death certificate: what stops it from working, with the evidence found in the file.'],
  ['Create the JSM form', 'One click turns the form into a native Jira Service Management form, shown in your customer portal.'],
];
