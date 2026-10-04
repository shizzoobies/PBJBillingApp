import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAppContext } from '../AppContext'
import { defaultProposalPricing, formatProposalMoney } from '../../lib/proposal-pricing.js'
import { QuestionnaireInbox } from '../components/proposals/QuestionnaireInbox'
import { QuestionnaireSheet } from '../components/proposals/QuestionnaireSheet'
import { ProposalRatesBanner } from '../components/proposals/RatesBanner'
import {
  createProposalRequest,
  createQuestionnaireRequest,
  fetchFirmSettings,
  listProposalsRequest,
  listQuestionnairesRequest,
  startQuestionnaireDraftRequest,
  withdrawQuestionnaireRequest,
  type QuestionnaireDraftResult,
} from '../lib/api'
import { PROPOSAL_STATUS_LABELS, proposalDate, proposalTitle } from '../lib/proposals'
import {
  ApiError,
  type Proposal,
  type ProposalQuestionnaire,
  type ProposalRates,
  type ProposalStatus,
} from '../lib/types'

const STATUSES = Object.keys(PROPOSAL_STATUS_LABELS) as ProposalStatus[]

/**
 * Proposals (featreq-311473e2) — the list. Replaces the Engagements
 * placeholder in the owner's sidebar. Every prospect's estimate is saved here,
 * declined ones included, so a prospect who comes back next year is reopened
 * as a copy rather than started from zero.
 */
export function ProposalsPage() {
  const { ownerMode } = useAppContext()
  const navigate = useNavigate()
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<'all' | ProposalStatus>('all')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [rates, setRates] = useState<ProposalRates | null>(null)
  // The questionnaires (featreq-8f139178): the inbox below the filters, and the
  // call sheet that is open right now, if any. A failed read leaves the page
  // exactly as it was - the proposals are what this page is for.
  const [questionnaires, setQuestionnaires] = useState<ProposalQuestionnaire[]>([])
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [busyQuestionnaireId, setBusyQuestionnaireId] = useState<string | null>(null)
  const [startingSheet, setStartingSheet] = useState(false)
  const [notice, setNotice] = useState('')

  // The catalog's rates, only to warn when one is still $0. A failed read
  // just means no banner - the editor shows the same warning.
  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void fetchFirmSettings()
      .then((firm) => {
        if (!cancelled) setRates((firm.proposalPricing ?? defaultProposalPricing()).rates)
      })
      .catch(() => {
        if (!cancelled) setRates(null)
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode])

  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void listProposalsRequest()
      .then((rows) => {
        if (cancelled) return
        setProposals(rows)
        setLoaded(true)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Could not load proposals.')
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode])

  const refreshQuestionnaires = () =>
    listQuestionnairesRequest()
      .then((rows) => setQuestionnaires(rows))
      .catch(() => {})

  useEffect(() => {
    if (!ownerMode) return
    let cancelled = false
    void listQuestionnairesRequest()
      .then((rows) => {
        if (!cancelled) setQuestionnaires(rows)
      })
      .catch(() => {
        if (!cancelled) setQuestionnaires([])
      })
    return () => {
      cancelled = true
    }
  }, [ownerMode])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return proposals
      .filter((proposal) => status === 'all' || proposal.status === status)
      .filter(
        (proposal) =>
          !needle ||
          [proposal.prospect.company, proposal.prospect.contactName, proposal.prospect.email].some(
            (value) => value.toLowerCase().includes(needle),
          ),
      )
  }, [proposals, status, query])

  const startNew = async () => {
    setCreating(true)
    setError('')
    try {
      const created = await createProposalRequest({})
      navigate(`/proposals/${created.id}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start a proposal.')
      setCreating(false)
    }
  }

  const startSheet = async () => {
    setStartingSheet(true)
    setError('')
    setNotice('')
    try {
      const created = await createQuestionnaireRequest({ mode: 'call' })
      setQuestionnaires((current) => [created, ...current])
      setSheetId(created.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the questionnaire.')
    } finally {
      setStartingSheet(false)
    }
  }

  // A sheet that was submitted: straight to the draft it started - or, when the
  // draft could not be made, back here with the inbox's Start draft button.
  const sheetSubmitted = (result: QuestionnaireDraftResult) => {
    setSheetId(null)
    if (result.proposal) {
      navigate(`/proposals/${result.proposal.id}`)
      return
    }
    setNotice('The answers are saved, but the draft proposal could not be started. Use Start draft below.')
    void refreshQuestionnaires()
  }

  const withdrawQuestionnaire = async (questionnaire: ProposalQuestionnaire) => {
    setBusyQuestionnaireId(questionnaire.id)
    setError('')
    try {
      await withdrawQuestionnaireRequest(questionnaire.id)
      if (sheetId === questionnaire.id) setSheetId(null)
      await refreshQuestionnaires()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not withdraw the questionnaire.')
    } finally {
      setBusyQuestionnaireId(null)
    }
  }

  const startDraft = async (questionnaire: ProposalQuestionnaire) => {
    setBusyQuestionnaireId(questionnaire.id)
    setError('')
    try {
      const result = await startQuestionnaireDraftRequest(questionnaire.id)
      if (result.proposal) {
        navigate(`/proposals/${result.proposal.id}`)
        return
      }
      setError('The draft proposal could not be started. Try again in a moment.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the draft proposal.')
    } finally {
      setBusyQuestionnaireId(null)
    }
  }

  const openSheet = questionnaires.find((entry) => entry.id === sheetId && entry.mode === 'call') ?? null

  return (
    <section className="content-grid" id="proposals">
      <div className="panel">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Engagements</p>
            <h2>Proposals</h2>
            <p className="section-subtitle">
              Every prospect’s estimate, letter and outcome — saved, so you can reopen it later.
            </p>
          </div>
          <div className="button-row">
            <button
              className="secondary-action"
              type="button"
              disabled={startingSheet}
              onClick={() => void startSheet()}
            >
              Fill in on the call
            </button>
            <button
              className="primary-action"
              type="button"
              disabled={creating}
              onClick={() => void startNew()}
            >
              New proposal
            </button>
          </div>
        </div>

        <ProposalRatesBanner rates={rates} />

        {openSheet ? (
          <QuestionnaireSheet
            key={openSheet.id}
            questionnaire={openSheet}
            onSubmitted={sheetSubmitted}
            onWithdraw={() => void withdrawQuestionnaire(openSheet)}
          />
        ) : null}

        {notice ? (
          <p className="muted-text" role="status">
            {notice}
          </p>
        ) : null}

        <QuestionnaireInbox
          questionnaires={questionnaires}
          busyId={busyQuestionnaireId}
          onResume={(questionnaire) => setSheetId(questionnaire.id)}
          onWithdraw={(questionnaire) => void withdrawQuestionnaire(questionnaire)}
          onStartDraft={(questionnaire) => void startDraft(questionnaire)}
        />

        <div className="form-grid two-col">
          <label className="field">
            <span>Status</span>
            <select
              className="input"
              aria-label="Status filter"
              value={status}
              onChange={(event) => setStatus(event.target.value as 'all' | ProposalStatus)}
            >
              <option value="all">All</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {PROPOSAL_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Search</span>
            <input
              className="input"
              type="search"
              aria-label="Search proposals"
              placeholder="Company, contact or email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        {loaded && visible.length === 0 ? (
          <p className="muted-text">
            {proposals.length === 0
              ? 'No proposals yet — start one with New proposal.'
              : 'No proposals match.'}
          </p>
        ) : null}

        {visible.length > 0 ? (
          <div className="table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Contact</th>
                  <th>Status</th>
                  <th>Monthly</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((proposal) => (
                  <tr key={proposal.id}>
                    <td>
                      <Link to={`/proposals/${proposal.id}`}>{proposalTitle(proposal)}</Link>
                    </td>
                    <td>{proposal.prospect.contactName}</td>
                    <td>
                      <span className="status-pill">{PROPOSAL_STATUS_LABELS[proposal.status]}</span>
                    </td>
                    <td>
                      {
                        // A draft with nothing selected is not a $0.00 price, it is
                        // no price yet (the 2026-10-02 incident read it as a quote).
                        proposal.selections.length === 0
                          ? 'Not priced yet'
                          : formatProposalMoney(proposal.pricingSnapshot?.totals.monthly ?? 0)
                      }
                    </td>
                    <td>{proposalDate(proposal.updatedAt ?? proposal.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  )
}
