import { ChevronRight, Plus, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import type {
  BillingMode,
  Client,
  Employee,
  SubscriptionPlan,
} from '../lib/types'
import { currency, employeeName, getAssignedEmployeeIds } from '../lib/utils'

export function ClientsPage() {
  const { ownerMode, visibleClients, data, updateClientPlan, addClient } = useAppContext()

  return (
    <section className={ownerMode ? 'content-grid client-layout' : 'panel'} id="clients">
      <div className={ownerMode ? 'panel' : undefined}>
        <div className="section-heading">
          <div>
            <p className="section-kicker">
              {ownerMode ? 'Owner client controls' : 'Assigned client work'}
            </p>
            <h2>Clients</h2>
          </div>
        </div>
        <ClientTable
          clients={visibleClients}
          employees={data.employees}
          onUpdatePlan={updateClientPlan}
          ownerMode={ownerMode}
          plans={data.plans}
        />
      </div>
      {ownerMode ? (
        <ClientBuilder
          employees={data.employees.filter((employee) => employee.role !== 'Owner')}
          onCreate={addClient}
          plans={data.plans}
        />
      ) : (
        <VisibilityPanel visibleClients={visibleClients} />
      )}
    </section>
  )
}

function VisibilityPanel({ visibleClients }: { visibleClients: Client[] }) {
  return (
    <section className="panel visibility-panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Access boundary</p>
          <h2>Visible work</h2>
        </div>
      </div>
      <div className="visibility-copy">
        <ShieldCheck size={34} />
        <p>
          This employee view is scoped to assigned checklists, clients, and time entries.
          Owner-only invoices, subscription controls, and other employees&apos; hours are hidden
          from this role.
        </p>
      </div>
      <div className="client-chip-list">
        {visibleClients.map((client) => (
          <span key={client.id}>{client.name}</span>
        ))}
      </div>
    </section>
  )
}

function ClientBuilder({
  employees,
  onCreate,
  plans,
}: {
  employees: Employee[]
  onCreate: (client: Omit<Client, 'id'>) => void
  plans: SubscriptionPlan[]
}) {
  const [name, setName] = useState('Summit Retail Co.')
  const [contact, setContact] = useState('Jamie Miller')
  const [hourlyRate, setHourlyRate] = useState('135')
  const [billingMode, setBillingMode] = useState<BillingMode>('hourly')
  const [planId, setPlanId] = useState(plans[0]?.id ?? '')
  const [assignedEmployeeIds, setAssignedEmployeeIds] = useState<string[]>(
    employees[0] ? [employees[0].id] : [],
  )

  const toggleEmployee = (employeeId: string) => {
    setAssignedEmployeeIds((current) =>
      current.includes(employeeId)
        ? current.filter((id) => id !== employeeId)
        : [...current, employeeId],
    )
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const rate = Number(hourlyRate)
    if (!name || !contact || Number.isNaN(rate) || rate <= 0 || assignedEmployeeIds.length === 0) {
      return
    }

    onCreate({
      name,
      contact,
      billingMode,
      hourlyRate: rate,
      planId: billingMode === 'subscription' ? planId || plans[0]?.id || null : null,
      assignedEmployeeIds,
    })
    setName('')
    setContact('')
    setHourlyRate('135')
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Owner setup</p>
          <h2>Add client</h2>
        </div>
      </div>
      <form className="form-grid single" onSubmit={handleSubmit}>
        <label className="field">
          <span>Client name</span>
          <input
            className="input"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <label className="field">
          <span>Primary contact</span>
          <input
            className="input"
            onChange={(event) => setContact(event.target.value)}
            value={contact}
          />
        </label>
        <label className="field">
          <span>Hourly rate</span>
          <input
            className="input"
            min="1"
            onChange={(event) => setHourlyRate(event.target.value)}
            step="5"
            type="number"
            value={hourlyRate}
          />
        </label>
        <label className="field">
          <span>Billing type</span>
          <select
            className="input"
            onChange={(event) => setBillingMode(event.target.value as BillingMode)}
            value={billingMode}
          >
            <option value="hourly">Hourly</option>
            <option value="subscription">Subscription</option>
          </select>
        </label>
        {billingMode === 'subscription' && (
          <label className="field">
            <span>Subscription plan</span>
            <select
              className="input"
              onChange={(event) => setPlanId(event.target.value)}
              value={planId}
            >
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="assignment-field">
          <legend>Assigned employees</legend>
          {employees.map((employee) => (
            <label className="check-row" key={employee.id}>
              <input
                checked={assignedEmployeeIds.includes(employee.id)}
                onChange={() => toggleEmployee(employee.id)}
                type="checkbox"
              />
              <span>{employee.name}</span>
            </label>
          ))}
        </fieldset>
        <button className="primary-action" type="submit">
          <Plus size={16} />
          Add client
        </button>
      </form>
    </section>
  )
}

function ClientTable({
  clients,
  employees,
  onUpdatePlan,
  ownerMode,
  plans,
}: {
  clients: Client[]
  employees: Employee[]
  onUpdatePlan: (clientId: string, billingMode: BillingMode, planId: string | null) => void
  ownerMode: boolean
  plans: SubscriptionPlan[]
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Contact</th>
            <th>Billing</th>
            <th>Rate</th>
            <th>Assigned team</th>
            <th>Subscription plan</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((client) => {
            const plan = plans.find((item) => item.id === client.planId)
            return (
              <tr key={client.id}>
                <td>
                  {ownerMode ? (
                    <Link className="client-name-link" to={`/clients/${client.id}`}>
                      <strong>{client.name}</strong>
                      <ChevronRight size={14} />
                    </Link>
                  ) : (
                    <strong>{client.name}</strong>
                  )}
                </td>
                <td>{client.contact}</td>
                <td>
                  {ownerMode ? (
                    <select
                      className="compact-input"
                      onChange={(event) =>
                        onUpdatePlan(
                          client.id,
                          event.target.value as BillingMode,
                          event.target.value === 'hourly'
                            ? null
                            : client.planId ?? plans[0]?.id ?? null,
                        )
                      }
                      value={client.billingMode}
                    >
                      <option value="hourly">Hourly</option>
                      <option value="subscription">Subscription</option>
                    </select>
                  ) : (
                    <span className="status-pill">{client.billingMode}</span>
                  )}
                </td>
                <td>{currency.format(client.hourlyRate)}/hr</td>
                <td>
                  <div className="client-chip-list compact">
                    {getAssignedEmployeeIds(client).length > 0 ? (
                      getAssignedEmployeeIds(client).map((employeeId) => (
                        <span key={employeeId}>{employeeName(employees, employeeId)}</span>
                      ))
                    ) : (
                      <span>Unassigned</span>
                    )}
                  </div>
                </td>
                <td>
                  {ownerMode && client.billingMode === 'subscription' ? (
                    <select
                      className="compact-input"
                      onChange={(event) =>
                        onUpdatePlan(client.id, 'subscription', event.target.value)
                      }
                      value={client.planId ?? plans[0]?.id ?? ''}
                    >
                      {plans.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    plan?.name ?? 'Hourly billing'
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
