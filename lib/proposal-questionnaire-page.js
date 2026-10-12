/**
 * The public questionnaire page (featreq-8f139178): what a prospect sees at
 * `GET /questionnaire/:token`, and how the form they post is read back.
 *
 * Plain HTML with no script and no external resource - it has to work on a
 * phone, in a mail client's built-in browser, and with JavaScript off. The page
 * shows the questions and nothing stored about anyone else (no record's
 * answers, no name it was sent to), because the token is bearer authorization.
 * Every value that reaches the HTML is escaped.
 *
 * Two steps on one link (Brittany, 2026-10-10): step 1 is About you, the basics,
 * the services and the software; step 2 asks only the counts the ticked
 * services need. Step 1 is kept on the record between the two (never as the
 * submission), so while the link is open, the link shows the prospect's OWN
 * step 1 back to them - the "You picked" line on step 2 and the re-filled form
 * behind "Back". A new link forgets it.
 */

import {
  cleanQuestionnaireAnswers,
  flattenQuestions,
  isRequiredOnLink,
  publicQuestionnaire,
  questionnaireMissingAnswers,
  questionnaireStepOne,
  questionnaireStepTwo,
} from './proposal-questionnaire.js'

const FIRM_NAME = 'PB&J Strategic Accounting'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char])

/** A form field's name for a question. Prefixed so no question can shadow anything else. */
export const questionFieldName = (id) => `q_${id}`

/**
 * Headers on EVERY answer from the public questionnaire route, pages and
 * redirects alike. Never cached, never framed, never sniffed, not indexed, and a content policy that allows
 * inline style and nothing else: no script, no image, no frame, forms only back
 * to this origin.
 *
 * The referrer policy is same-origin, NOT no-referrer like the pay pages: with
 * no-referrer a browser serializes the Origin of a form POST as "null", and the
 * same-origin check on the submit would refuse every real submission. The page
 * loads nothing and links only to itself (step 2's Back), so the URL (bearer
 * authorization) has no cross-origin request to ride on either way.
 */
export const QUESTIONNAIRE_RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
})

const STYLE = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f6f5f1; color: #1f1d1a; margin: 0; padding: 24px 16px 48px; line-height: 1.5; }
  main { max-width: 640px; margin: 0 auto; background: #fff; padding: 28px 24px; border-radius: 14px; box-shadow: 0 12px 40px rgba(31, 29, 26, 0.08); }
  h1 { margin: 0 0 12px; font-size: 22px; color: #7d2a4d; }
  h2 { margin: 28px 0 8px; font-size: 17px; color: #7d2a4d; border-top: 1px solid #ece8e1; padding-top: 18px; }
  p { margin: 0 0 14px; color: #555049; }
  label, fieldset { display: block; margin: 0 0 14px; }
  fieldset { border: 0; padding: 0; min-width: 0; }
  label > span, legend { display: block; font-weight: 600; margin-bottom: 4px; color: #1f1d1a; }
  small { display: block; color: #8a837a; font-size: 13px; margin-top: 3px; }
  input[type=text], input[type=email], input[type=tel], input[type=number], select, textarea { width: 100%; font: inherit; padding: 10px 12px; border: 1px solid #cfc9bf; border-radius: 8px; background: #fff; color: inherit; }
  textarea { min-height: 90px; }
  .check { display: flex; align-items: flex-start; gap: 10px; font-weight: 400; margin: 0 0 8px; }
  .check input { margin-top: 4px; width: 18px; height: 18px; flex: none; }
  .check span { font-weight: 400; margin: 0; }
  .errors { background: #fdf0f0; border: 1px solid #e3b4b4; border-radius: 8px; padding: 10px 14px; margin: 0 0 18px; color: #7a1f1f; }
  .errors ul { margin: 0; padding-left: 18px; }
  .field-error { color: #a12626; font-weight: 600; }
  input[aria-invalid=true], select[aria-invalid=true], textarea[aria-invalid=true] { border-color: #c95454; background: #fffafa; }
  .notice { font-size: 13px; color: #6b655d; background: #f6f5f1; border-radius: 8px; padding: 10px 12px; }
  button { font: inherit; font-weight: 600; color: #fff; background: #7d2a4d; border: 0; border-radius: 10px; padding: 12px 28px; cursor: pointer; }
  .step { font-size: 13px; font-weight: 600; color: #7d2a4d; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  a { color: #7d2a4d; font-weight: 600; }
  .status { text-align: center; }
`

function shell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<title>${esc(title)} - ${esc(FIRM_NAME)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`
}

/**
 * A page that says one thing: thank you, this link is not valid, this link has
 * run out. Says nothing about whose questionnaire it was.
 */
export function renderQuestionnaireStatusPage({ heading, body }) {
  return shell(
    heading,
    `<div class="status">
<h1>${esc(heading)}</h1>
<p>${esc(body)}</p>
</div>`,
  )
}

export const renderQuestionnaireThanksPage = () =>
  renderQuestionnaireStatusPage({
    heading: 'Thank you',
    body: 'We have your answers and will be in touch soon. You can close this page.',
  })

/** A token that names nothing and one that is malformed answer with EXACTLY this. */
export const renderQuestionnaireNotFoundPage = () =>
  renderQuestionnaireStatusPage({
    heading: 'This link is not valid',
    body: 'It may have been mistyped. Please use the link from the email we sent you, or reply to that email and we will send you a new one.',
  })

export const renderQuestionnaireClosedPage = () =>
  renderQuestionnaireStatusPage({
    heading: 'This link is no longer open',
    body: 'It has expired or been replaced. Please reply to the email we sent you and we will send a new link.',
  })

export const renderQuestionnaireAlreadyPage = () =>
  renderQuestionnaireStatusPage({
    heading: 'We already have your answers',
    body: 'Thank you - this questionnaire was already sent back. If something needs to change, just reply to our email.',
  })

/**
 * `problem` is the sentence for THIS field when the last send was refused for
 * it: the control is flagged and the sentence sits under it (the same sentence
 * is in the list at the top).
 */
function renderQuestion(question, values, problem) {
  const name = esc(questionFieldName(question.id))
  const help = question.help ? `<small>${esc(question.help)}</small>` : ''
  const required = isRequiredOnLink(question.id)
  const flags = `${required ? ' required' : ''}${problem ? ' aria-invalid="true"' : ''}`
  const note = problem ? `<small class="field-error">${esc(problem)}</small>` : ''
  const raw = values?.[questionFieldName(question.id)]
  const text = typeof raw === 'string' ? raw : ''

  if (question.type === 'multi') {
    const picked = new Set(Array.isArray(raw) ? raw : [])
    const boxes = (question.options ?? [])
      .map(
        (option) =>
          `<label class="check"><input type="checkbox" name="${name}" value="${esc(option.value)}"${
            picked.has(option.value) ? ' checked' : ''
          }><span>${esc(option.label)}</span></label>`,
      )
      .join('\n')
    return `<fieldset><legend>${esc(question.label)}</legend>${help}\n${boxes}</fieldset>`
  }

  let control
  if (question.type === 'longtext') {
    control = `<textarea name="${name}" maxlength="2000"${flags}>${esc(text)}</textarea>`
  } else if (question.type === 'choice') {
    const options = (question.options ?? [])
      .map(
        (option) =>
          `<option value="${esc(option.value)}"${option.value === text ? ' selected' : ''}>${esc(option.label)}</option>`,
      )
      .join('')
    control = `<select name="${name}"${flags}><option value=""></option>${options}</select>`
  } else {
    const type =
      question.type === 'email'
        ? 'email'
        : question.type === 'phone'
          ? 'tel'
          : question.type === 'number'
            ? 'number'
            : 'text'
    const extra =
      question.type === 'number'
        ? ' min="0" step="any" inputmode="decimal"'
        : question.type === 'email'
          ? ' maxlength="320" autocomplete="email"'
          : ' maxlength="200"'
    control = `<input type="${type}" name="${name}" value="${esc(text)}"${extra}${flags}>`
  }
  return `<label><span>${esc(question.label)}${required ? ' *' : ''}</span>${control}${note}${help}</label>`
}

/**
 * One step of the sent questionnaire as a form; it posts back to the page's own
 * address with a hidden `step`.
 *
 * Step 1 (the default): `values` re-fills the form - what the prospect just
 * posted after a refusal, or their own kept step 1 when they came Back
 * (`formValuesFromAnswers`); `errors` are sentences, each also flagged on its
 * field. Step 2: `saved` is the kept step 1, which decides the questions and the
 * "You picked" line; nothing else from it is shown.
 */
export function renderQuestionnairePage({ questionnaire, errors = [], values = {}, step = 1, saved = {} }) {
  if (step === 2) return renderStepTwo(questionnaire, saved)
  const view = questionnaireStepOne(questionnaire)
  // After a refused send, the same check the store ran - on what was just
  // posted - says which fields to flag. Never on a fresh page.
  const fieldProblems = new Map()
  if (errors.length > 0) {
    const questions = flattenQuestions(view)
    const answers = cleanQuestionnaireAnswers(questions, answersFromFormValues(values), {
      includeCallOnly: false,
    })
    for (const entry of questionnaireMissingAnswers(questions, answers, { mode: 'link' })) {
      fieldProblems.set(entry.id, entry.message)
    }
  }
  const errorBlock =
    errors.length > 0
      ? `<div class="errors" role="alert"><ul>${errors.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></div>`
      : ''
  const sections = view.sections
    .map(
      (section) =>
        `<h2>${esc(section.title)}</h2>\n${section.questions
          .map((question) => renderQuestion(question, values, fieldProblems.get(question.id)))
          .join('\n')}`,
    )
    .join('\n')
  return shell(
    'Tell us about your business',
    `<h1>Tell us about your business</h1>
<p>${esc(view.welcome)}</p>
<p class="step">Step 1 of 2</p>
<p>Answers marked * are required.</p>
${errorBlock}
<form method="post" accept-charset="utf-8">
<input type="hidden" name="step" value="1">
${sections}
${SENSITIVE_NOTICE}
<button type="submit">Next</button>
</form>`,
  )
}

const SENSITIVE_NOTICE =
  '<p class="notice">Please do not send passwords, EINs, Social Security numbers or bank account numbers on this form. We will ask for anything we need securely, later.</p>'

/**
 * Step 2: only the counts the ticked services need (`questionnaireStepTwo`), a
 * line saying what they picked, and a Back link to step 1 on the same link (a
 * GET with `?step=1`, which re-fills step 1 from what was kept). Its post is the
 * one submission.
 */
function renderStepTwo(questionnaire, saved) {
  const view = questionnaireStepTwo(questionnaire, saved)
  const recap =
    view.picked.length > 0
      ? `You picked: ${view.picked.map((entry) => esc(entry.label)).join(', ')}. A few questions about those, and you are done.`
      : 'You did not pick a service, so here are a few general questions.'
  const sections = view.sections
    .map(
      (section) =>
        `<h2>${esc(section.title)}</h2>\n${section.questions
          .map((question) => renderQuestion(question, {}, undefined))
          .join('\n')}`,
    )
    .join('\n')
  return shell(
    'Tell us about your business',
    `<h1>Tell us about your business</h1>
<p class="step">Step 2 of 2</p>
<p>${recap}</p>
<p><a href="?step=1">Back to step 1</a></p>
<form method="post" accept-charset="utf-8">
<input type="hidden" name="step" value="2">
${sections}
${SENSITIVE_NOTICE}
<button type="submit">Send to ${esc(FIRM_NAME)}</button>
</form>`,
  )
}

/**
 * The posted form, read against the questions a prospect is shown: one value per
 * text-like question, a list for each checkbox group. Anything that is not a
 * question is never read (the store drops it again regardless). Call-only
 * questions are not read at all.
 *
 * @param {string} body an application/x-www-form-urlencoded body
 * @returns {Record<string, string | string[]>} keyed by FIELD name (`q_<id>`),
 *   which is also what `renderQuestionnairePage` re-fills from
 */
export function readQuestionnaireForm(body, questionnaire) {
  const params = new URLSearchParams(String(body ?? ''))
  const values = {}
  for (const section of publicQuestionnaire(questionnaire).sections) {
    for (const question of section.questions) {
      const name = questionFieldName(question.id)
      if (question.type === 'multi') {
        const all = params.getAll(name)
        if (all.length > 0) values[name] = all
      } else if (params.has(name)) {
        values[name] = params.get(name)
      }
    }
  }
  return values
}

/** Field-name keys back to question ids, ready for the store. */
export function answersFromFormValues(values) {
  const answers = {}
  for (const [name, value] of Object.entries(values)) {
    if (name.startsWith('q_')) answers[name.slice(2)] = value
  }
  return answers
}

/**
 * The other way: kept (cleaned) answers as the form values a page re-fills from
 * - for step 1 behind Back, and to put step 1 back together with step 2 for the
 * send. A count becomes its text; a list stays a list of strings.
 */
export function formValuesFromAnswers(answers) {
  const values = {}
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return values
  for (const [id, value] of Object.entries(answers)) {
    if (Array.isArray(value)) {
      values[questionFieldName(id)] = value.filter((entry) => typeof entry === 'string')
    } else if (typeof value === 'string' || typeof value === 'number') {
      values[questionFieldName(id)] = String(value)
    }
  }
  return values
}

/**
 * Which step a post is: 1 only when the form says so. Anything else - step 2, or
 * a one-page form a prospect opened before the questionnaire had steps - is the
 * send.
 */
export function postedQuestionnaireStep(body) {
  return new URLSearchParams(String(body ?? '')).get('step') === '1' ? 1 : 2
}
