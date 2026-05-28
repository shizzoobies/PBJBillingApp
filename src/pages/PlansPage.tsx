import { Plus, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import { ApiError, type Client, type SubscriptionPlan } from '../lib/types'

export function PlansPage() {
  const { data, addPlan, deletePlan, ownerMode } = useAppContext()
  return (
    <section className="content-grid two-column" id="plans">
      <PlanBuilder onCreate={addPlan} />
      <PlanLibrary
        plans={data.plans}
        clients={data.clients}
        ownerMode={ownerMode}
        onDelete={deletePlan}
      />
    </section>
  )
}

function PlanBuilder({
  onCreate,
}: {
  onCreate: (plan: Omit<SubscriptionPlan, 'id'>) => void
}) {
  const [name, setName] = useState('Controller Support')
  const [notes, setNotes] = useState('Monthly reporting, close review, and client advisory support.')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!name) {
      return
    }

    onCreate({ name, notes })
    setName('')
    setNotes('')
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Subscription setup</p>
          <h2>Create plan</h2>
        </div>
      </div>
      <form className="form-grid single" onSubmit={handleSubmit}>
        <label className="field">
          <span>Plan / service name</span>
          <input
            className="input"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea
            className="input"
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            value={notes}
          />
        </label>
        <button className="primary-action" type="submit">
          <Plus size={16} />
          Add plan
        </button>
      </form>
    </section>
  )
}

function PlanLibrary({
  plans,
  clients,
  ownerMode,
  onDelete,
}: {
  plans: SubscriptionPlan[]
  clients: Client[]
  ownerMode: boolean
  onDelete: (planId: string) => Promise<void>
}) {
  const [pendingId, setPendingId] = useState<string | null>(null)

  const handleDelete = async (plan: SubscriptionPlan) => {
    // Tell the owner exactly which clients will be unlinked so they go in
    // eyes-open. Unlinked clients keep their billing history but flip to
    // hourly going forward (planId becomes null).
    const attached = clients.filter((client) => (client.planIds ?? []).includes(plan.id))
    const attachedSummary =
      attached.length === 0
        ? 'No clients are currently on this plan/service.'
        : attached.length === 1
          ? `1 client has this plan/service: ${attached[0].name}. It will be removed from their selected services (their billing is unaffected).`
          : `${attached.length} clients have this plan/service: ${attached
              .map((client) => client.name)
              .join(', ')}. It will be removed from their selected services (their billing is unaffected).`

    const confirmed = window.confirm(
      `Delete "${plan.name}"?\n\n${attachedSummary}\n\nThis can't be undone.`,
    )
    if (!confirmed) return
    setPendingId(plan.id)
    try {
      await onDelete(plan.id)
    } catch (error) {
      window.alert(error instanceof ApiError ? error.message : 'Could not delete the plan.')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Available templates</p>
          <h2>Plans</h2>
        </div>
      </div>
      <div className="plan-list">
        {plans.map((plan) => {
          const attachedCount = clients.filter((client) =>
            (client.planIds ?? []).includes(plan.id),
          ).length
          return (
            <article className="plan-row" key={plan.id}>
              <div>
                <strong>{plan.name}</strong>
                <span>{plan.notes}</span>
                {attachedCount > 0 ? (
                  <span className="checklist-meta-line">
                    {attachedCount} client{attachedCount === 1 ? '' : 's'} on this plan
                  </span>
                ) : null}
              </div>
              {ownerMode ? (
                <button
                  className="item-delete-btn"
                  type="button"
                  aria-label={`Delete ${plan.name}`}
                  title="Delete this plan (any attached clients will be unlinked)"
                  disabled={pendingId === plan.id}
                  onClick={() => void handleDelete(plan)}
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </article>
          )
        })}
      </div>
    </section>
  )
}
