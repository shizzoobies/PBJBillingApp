import { useState } from 'react'
import { Link2 } from 'lucide-react'
import type { ChecklistTemplate } from '../lib/types'
import {
  getChecklistFrequencyLabel,
  linkableClientChecklists,
  linkCandidatesForPlanTemplate,
} from '../lib/utils'

/**
 * "Link existing" on a Not set up plan checklist (featreq-2b067744).
 *
 * Brittany set her clients' checklists up by hand before packages existed, under
 * her own titles ("Quarterly Reconciliations with Review" for the blueprint
 * "Reconciliations with Review"), so Set up and Apply could not see them and
 * made duplicates next to hers. This lets her say "that one IS this one": the
 * link stamps her checklist's `sourceTemplateId` with the blueprint, which the
 * Set up / Apply / nudge rules already honor.
 *
 * Suggested checklists (same title once a leading cadence word is dropped, the
 * cadence agreeing with the checklist's schedule, switched on) get one-press
 * buttons; any other linkable checklist of the client can be chosen from the
 * list, each labeled with how often it repeats and "(off)" when switched off.
 * Nothing renders when the client has no linkable checklist.
 */

/** "<title> · <how often>", plus "(off)" for a switched-off recipe. */
function candidateLabel(template: ChecklistTemplate): string {
  const off = template.active === false ? ' (off)' : ''
  return `${template.title} · ${getChecklistFrequencyLabel(template.frequency)}${off}`
}

export function LinkExistingChecklist({
  blueprint,
  clientId,
  templates,
  onLink,
}: {
  blueprint: ChecklistTemplate
  clientId: string
  templates: readonly ChecklistTemplate[]
  onLink: (clientTemplateId: string) => void
}) {
  const [choice, setChoice] = useState('')
  const all = linkableClientChecklists(clientId, templates)
  if (all.length === 0) return null
  const suggested = linkCandidatesForPlanTemplate(blueprint, clientId, templates)
  const suggestedIds = new Set(suggested.map((template) => template.id))
  const others = all.filter((template) => !suggestedIds.has(template.id))
  // A pick that has since left the list (linked elsewhere, deleted) reads as no pick.
  const chosen = others.some((template) => template.id === choice) ? choice : ''
  return (
    <span className="plan-checklist-link">
      {suggested.map((template) => (
        <button
          key={template.id}
          type="button"
          className="link-button"
          aria-label={`Link ${template.title} as ${blueprint.title}`}
          onClick={() => onLink(template.id)}
        >
          <Link2 size={12} /> Link &ldquo;{candidateLabel(template)}&rdquo;
        </button>
      ))}
      {others.length > 0 ? (
        <>
          <select
            className="plan-checklist-link-select"
            aria-label={`Choose a checklist to link as ${blueprint.title}`}
            value={chosen}
            onChange={(event) => setChoice(event.target.value)}
          >
            <option value="">
              {suggested.length > 0 ? 'Choose another…' : 'Link existing…'}
            </option>
            {others.map((template) => (
              <option key={template.id} value={template.id}>
                {candidateLabel(template)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="link-button"
            disabled={!chosen}
            aria-label={`Link the chosen checklist as ${blueprint.title}`}
            onClick={() => {
              // Only a checklist that is STILL linkable; otherwise just reset.
              if (chosen) onLink(chosen)
              setChoice('')
            }}
          >
            Link
          </button>
        </>
      ) : null}
    </span>
  )
}

