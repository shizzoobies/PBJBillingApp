import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AssistantReportModal } from '../components/AssistantReportModal'
import type { AssistantReport } from '../lib/api'

/**
 * "Save as PDF" on an assistant report is the same CSS print path the invoice
 * uses, and it had the same defect: `body.printing-report #root { display:
 * none }` cannot be undone for a sheet rendered INSIDE #root, which is where
 * this modal lives. The result was a blank PDF.
 *
 * Structure is all jsdom can see — no print stylesheet, no pagination. The
 * printed result is measured by scripts/check-print-pdf.mjs.
 */

vi.mock('../AppContext', () => ({
  useAppContext: () => ({
    firmSettings: { name: 'PB&J Strategic Accounting' },
  }),
}))

const report: AssistantReport = {
  title: 'August billing summary',
  subtitle: 'All clients',
  sections: [{ heading: 'Hours', paragraphs: ['Ninety-one billable hours in August.'] }],
}

function renderInRoot() {
  return render(
    <div id="root">
      <div className="app-shell">
        <AssistantReportModal report={report} onClose={vi.fn()} />
      </div>
    </div>,
  )
}

describe('AssistantReportModal — the printable report sheet', () => {
  it('renders the report sheet outside #root, so the PDF is not blank', () => {
    renderInRoot()

    const sheet = document.querySelector('.report-print')
    expect(sheet).not.toBeNull()
    expect(sheet?.querySelector('.report-print-sheet')).not.toBeNull()
    expect(document.querySelector('#root .report-print')).toBeNull()
    expect(sheet?.parentElement).toBe(document.body)
  })

  it('carries the report content onto the printed sheet', () => {
    renderInRoot()

    const sheet = document.querySelector('.report-print')!
    expect(sheet.textContent).toContain('August billing summary')
    expect(sheet.textContent).toContain('Ninety-one billable hours in August.')
    expect(sheet.textContent).toContain('PB&J Strategic Accounting')
  })

  // The report sheet must NOT pick up the invoice rules. They are keyed on
  // `.invoice-print` precisely so that a report printed from the Invoices page
  // — where the invoice sheet is always mounted — is not replaced by, or
  // stacked with, the invoice.
  it('does not wear the invoice print class', () => {
    renderInRoot()

    expect(document.querySelector('.report-print')!.classList.contains('invoice-print')).toBe(
      false,
    )
  })
})
