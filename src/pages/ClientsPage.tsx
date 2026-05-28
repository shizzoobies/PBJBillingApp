import { ChevronRight, Plus, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { ChipMultiSelect } from '../components/ChipMultiSelect'
import type {
  BillingMode,
  Client,
  Contact,
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
          // PREVIOUSLY: this list was filtered to non-Owner employees only,
          // which made the Add-client form unusable for any firm whose only
          // active employees were Owners (e.g., a 2-person shop with both
          // partners listed as Owner). Owners do client work too, so let
          // them be assignable; visibility scoping doesn't care because
          // owners always see every client anyway.
          employees={data.employees}
          onCreate={addClient}
          plans={data.plans}
          contacts={data.contacts}
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
  contacts,
}: {
  employees: Employee[]
  onCreate: (client: Omit<Client, 'id'>) => void
  plans: SubscriptionPlan[]
  contacts: Contact[]
}) {
  const [name, setName] = useState('Summit Retail Co.')
  const [contact, setContact] = useState('Jamie Miller')
  const [hourlyRate, setHourlyRate] = useState('125')
  const [monthlyRate, setMonthlyRate] = useState('')
  const [estimatedMonthlyHours, setEstimatedMonthlyHours] = useState('')
  const [billingMode, setBillingMode] = useState<BillingMode>('hourly')
  const [planIds, setPlanIds] = useState<string[]>([])
  const [contactIds, setContactIds] = useState<string[]>([])
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

    const parsedMonthly = Number(monthlyRate)
    const parsedEstHours = Number(estimatedMonthlyHours)
    onCreate({
      name,
      contact,
      billingMode,
      hourlyRate: rate,
      planIds,
      contactIds,
      ...(billingMode === 'subscription' && monthlyRate.trim() && !Number.isNaN(parsedMonthly)
        ? { monthlyRate: parsedMonthly }
        : {}),
      ...(estimatedMonthlyHours.trim() && !Number.isNaN(parsedEstHours)
        ? { estimatedMonthlyHours: parsedEstHours }
        : {}),
      assignedEmployeeIds,
    })
    setName('')
    setContact('')
    setHourlyRate('125')
    setMonthlyRate('')
    setEstimatedMonthlyHours('')
    setPlanIds([])
    setContactIds([])
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
          <span>Billing type</span>
          <select
            className="input"
            onChange={(event) => setBillingMode(event.target.value as BillingMode)}
            value={billingMode}
          >
            <option value="hourly">Hourly</option>
            <option value="subscription">Monthly</option>
          </select>
        </label>
        {billingMode === 'hourly' ? (
          <label className="field">
            <span>Hourly rate</span>
            <input
              className="input"
              min="0"
              onChange={(event) => setHourlyRate(event.target.value)}
              step="0.01"
              type="number"
              value={hourlyRate}
            />
          </label>
        ) : (
          <label className="field">
            <span>Monthly rate</span>
            <input
              className="input"
              min="0"
              onChange={(event) => setMonthlyRate(event.target.value)}
              step="0.01"
              type="number"
              value={monthlyRate}
            />
          </label>
        )}
        <label className="field">
          <span>Estimated monthly hours</span>
          <input
            className="input"
            min="0"
            onChange={(event) => setEstimatedMonthlyHours(event.target.value)}
            step="0.5"
            type="number"
            value={estimatedMonthlyHours}
          />
          <small className="field-helper">For planning only — does not affect invoices.</small>
        </label>
        <div className="field">
          <span>Plans / services</span>
          <ChipMultiSelect
            selectedIds={planIds}
            options={plans.map((plan) => ({ id: plan.id, label: plan.name }))}
            onChange={setPlanIds}
            addLabel="+ Add plan / service"
            emptyHelper="No plans/services selected yet."
          />
        </div>
        <div className="field">
          <span>Contacts</span>
          <ChipMultiSelect
            selectedIds={contactIds}
            options={contacts.map((entry) => ({ id: entry.id, label: entry.name }))}
            onChange={setContactIds}
            addLabel="+ Add contact"
            emptyHelper="No contacts selected yet."
          />
        </div>
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
            {ownerMode ? <th>Billing</th> : null}
            {ownerMode ? <th>Rate</th> : null}
            <th>Assigned team</th>
            {ownerMode ? <th>Plans / services</th> : null}
          </tr>
        </thead>
        <tbody>
          {clients.map((client) => {
            const clientPlans = (client.planIds ?? [])
              .map((id) => plans.find((item) => item.id === id))
              .filter((item): item is SubscriptionPlan => Boolean(item))
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
                {ownerMode ? (
                  <td>
                    <select
                      className="compact-input"
                      onChange={(event) =>
                        onUpdatePlan(
                          client.id,
                          event.target.value as BillingMode,
                          client.planId ?? null,
                        )
                      }
                      value={client.billingMode}
                    >
                      <option value="hourly">Hourly</option>
                      <option value="subscription">Monthly</option>
                    </select>
                  </td>
                ) : null}
                {ownerMode ? (
                  <td>
                    {client.billingMode === 'subscription'
                      ? `${currency.format(client.monthlyRate ?? 0)}/mo`
                      : `${currency.format(client.hourlyRate)}/hr`}
                  </td>
                ) : null}
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
                {ownerMode ? (
                  <td>
                    {clientPlans.length > 0 ? (
                      <div className="client-chip-list compact">
                        {clientPlans.map((plan) => (
                          <span key={plan.id}>{plan.name}</span>
                        ))}
                      </div>
                    ) : (
                      <span className="muted-text">None</span>
                    )}
                  </td>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
