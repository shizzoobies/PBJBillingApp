import { describe, expect, it } from 'vitest'
import { defaultProposalPricing } from './proposal-pricing.js'
import { buildQuestionnaire } from './proposal-questionnaire.js'
import {
  QUESTIONNAIRE_RESPONSE_HEADERS,
  answersFromFormValues,
  questionFieldName,
  readQuestionnaireForm,
  renderQuestionnaireAlreadyPage,
  renderQuestionnaireClosedPage,
  renderQuestionnaireNotFoundPage,
  renderQuestionnairePage,
  renderQuestionnaireThanksPage,
} from './proposal-questionnaire-page.js'

const questionnaire = buildQuestionnaire(defaultProposalPricing())

describe('the public form', () => {
  const html = renderQuestionnairePage({ questionnaire })

  it('opens with her welcome text and has every section a prospect is shown', () => {
    expect(html).toContain('keep the perfect books')
    for (const title of ['About you', 'Business basics', 'The numbers', 'Anything else']) {
      expect(html).toContain(`<h2>${title}</h2>`)
    }
  })

  it('works without JavaScript: a plain post form, no script, no external resource', () => {
    expect(html).toMatch(/<form method="post"/)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/\s(?:src|href)=/i)
    expect(html).not.toMatch(/https?:\/\//i)
    expect(html).toContain('name="viewport"')
    expect(html).toContain('noindex')
  })

  it('leaves out every question a prospect could not answer', () => {
    expect(html).not.toContain(questionFieldName('count:balanceSheetAccounts'))
    expect(html).not.toContain('Balance sheet accounts')
    expect(html).toContain(`name="${questionFieldName('count:transactions')}"`)
  })

  it('asks for a name and an email and nothing it should not', () => {
    expect(html).toMatch(/name="q_contactName"[^>]* required/)
    expect(html).toMatch(/name="q_email"[^>]* required/)
    expect(html).toMatch(/do not send passwords, EINs, Social Security numbers or bank account numbers/i)
    expect(html.toLowerCase()).not.toContain('type="password"')
  })

  it('draws checkboxes for the services and numbers that take a number', () => {
    expect(html).toMatch(/<input type="checkbox" name="q_services" value="Monthly"/)
    expect(html).toMatch(/<input type="number" name="q_count:transactions"[^>]*min="0"/)
  })

  it('shows nothing stored about anyone, even handed the whole record', () => {
    const record = { ...questionnaire, answers: { contactName: 'Pat Doe', company: 'Secret Co' }, sentTo: 'pat@acme.test' }
    const page = renderQuestionnairePage({ questionnaire: record })
    expect(page).not.toContain('Pat Doe')
    expect(page).not.toContain('Secret Co')
    expect(page).not.toContain('pat@acme.test')
  })

  it('puts back only what was just posted, escaped, with the problems above it', () => {
    const page = renderQuestionnairePage({
      questionnaire,
      errors: ['Please tell us your name.'],
      values: { q_company: '"><script>alert(1)</script>', q_services: ['Payroll'] },
    })
    expect(page).toContain('role="alert"')
    expect(page).toContain('Please tell us your name.')
    expect(page).not.toContain('<script>alert(1)</script>')
    expect(page).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(page).toMatch(/name="q_services" value="Payroll" checked/)
  })

  it('escapes a hostile label, help text or option from a frozen question', () => {
    const hostile = {
      welcome: 'Hi <b>there</b>',
      sections: [
        {
          id: 's',
          title: '<img src=x onerror=alert(1)>',
          questions: [
            { id: 'a', label: '<script>x</script>', type: 'text', help: '"quoted"' },
            {
              id: 'b',
              label: 'pick',
              type: 'choice',
              options: [{ value: '"><i>', label: '<u>one</u>' }],
            },
          ],
        },
      ],
    }
    const page = renderQuestionnairePage({ questionnaire: hostile })
    expect(page).not.toMatch(/<script>x<\/script>/)
    expect(page).not.toContain('<img src=x')
    expect(page).not.toContain('<b>there</b>')
    expect(page).not.toContain('<u>one</u>')
    expect(page).toContain('&lt;script&gt;x&lt;/script&gt;')
  })
})

describe('the other pages say one thing', () => {
  it('a malformed and an unknown token get the very same page', () => {
    expect(renderQuestionnaireNotFoundPage()).toBe(renderQuestionnaireNotFoundPage())
    expect(renderQuestionnaireNotFoundPage()).toContain('This link is not valid')
  })

  it('thank-you, closed and already-answered pages show no data', () => {
    for (const page of [
      renderQuestionnaireThanksPage(),
      renderQuestionnaireClosedPage(),
      renderQuestionnaireAlreadyPage(),
    ]) {
      expect(page).not.toMatch(/<form/i)
      expect(page).not.toMatch(/<script/i)
    }
    expect(renderQuestionnaireThanksPage()).toContain('Thank you')
  })
})

describe('the response headers', () => {
  it('are never cached, framed, sniffed or indexed, and allow no script', () => {
    expect(QUESTIONNAIRE_RESPONSE_HEADERS['Cache-Control']).toBe('no-store')
    expect(QUESTIONNAIRE_RESPONSE_HEADERS['X-Frame-Options']).toBe('DENY')
    expect(QUESTIONNAIRE_RESPONSE_HEADERS['X-Content-Type-Options']).toBe('nosniff')
    expect(QUESTIONNAIRE_RESPONSE_HEADERS['X-Robots-Tag']).toMatch(/noindex/)
    const csp = QUESTIONNAIRE_RESPONSE_HEADERS['Content-Security-Policy']
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toMatch(/script-src/)
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  // A form POST from a page sent with `no-referrer` carries `Origin: null`, which
  // the same-origin check would refuse - every real submission would fail.
  it('keep the referrer to the same origin, so a real form post still carries its Origin', () => {
    expect(QUESTIONNAIRE_RESPONSE_HEADERS['Referrer-Policy']).toBe('same-origin')
    expect(renderQuestionnairePage({ questionnaire })).toContain('name="referrer" content="same-origin"')
  })
})

describe('reading the posted form', () => {
  it('reads one value per question and a list per checkbox group', () => {
    const body = new URLSearchParams([
      ['q_company', 'Acme Books'],
      ['q_contactName', 'Pat Doe'],
      ['q_count:transactions', '120'],
      ['q_services', 'Monthly'],
      ['q_services', 'Payroll'],
    ]).toString()
    const values = readQuestionnaireForm(body, questionnaire)
    expect(values).toEqual({
      q_company: 'Acme Books',
      q_contactName: 'Pat Doe',
      'q_count:transactions': '120',
      q_services: ['Monthly', 'Payroll'],
    })
    expect(answersFromFormValues(values)).toEqual({
      company: 'Acme Books',
      contactName: 'Pat Doe',
      'count:transactions': '120',
      services: ['Monthly', 'Payroll'],
    })
  })

  it('never reads a field that is not a question a prospect is shown', () => {
    const body = new URLSearchParams([
      ['q_company', 'Acme'],
      ['q_count:balanceSheetAccounts', '12'],
      ['q_nonsense', 'x'],
      ['company', 'unprefixed'],
      ['__proto__', 'x'],
    ]).toString()
    expect(readQuestionnaireForm(body, questionnaire)).toEqual({ q_company: 'Acme' })
  })

  it('is fine with an empty or missing body', () => {
    expect(readQuestionnaireForm('', questionnaire)).toEqual({})
    expect(readQuestionnaireForm(undefined, questionnaire)).toEqual({})
  })
})
