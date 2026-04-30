import { useState } from 'react'
import { X } from 'lucide-react'
import type { Employee } from '../lib/types'
import { employeeName } from '../lib/utils'

/**
 * Compact sharing control. Renders the assignee plus a list of viewer/editor
 * chips. Each chip has a status toggle ("Viewer" / "Can complete") and a remove
 * button. "+ Add person" opens a small dropdown of employees not yet on the list.
 */
export function SharingControl({
  assigneeId,
  viewerIds,
  editorIds,
  employees,
  onChange,
}: {
  assigneeId: string
  viewerIds: string[]
  editorIds: string[]
  employees: Employee[]
  onChange: (viewerIds: string[], editorIds: string[]) => void
}) {
  const [adderOpen, setAdderOpen] = useState(false)

  const eligible = employees.filter(
    (employee) => employee.id !== assigneeId && employee.role !== 'Owner',
  )
  const peopleOnList = new Set([assigneeId, ...viewerIds])
  const addable = eligible.filter((employee) => !peopleOnList.has(employee.id))

  const addPerson = (employeeId: string) => {
    onChange([...viewerIds, employeeId], editorIds)
    setAdderOpen(false)
  }

  const removePerson = (employeeId: string) => {
    onChange(
      viewerIds.filter((id) => id !== employeeId),
      editorIds.filter((id) => id !== employeeId),
    )
  }

  const togglePermission = (employeeId: string) => {
    if (editorIds.includes(employeeId)) {
      onChange(viewerIds, editorIds.filter((id) => id !== employeeId))
    } else {
      onChange(viewerIds, [...editorIds, employeeId])
    }
  }

  return (
    <div className="sharing-control">
      <p className="sharing-helper">
        Viewers see this on their Gantt and dashboard. &quot;Can complete&quot; lets them check
        items off.
      </p>
      <div className="sharing-chips">
        <span className="sharing-chip owner-chip" title="Assignee (owner of this checklist)">
          <strong>{employeeName(employees, assigneeId)}</strong>
          <span className="chip-status">Owner</span>
        </span>
        {viewerIds.map((employeeId) => {
          const isEditor = editorIds.includes(employeeId)
          return (
            <span className="sharing-chip" key={employeeId}>
              <strong>{employeeName(employees, employeeId)}</strong>
              <button
                type="button"
                className="chip-status chip-toggle"
                onClick={() => togglePermission(employeeId)}
                title="Click to toggle between Viewer and Can complete"
              >
                {isEditor ? 'Can complete' : 'Viewer'}
              </button>
              <button
                type="button"
                className="chip-remove"
                onClick={() => removePerson(employeeId)}
                aria-label={`Remove ${employeeName(employees, employeeId)}`}
              >
                <X size={12} />
              </button>
            </span>
          )
        })}
        {addable.length > 0 ? (
          <div className="sharing-add">
            <button
              type="button"
              className="add-person-pill"
              onClick={() => setAdderOpen((open) => !open)}
            >
              + Add person
            </button>
            {adderOpen ? (
              <div className="sharing-add-menu" role="menu">
                {addable.map((employee) => (
                  <button
                    key={employee.id}
                    type="button"
                    role="menuitem"
                    onClick={() => addPerson(employee.id)}
                  >
                    {employee.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
