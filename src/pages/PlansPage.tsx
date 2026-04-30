import { Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useAppContext } from '../AppContext'
import type { SubscriptionPlan } from '../lib/types'
import { currency } from '../lib/utils'

export function PlansPage() {
  const { data, addPlan } = useAppContext()
  return (
    <section className="content-grid two-column" id="plans">
      <PlanBuilder onCreate={addPlan} />
      <PlanLibrary plans={data.plans} />
    </section>
  )
}

function PlanBuilder({
  onCreate,
}: {
  onCreate: (plan: Omit<SubscriptionPlan, 'id'>) => void
}) {
  const [name, setName] = useState('Controller Support')
  const [monthlyFee, setMonthlyFee] = useState('2400')
  const [includedHours, setIncludedHours] = useState('18')
  const [notes, setNotes] = useState('Monthly reporting, close review, and client advisory support.')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fee = Number(monthlyFee)
    const hours = Number(includedHours)
    if (!name || Number.isNaN(fee) || Number.isNaN(hours)) {
      return
    }

    onCreate({ name, monthlyFee: fee, includedHours: hours, notes })
    setName('')
    setMonthlyFee('1200')
    setIncludedHours('10')
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
          <span>Plan name</span>
          <input
            className="input"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <label className="field">
          <span>Monthly fee</span>
          <input
            className="input"
            min="0"
            onChange={(event) => setMonthlyFee(event.target.value)}
            step="50"
            type="number"
            value={monthlyFee}
          />
        </label>
        <label className="field">
          <span>Included hours</span>
          <input
            className="input"
            min="0"
            onChange={(event) => setIncludedHours(event.target.value)}
            step="1"
            type="number"
            value={includedHours}
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

function PlanLibrary({ plans }: { plans: SubscriptionPlan[] }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="section-kicker">Available templates</p>
          <h2>Plans</h2>
        </div>
      </div>
      <div className="plan-list">
        {plans.map((plan) => (
          <article className="plan-row" key={plan.id}>
            <div>
              <strong>{plan.name}</strong>
              <span>{plan.notes}</span>
            </div>
            <div>
              <strong>{currency.format(plan.monthlyFee)}</strong>
              <span>{plan.includedHours}h included</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
