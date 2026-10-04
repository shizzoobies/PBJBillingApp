/**
 * The public questionnaire page (featreq-8f139178): what a prospect sees at
 * `GET /questionnaire/:token`, and how the form they post is read back.
 *
 * Plain HTML with no script and no external resource - it has to work on a
 * phone, in a mail client's built-in browser, and with JavaScript off. The page
 * shows ONLY the questions: nothing stored about anyone (not an earlier answer,
 * not a name), because the token is bearer authorization and a forwarded link
 * must reveal nothing. Every value that reaches the HTML is escaped.
 */

import { publicQuestionnaire } from './proposal-questionnaire.js'

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
 * links nowhere and loads nothing, so the URL (bearer authorization) has no
 * cross-origin request to ride on either way.
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
  .notice { font-size: 13px; color: #6b655d; background: #f6f5f1; border-radius: 8px; padding: 10px 12px; }
  button { font: inherit; font-weight: 600; color: #fff; background: #7d2a4d; border: 0; border-radius: 10px; padding: 12px 28px; cursor: pointer; }
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

function renderQuestion(question, values) {
  const name = esc(questionFieldName(question.id))
  const help = question.help ? `<small>${esc(question.help)}</small>` : ''
  const required = question.id === 'contactName' || question.id === 'email'
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
    control = `<textarea name="${name}" maxlength="2000">${esc(text)}</textarea>`
  } else if (question.type === 'choice') {
    const options = (question.options ?? [])
      .map(
        (option) =>
          `<option value="${esc(option.value)}"${option.value === text ? ' selected' : ''}>${esc(option.label)}</option>`,
      )
      .join('')
    control = `<select name="${name}"><option value=""></option>${options}</select>`
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
    control = `<input type="${type}" name="${name}" value="${esc(text)}"${extra}${required ? ' required' : ''}>`
  }
  return `<label><span>${esc(question.label)}${required ? ' *' : ''}</span>${control}${help}</label>`
}

/**
 * The questionnaire as a form. `values` re-fills what the prospect just posted
 * after a refusal (their own input, never anything stored); `errors` are
 * sentences. The form posts back to the page's own address.
 */
export function renderQuestionnairePage({ questionnaire, errors = [], values = {} }) {
  const view = publicQuestionnaire(questionnaire)
  const errorBlock =
    errors.length > 0
      ? `<div class="errors" role="alert"><ul>${errors.map((line) => `<li>${esc(line)}</li>`).join('')}</ul></div>`
      : ''
  const sections = view.sections
    .map(
      (section) =>
        `<h2>${esc(section.title)}</h2>\n${section.questions
          .map((question) => renderQuestion(question, values))
          .join('\n')}`,
    )
    .join('\n')
  return shell(
    'Tell us about your business',
    `<h1>Tell us about your business</h1>
<p>${esc(view.welcome)}</p>
${errorBlock}
<form method="post" accept-charset="utf-8">
${sections}
<p class="notice">Please do not send passwords, EINs, Social Security numbers or bank account numbers on this form. We will ask for anything we need securely, later.</p>
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
