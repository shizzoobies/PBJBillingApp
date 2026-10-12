import { describe, expect, it } from 'vitest'
import { defaultProposalPricing } from './proposal-pricing.js'
import {
  buildQuestionnaire,
  cleanQuestionnaireAnswers,
  flattenQuestions,
  questionnaireProblems,
} from './proposal-questionnaire.js'
import {
  QUESTIONNAIRE_RESPONSE_HEADERS,
  answersFromFormValues,
  formValuesFromAnswers,
  postedQuestionnaireStep,
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

  it('opens on step 1 with her welcome text: about you, the basics, the services and the software', () => {
    expect(html).toContain('keep the perfect books')
    expect(html).toContain('Step 1 of 2')
    for (const title of ['About you', 'Business basics', 'Services you are interested in', 'Current software']) {
      expect(html).toContain(`<h2>${title}</h2>`)
    }
    for (const title of ['The numbers', 'How far behind the books are', 'Anything else']) {
      expect(html).not.toContain(`<h2>${title}</h2>`)
    }
    expect(html).toContain('<input type="hidden" name="step" value="1">')
    expect(html).toContain('<button type="submit">Next</button>')
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
    const stepTwo = renderQuestionnairePage({ questionnaire, step: 2, saved: {} })
    for (const page of [html, stepTwo]) {
      expect(page).not.toContain(questionFieldName('count:balanceSheetAccounts'))
      expect(page).not.toContain('Balance sheet accounts')
    }
    expect(stepTwo).toContain(`name="${questionFieldName('count:transactions')}"`)
  })

  it('asks for a name and an email and nothing it should not', () => {
    expect(html).toMatch(/name="q_contactName"[^>]* required/)
    expect(html).toMatch(/name="q_email"[^>]* required/)
    expect(html).toMatch(/do not send passwords, EINs, Social Security numbers or bank account numbers/i)
    expect(html.toLowerCase()).not.toContain('type="password"')
  })

  // Brittany, 2026-10-10: the business, phone, address and the two basics are required too.
  it('marks every required answer with a star and the browser `required`, and says what the star means', () => {
    for (const [id, label] of [
      ['company', 'Business name'],
      ['contactName', 'Your name'],
      ['email', 'Email'],
      ['phone', 'Phone'],
      ['addressLine1', 'Street address'],
      ['city', 'City'],
      ['state', 'State'],
      ['postalCode', 'ZIP code'],
    ]) {
      expect(html, id).toMatch(new RegExp(`<span>${label} \\*</span><input [^>]*name="q_${id}"[^>]* required`))
    }
    expect(html).toMatch(/<span>What does your business do\? \*<\/span><textarea name="q_whatTheyDo"[^>]* required>/)
    expect(html).toMatch(/<span>How is your business set up\? \*<\/span><select name="q_entityType" required>/)
    expect(html).toContain('<select name="q_entityType" required><option value=""></option>')
    expect(html).toContain('Answers marked * are required.')
  })

  it('leaves the suite line and the other questions optional', () => {
    for (const id of ['title', 'addressLine2', 'website', 'yearsInBusiness', 'fiscalYearEnd']) {
      expect(html, id).not.toMatch(new RegExp(`name="q_${id}"[^>]* required`))
    }
    expect(html).toContain('<span>Suite, unit or floor</span>')
  })

  it('shows no field message on a page nobody has sent yet', () => {
    expect(html).not.toContain('class="field-error"')
    expect(html).not.toContain('aria-invalid="true"')
  })

  // A prospect who opened the link before the page marked these (no `required` in
  // their browser) can still send without them: the refusal names each field,
  // both in the list at the top and under the field itself, with what they typed kept.
  it('names each missing answer under its own field when a send from an older page is refused', () => {
    const body = new URLSearchParams([
      ['q_contactName', 'Pat Doe'],
      ['q_email', 'pat@acme.test'],
      ['q_company', 'Acme Books'],
      ['q_addressLine2', 'Suite 4'],
    ]).toString()
    const values = readQuestionnaireForm(body, questionnaire)
    const questions = flattenQuestions(questionnaire)
    const errors = questionnaireProblems(
      questions,
      cleanQuestionnaireAnswers(questions, answersFromFormValues(values), { includeCallOnly: false }),
      { mode: 'link' },
    )
    expect(errors).toEqual([
      'Please give us a phone number.',
      'Please enter your street address.',
      'Please enter your city.',
      'Please enter your state.',
      'Please enter your ZIP code.',
      'Please tell us what your business does.',
      'Please choose how your business is set up.',
    ])
    const page = renderQuestionnairePage({ questionnaire, errors, values })
    expect(page).toContain('role="alert"')
    for (const line of errors) expect(page).toContain(`<li>${line}</li>`)
    expect(page).toMatch(/name="q_phone"[^>]* aria-invalid="true"[^>]*><small class="field-error">Please give us a phone number\.<\/small>/)
    // The blank first option is what lets `required` refuse an unpicked select.
    expect(page).toContain('<select name="q_entityType" required aria-invalid="true"><option value=""></option>')
    expect(page).toMatch(/<textarea name="q_whatTheyDo"[^>]* aria-invalid="true">/)
    expect(page).toContain('<small class="field-error">Please choose how your business is set up.</small>')
    // What they did fill in is put back and is not flagged.
    expect(page).toMatch(/name="q_company" value="Acme Books"[^>]* required>/)
    expect(page).toMatch(/name="q_addressLine2" value="Suite 4"/)
    expect(page.match(/class="field-error"/g)).toHaveLength(errors.length)
  })

  it('flags an email that is not an address, not just an empty one', () => {
    const values = { q_email: 'pat@' }
    const page = renderQuestionnairePage({
      questionnaire,
      errors: ['Please give us an email address we can reach you at.'],
      values,
    })
    expect(page).toMatch(/name="q_email" value="pat@"[^>]* aria-invalid="true"/)
  })

  it('draws checkboxes for the services and numbers that take a number', () => {
    expect(html).toMatch(/<input type="checkbox" name="q_services" value="Monthly"/)
    expect(renderQuestionnairePage({ questionnaire, step: 2, saved: { services: ['Monthly'] } })).toMatch(
      /<input type="number" name="q_count:transactions"[^>]*min="0"/,
    )
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

  it('escapes a hostile label, help text or option from a frozen question, on either step', () => {
    const hostileSection = (id) => ({
      welcome: 'Hi <b>there</b>',
      sections: [
        {
          id,
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
    })
    for (const page of [
      renderQuestionnairePage({ questionnaire: hostileSection('about') }),
      renderQuestionnairePage({ questionnaire: hostileSection('other'), step: 2, saved: {} }),
    ]) {
      expect(page).not.toMatch(/<script>x<\/script>/)
      expect(page).not.toContain('<img src=x')
      expect(page).not.toContain('<b>there</b>')
      expect(page).not.toContain('<u>one</u>')
      expect(page).toContain('&lt;script&gt;x&lt;/script&gt;')
    }
  })
})

// Brittany, 2026-10-10: "I thought when we sent it was going to ask questions
// based off what they said they needed".
describe('step 2: only what the ticked services need', () => {
  const saved = {
    company: 'Secret Co',
    contactName: 'Pat Doe',
    email: 'pat@acme.test',
    services: ['Payroll', 'Sales tax'],
  }
  const page = renderQuestionnairePage({ questionnaire, step: 2, saved })

  it('asks only the counts those services need, then Anything else', () => {
    expect(page).toContain('Step 2 of 2')
    expect(page).toContain(`name="${questionFieldName('count:employees')}"`)
    expect(page).toContain(`name="${questionFieldName('count:states')}"`)
    expect(page).toContain(`name="${questionFieldName('anythingElse')}"`)
    expect(page).not.toContain(`name="${questionFieldName('count:transactions')}"`)
    expect(page).not.toContain('<h2>How far behind the books are</h2>')
    // Nothing from step 1 is asked again.
    for (const id of ['company', 'contactName', 'email', 'services', 'software']) {
      expect(page, id).not.toContain(`name="${questionFieldName(id)}"`)
    }
  })

  it('says what they picked, in the words they ticked, and nothing else they typed', () => {
    expect(page).toContain('You picked: Payroll, Sales tax filing.')
    expect(page).not.toContain('Secret Co')
    expect(page).not.toContain('Pat Doe')
    expect(page).not.toContain('pat@acme.test')
  })

  it('has a Back link to step 1 on the same link, and still no script and nothing external', () => {
    expect(page).toContain('<a href="?step=1">Back to step 1</a>')
    expect(page.match(/\s(?:src|href)=/gi)).toHaveLength(1)
    expect(page).not.toMatch(/<script/i)
    expect(page).not.toMatch(/https?:\/\//i)
  })

  it('posts as step 2 and sends with the firm button', () => {
    expect(page).toMatch(/<form method="post"/)
    expect(page).toContain('<input type="hidden" name="step" value="2">')
    expect(page).toContain('<button type="submit">Send to PB&amp;J Strategic Accounting</button>')
    expect(page).toMatch(/do not send passwords, EINs, Social Security numbers or bank account numbers/i)
  })

  it('asks the general counts when nothing was ticked, and says so', () => {
    const general = renderQuestionnairePage({ questionnaire, step: 2, saved: { company: 'Acme' } })
    expect(general).toContain('You did not pick a service')
    expect(general).toContain(`name="${questionFieldName('count:transactions')}"`)
    expect(general).toContain(`name="${questionFieldName('count:cleanupMonths')}"`)
    expect(general).toContain('<h2>How far behind the books are</h2>')
  })

  it('escapes a hostile option label in the recap', () => {
    const hostile = {
      welcome: 'Hi',
      sections: [
        {
          id: 'services',
          title: 'Services',
          questions: [
            {
              id: 'services',
              label: 'pick',
              type: 'multi',
              options: [{ value: 'Payroll', label: '<img src=x onerror=alert(1)>' }],
            },
          ],
        },
        { id: 'other', title: 'Other', questions: [{ id: 'anythingElse', label: 'Else', type: 'longtext' }] },
      ],
    }
    const out = renderQuestionnairePage({ questionnaire: hostile, step: 2, saved: { services: ['Payroll'] } })
    expect(out).not.toContain('<img src=x')
    expect(out).toContain('You picked: &lt;img src=x onerror=alert(1)&gt;.')
  })
})

describe('Back to step 1', () => {
  it('turns saved answers back into the form values step 1 re-fills from', () => {
    expect(
      formValuesFromAnswers({
        company: 'Acme',
        'count:transactions': 120,
        services: ['Monthly', 'Payroll'],
      }),
    ).toEqual({
      q_company: 'Acme',
      'q_count:transactions': '120',
      q_services: ['Monthly', 'Payroll'],
    })
    expect(formValuesFromAnswers(null)).toEqual({})
  })

  it('re-fills step 1 from them, escaped, with the ticks kept', () => {
    const page = renderQuestionnairePage({
      questionnaire,
      step: 1,
      values: formValuesFromAnswers({ company: '"><b>x</b>', services: ['Payroll'], entityType: 'LLC' }),
    })
    expect(page).toContain('value="&quot;&gt;&lt;b&gt;x&lt;/b&gt;"')
    expect(page).toMatch(/name="q_services" value="Payroll" checked/)
    expect(page).toContain('<option value="LLC" selected>LLC</option>')
    expect(page).not.toContain('class="field-error"')
  })
})

describe('which step a post is', () => {
  it('is step 1 only when the form says so; anything else is the send', () => {
    expect(postedQuestionnaireStep('step=1&q_company=Acme')).toBe(1)
    expect(postedQuestionnaireStep('step=2')).toBe(2)
    // A one-page form opened before the questionnaire had steps is a send.
    expect(postedQuestionnaireStep('q_company=Acme')).toBe(2)
    expect(postedQuestionnaireStep('step=7')).toBe(2)
    expect(postedQuestionnaireStep(undefined)).toBe(2)
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
