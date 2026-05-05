import { useState } from 'react'
import { X } from 'lucide-react'
import type { Employee } from '../lib/types'
import { employeeName } from '../lib/utils'

/**
 * Per-client assigned-team chip picker. Mirrors the SharingControl visual
 * language. The owner sees this on each client to manage which non-owner
 * bookkeepers can see the client. Non-owners never render this.
 */
export function AssignedTeamControl({
  assignedIds,
  employees,
  onChange,
}: {
  assignedIds: string[]
  employees: Employee[]
  onChange: (nextIds: string[]) => void
}) {
  const [adderOpen, setAdderOpen] = useState(false)

  const eligible = employees.filter((employee) => employee.role !== 'Owner')
  const onList = new Set(assignedIds)
  const addable = eligible.filter((employee) => !onList.has(employee.id))

  const addPerson = (employeeId: string) => {
    if (assignedIds.includes(employeeId)) return
    onChange([...assignedIds, employeeId])
    setAdderOpen(false)
  }

  const removePerson = (employeeId: string) => {
    onChange(assignedIds.filter((id) => id !== employeeId))
  }

  return (
    <div className="sharing-control">
      <p className="sharing-helper">
        Only these team members can see this client. The owner always sees everything.
      </p>
      <div className="sharing-chips">
        {assignedIds.length === 0 ? (
          <span className="sharing-helper">No team members assigned yet.</span>
        ) : null}
        {assignedIds.map((employeeId) => (
          <span className="sharing-chip" key={employeeId}>
            <strong>{employeeName(employees, employeeId)}</strong>
            <button
              type="button"
              className="chip-remove"
              onClick={() => removePerson(employeeId)}
              aria-label={`Remove ${employeeName(employees, employeeId)}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {addable.length > 0 ? (
          <div className="sharing-add">
            <button
              type="button"
              className="add-person-pill"
              onClick={() => setAdderOpen((open) => !open)}
            >
              + Add team member
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
