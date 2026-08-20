import { Download, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useAppContext } from '../AppContext'
import type { AssistantReport } from '../lib/api'
import { isSafeImageSrc } from '../lib/utils'

/**
 * Displays an assistant-generated report in a modal and offers "Save as PDF"
 * via the browser print path. A hidden `.print-document` holds the print-only
 * sheet (with the firm header); the `@media print` rules under
 * `body.printing-report` swap the app for just that sheet. That sheet must be
 * portaled OUTSIDE #root for those rules to work — see the comment on it.
 */
export function AssistantReportModal({
  report,
  onClose,
}: {
  report: AssistantReport
  onClose: () => void
}) {
  const { firmSettings } = useAppContext()
  const firmName = firmSettings?.name || 'PB&J Strategic Accounting'
  const logoUrl = firmSettings?.logoUrl || ''

  const savePdf = () => {
    document.body.classList.add('printing-report')
    const cleanup = () => {
      document.body.classList.remove('printing-report')
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
    window.print()
    // Fallback in case afterprint doesn't fire (some browsers/cancel paths).
    window.setTimeout(cleanup, 2000)
  }

  const sections = report.sections.map((section, index) => (
    <section className="report-section" key={index}>
      <h3>{section.heading}</h3>
      {section.stats && section.stats.length > 0 ? (
        <div className="report-stats">
          {section.stats.map((stat, statIndex) => (
            <div className="report-stat" key={statIndex}>
              <span className="report-stat-value">{stat.value}</span>
              <span className="report-stat-label">{stat.label}</span>
            </div>
          ))}
        </div>
      ) : null}
      {section.paragraphs?.map((paragraph, pIndex) => <p key={pIndex}>{paragraph}</p>)}
      {section.table && section.table.columns.length > 0 ? (
        <table className="report-table">
          <thead>
            <tr>
              {section.table.columns.map((column, cIndex) => (
                <th key={cIndex}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {section.table.rows.map((row, rIndex) => (
              <tr key={rIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  ))

  return (
    <>
      <div
        className="report-modal-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={report.title}
      >
        <div className="report-modal">
          <header className="report-modal-head">
            <div className="report-modal-title">
              <strong>{report.title}</strong>
              {report.subtitle ? <span>{report.subtitle}</span> : null}
            </div>
            <div className="report-modal-actions">
              <button type="button" className="primary-action" onClick={savePdf}>
                <Download size={14} /> Save as PDF
              </button>
              <button
                type="button"
                className="report-modal-close"
                aria-label="Close report"
                onClick={onClose}
              >
                <X size={16} />
              </button>
            </div>
          </header>
          <div className="report-modal-body">{sections}</div>
        </div>
      </div>

      {/* Print-only sheet — hidden on screen, shown under body.printing-report.
          PORTALED TO <body> ON PURPOSE: the print rules hide #root and show
          only this sheet, and this modal renders inside #root. Left in place it
          would be a DESCENDANT of the hidden element, which no rule can bring
          back — "Save as PDF" produced a blank page. #root rather than the app
          shell because #root's `min-height: 100vh` measures against the PAGE
          box when printing, so hiding only its contents still costs a full
          blank sheet. Same fix, and same reason, as the invoice sheet in
          pages/InvoicesPage.tsx. */}
      {createPortal(
        <div className="print-document report-print" aria-hidden="true">
          <div className="report-print-sheet">
            <div className="print-header">
              {logoUrl && isSafeImageSrc(logoUrl) ? (
                <img className="print-header-logo" src={logoUrl} alt="" />
              ) : null}
              <div className="print-header-firm-text">
                <strong>{firmName}</strong>
              </div>
            </div>
            <h1>{report.title}</h1>
            {report.subtitle ? <p className="report-print-subtitle">{report.subtitle}</p> : null}
            {sections}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
