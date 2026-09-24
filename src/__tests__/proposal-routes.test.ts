import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The proposal endpoints' GLUE (featreq-311473e2 / featreq-ef18a38e).
 *
 * Same shape as package-routes.test.ts and for the same reason: `server.js`
 * calls `server.listen()` at module scope and exports nothing, so there is no
 * HTTP harness. The behavior lives in the store (db/store-staleness.test.mjs,
 * both backends) and in lib/; what is pinned here is the wiring — an owner gate
 * deleted, an origin guard dropped, a route below the `/api/` catch-all.
 *
 * Treat a failure here as "the routing moved, go look".
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

/** The body of a route block, from its opening guard onward. */
function routeBlock(startPattern: RegExp, length = 2200): string {
  const at = serverSource.search(startPattern)
  expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
  return serverSource.slice(at, at + length)
}

type Route = { name: string; pattern: RegExp; write: boolean; broadcastLength?: number }

/** Owner-only on every route; same-origin and a broadcast on every write. */
function pinOwnerRoutes(routes: Route[]) {
  for (const route of routes) {
    it(`${route.name} requires a session and refuses a non-owner`, () => {
      const block = routeBlock(route.pattern)
      expect(block).toContain('await requireSession(request, response)')
      expect(block).toMatch(/session\.user\.role !== 'owner'/)
      expect(block).toMatch(/sendJson\(response, 403,/)
    })

    if (route.write) {
      it(`${route.name} blocks a cross-site request`, () => {
        const block = routeBlock(route.pattern)
        expect(block).toContain('isCrossSiteOrigin(request)')
        expect(block).toContain("sendJson(response, 403, { error: 'Origin not allowed' })")
      })

      it(`${route.name} tells the other sessions`, () => {
        expect(routeBlock(route.pattern, route.broadcastLength ?? 3000)).toContain(
          'broadcastDataChanged()',
        )
      })
    }
  }

  it('every route sits above the /api/ catch-all', () => {
    const guardAt = serverSource.indexOf("if (normalizedPath.startsWith('/api/')) {")
    expect(guardAt, 'the /api/ catch-all guard is gone').toBeGreaterThan(-1)
    for (const route of routes) {
      expect(serverSource.search(route.pattern), `${route.name} is unreachable`).toBeLessThan(guardAt)
    }
  })
}

describe('the proposal CRUD routes are owner-only and same-origin', () => {
  pinOwnerRoutes([
    {
      name: 'GET /api/proposals',
      pattern: /normalizedPath === '\/api\/proposals' && request\.method === 'GET'/,
      write: false,
    },
    {
      name: 'POST /api/proposals',
      pattern: /normalizedPath === '\/api\/proposals' && request\.method === 'POST'/,
      write: true,
    },
    { name: 'GET /api/proposals/:id', pattern: /proposalIdMatch && request\.method === 'GET'/, write: false },
    { name: 'PATCH /api/proposals/:id', pattern: /proposalIdMatch && request\.method === 'PATCH'/, write: true },
    { name: 'DELETE /api/proposals/:id', pattern: /proposalIdMatch && request\.method === 'DELETE'/, write: true },
    { name: 'POST /api/proposals/:id/copy', pattern: /proposalCopyMatch && request\.method === 'POST'/, write: true },
    {
      name: 'POST /api/proposals/:id/reprice',
      pattern: /proposalRepriceMatch && request\.method === 'POST'/,
      write: true,
    },
  ])

  it('the :id matcher cannot swallow the sub-routes', () => {
    const matcher = serverSource.match(/const proposalIdMatch = normalizedPath\.match\((.+)\)/)
    expect(matcher?.[1]).toBe('/^\\/api\\/proposals\\/([^/]+)$/')
  })

  it('the PATCH whitelists its fields and never hands the raw body to the store', () => {
    const block = routeBlock(/proposalIdMatch && request\.method === 'PATCH'/)
    expect(block).toContain("['prospect', 'clientId', 'inputs', 'selections', 'letterText']")
    expect(block).not.toContain('updateProposal(proposalIdMatch[1], payload)')
  })

  it('a refused edit or delete is a 409 with the sentence, not a 500', () => {
    for (const pattern of [
      /proposalIdMatch && request\.method === 'PATCH'/,
      /proposalIdMatch && request\.method === 'DELETE'/,
    ]) {
      const block = routeBlock(pattern)
      expect(block).toContain('error instanceof ProposalStateError')
      expect(block).toContain("sendJson(response, 409, { error: 'proposal_refused', message: error.message })")
    }
  })

  it('nothing here goes near the bulk save', () => {
    const start = serverSource.indexOf("normalizedPath === '/api/proposals' && request.method === 'GET'")
    const end = serverSource.indexOf("if (normalizedPath === '/api/reimbursements' && request.method === 'POST')")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(serverSource.slice(start, end)).not.toContain('appDataStore.write(')
  })
})

describe('drafting the letter', () => {
  pinOwnerRoutes([
    {
      name: 'POST /api/proposals/:id/letter',
      pattern: /proposalLetterMatch && request\.method === 'POST'/,
      write: true,
    },
  ])

  const block = () => routeBlock(/proposalLetterMatch && request\.method === 'POST'/, 2600)

  it('asks the model, then saves through the store', () => {
    const text = block()
    expect(text).toContain('draftProposalLetter(proposal, await appDataStore.getFirmSettings())')
    expect(text).toContain('appDataStore.setProposalLetter(proposal.id, letter)')
    expect(text.indexOf('draftProposalLetter(')).toBeLessThan(text.indexOf('setProposalLetter('))
  })

  it('turns a model failure into a sentence, never a crash', () => {
    const text = block()
    expect(text).toMatch(/status === 503 \? 503 : 502/)
    expect(text).toContain("error: 'proposal_letter_failed'")
  })

  it('refuses before ever calling the AI when the snapshot has no priced line', () => {
    const text = block()
    expect(text).toContain('allowedLetterCents(proposal.pricingSnapshot).size === 0')
    expect(text).toContain("error: 'proposal_refused'")
    expect(text.indexOf('allowedLetterCents(')).toBeLessThan(text.indexOf('draftProposalLetter('))
  })

  it('a decision landing during drafting is a 409 or 404, not a 200 with an overwritten letter', () => {
    const text = block()
    expect(text).toContain('error instanceof ProposalStateError')
    expect(text).toContain("sendJson(response, 409, { error: 'proposal_refused', message: error.message })")
    expect(text).toContain('if (!saved)')
    expect(text).toContain("sendJson(response, 404, { error: 'Proposal not found' })")
    // The refusal/gone checks on the save must come before recordActivity and
    // the broadcast, so a refused or vanished write never announces itself.
    const savedAt = text.indexOf('appDataStore.setProposalLetter(proposal.id, letter)')
    const recordAt = text.indexOf('recordActivity(')
    const broadcastAt = text.indexOf('broadcastDataChanged()')
    expect(savedAt).toBeGreaterThan(-1)
    expect(savedAt).toBeLessThan(recordAt)
    expect(recordAt).toBeLessThan(broadcastAt)
  })
})

describe('previewing the PDF', () => {
  pinOwnerRoutes([
    {
      name: 'GET /api/proposals/:id/pdf',
      pattern: /proposalPdfMatch && request\.method === 'GET'/,
      write: false,
    },
  ])

  it('renders the stored proposal as a PDF, never cached', () => {
    const block = routeBlock(/proposalPdfMatch && request\.method === 'GET'/, 1400)
    expect(block).toContain('buildProposalPdf({')
    expect(block).toContain("'Content-Type': 'application/pdf'")
    expect(block).toContain("'Cache-Control': 'no-store'")
  })
})

describe('sending a proposal', () => {
  pinOwnerRoutes([
    {
      name: 'POST /api/proposals/:id/send',
      pattern: /proposalSendMatch && request\.method === 'POST'/,
      write: true,
      // The stale-letter-figures guard (Important 1, final fix wave) pushes
      // `broadcastDataChanged()` past the shared 3000-char default.
      broadcastLength: 3600,
    },
  ])

  const block = () => routeBlock(/proposalSendMatch && request\.method === 'POST'/, 4600)

  it('builds the PDF before anything is sent', () => {
    const text = block()
    expect(text).toContain('buildProposalPdf({ proposal, firmSettings })')
    expect(text.indexOf('buildProposalPdf(')).toBeLessThan(text.indexOf('sendInvoiceEmail('))
  })

  it('tags the email with the proposal so delivery events come back to it', () => {
    const text = block()
    expect(text).toContain('proposalId: proposal.id')
    expect(text).toContain("kind: 'proposal'")
  })

  it('logs every attempt and moves a draft to sent only after a successful send', () => {
    const text = block()
    expect(text).toContain('appDataStore.appendProposalEmailEvent(proposal.id, {')
    const failAt = text.indexOf('if (!sendResult.ok) {')
    expect(failAt).toBeGreaterThan(-1)
    expect(text.indexOf("setProposalStatus(proposal.id, 'sent')")).toBeGreaterThan(failAt)
    expect(text).toContain("proposal.status === 'draft'")
  })

  it('refuses without a letter and without a real address', () => {
    const text = block()
    expect(text).toContain('Draft the letter before sending the proposal.')
    expect(text).toContain("sendJson(response, 400, { error: 'A valid email address is required.' })")
  })

  it('refuses a stale letter with a 409 naming the figures, unless the resend is confirmed (Important 1, final fix wave)', () => {
    const text = block()
    expect(text).toContain('staleLetterFigures(proposal.letter.text, proposal.pricingSnapshot)')
    expect(text).toContain("error: 'stale_letter_figures'")
    expect(text).toContain('figures: staleFigures')
    expect(text).toContain('payload?.confirmStaleFigures !== true')
    const staleAt = text.indexOf('staleLetterFigures(')
    const pdfAt = text.indexOf('buildProposalPdf(')
    expect(staleAt).toBeGreaterThan(-1)
    // The stale-figure guard runs BEFORE the PDF is built (and before
    // anything is sent) — same "refuse before doing the irreversible part"
    // shape as the letter-present check right above it.
    expect(staleAt).toBeLessThan(pdfAt)
  })
})

describe('the Resend webhook proposal branch', () => {
  const webhook = () =>
    routeBlock(/if \(normalizedPath === '\/api\/resend\/webhook' && request\.method === 'POST'\)/, 6000)

  it('files a proposal-tagged event on the proposal, before any invoice lookup', () => {
    const text = webhook()
    expect(text).toContain("typeof tagBag.proposal_id === 'string'")
    expect(text.indexOf('recordProposalDelivery(')).toBeLessThan(text.indexOf('const taggedInvoiceId'))
  })

  it('appends a delivery event, notifies once, and never writes a status', () => {
    const at = serverSource.indexOf('async function recordProposalDelivery(')
    expect(at).toBeGreaterThan(-1)
    const rest = serverSource.slice(at)
    const helper = rest.slice(0, rest.search(/\r?\n\}\r?\n/))
    expect(helper).toContain('appDataStore.appendProposalEmailEvent(proposal.id, {')
    expect(helper).toContain('const alreadyLogged =')
    expect(helper).not.toContain('setProposalStatus')
    expect(helper).not.toContain('updateProposal')
    expect(helper).not.toMatch(/status:\s*'/)
  })
})

describe('accepting and declining', () => {
  pinOwnerRoutes([
    {
      name: 'POST /api/proposals/:id/accept',
      pattern: /proposalAcceptMatch && request\.method === 'POST'/,
      write: true,
    },
    {
      name: 'POST /api/proposals/:id/decline',
      pattern: /proposalDeclineMatch && request\.method === 'POST'/,
      write: true,
    },
  ])

  const accept = () => routeBlock(/proposalAcceptMatch && request\.method === 'POST'/, 2400)

  it('Accept goes through the store, which alone decides whether a client is created', () => {
    const text = accept()
    expect(text).toContain('appDataStore.acceptProposal(proposalAcceptMatch[1], {')
    expect(text).not.toContain('appDataStore.createClient(')
    expect(text).toContain('updateMonthlyRate: payload.updateMonthlyRate === true')
  })

  it('a refusal is a 409 with the sentence', () => {
    const text = accept()
    expect(text).toContain('error instanceof ProposalStateError || error instanceof PackageApplyError')
    expect(text).toContain("sendJson(response, 409, { error: 'proposal_refused', message: error.message })")
  })

  it('broadcasts before the 409 when the refusal carries a createdClientId — the concurrent-accept race', () => {
    const text = accept()
    expect(text).toContain('if (error.createdClientId) broadcastDataChanged()')
    const broadcastAt = text.indexOf('if (error.createdClientId) broadcastDataChanged()')
    const sendAt = text.indexOf("sendJson(response, 409, { error: 'proposal_refused', message: error.message })")
    expect(broadcastAt).toBeGreaterThan(-1)
    expect(broadcastAt).toBeLessThan(sendAt)
  })

  it('checks createdClientId BEFORE the instanceof check, so an unexpected error still broadcasts before it is rethrown', () => {
    const text = accept()
    const broadcastAt = text.indexOf('if (error.createdClientId) broadcastDataChanged()')
    const instanceofAt = text.indexOf(
      'error instanceof ProposalStateError || error instanceof PackageApplyError',
    )
    expect(broadcastAt).toBeGreaterThan(-1)
    expect(instanceofAt).toBeGreaterThan(-1)
    expect(broadcastAt).toBeLessThan(instanceofAt)
  })

  it('Decline records the note through the status write', () => {
    const text = routeBlock(/proposalDeclineMatch && request\.method === 'POST'/, 2400)
    expect(text).toContain("appDataStore.setProposalStatus(current.id, 'declined', {")
  })

  it('Decline maps a refused status write to a 409 with the sentence, like accept and letter', () => {
    const text = routeBlock(/proposalDeclineMatch && request\.method === 'POST'/, 2400)
    expect(text).toContain('error instanceof ProposalStateError')
    expect(text).toContain("sendJson(response, 409, { error: 'proposal_refused', message: error.message })")
    const savedAt = text.indexOf("appDataStore.setProposalStatus(current.id, 'declined', {")
    const catchAt = text.indexOf('} catch (error) {')
    expect(savedAt).toBeGreaterThan(-1)
    expect(savedAt).toBeLessThan(catchAt)
  })
})

describe('the intake chat route', () => {
  pinOwnerRoutes([
    {
      name: 'POST /api/proposals/:id/chat',
      pattern: /proposalChatMatch && request\.method === 'POST'/,
      write: true,
      // The re-read + decided-proposal guards (fix batch 3, item 1), plus the
      // Important-2(a) scoped-reprice guard (final fix wave), push
      // `broadcastDataChanged()` past the shared 3000-char default.
      broadcastLength: 4700,
    },
  ])

  const block = () => routeBlock(/proposalChatMatch && request\.method === 'POST'/, 4600)

  it('applies only the validated patch, through the same re-pricing write the form uses', () => {
    const text = block()
    expect(text).toContain('proposalChat(proposal, text, { catalog: pricing })')
    expect(text).toContain('applyProposalPatch(proposal, turn.patch, pricing.services)')
    expect(text).toContain('appDataStore.updateProposal(')
    expect(text).toContain('appDataStore.appendProposalMessages(proposal.id, [')
  })

  it('re-reads the proposal after the AI answers and applies the patch to THAT copy, not the one read before the call (fix batch 3, item 1)', () => {
    const text = block()
    const chatAt = text.indexOf('proposalChat(proposal, text, { catalog: pricing })')
    const rereadAt = text.indexOf('proposal = await appDataStore.getProposal(proposal.id)')
    const patchAt = text.indexOf('applyProposalPatch(proposal, turn.patch, pricing.services)')
    expect(chatAt).toBeGreaterThan(-1)
    expect(rereadAt).toBeGreaterThan(chatAt)
    expect(patchAt).toBeGreaterThan(rereadAt)
  })

  it('refuses with 409 if the re-read proposal was decided while the AI was answering (fix batch 3, item 1)', () => {
    const text = block()
    const rereadAt = text.indexOf('proposal = await appDataStore.getProposal(proposal.id)')
    const after = text.slice(rereadAt, rereadAt + 400)
    expect(after).toMatch(/status === 'accepted' \|\| proposal\.status === 'declined'/)
    expect(after).toContain("error: 'proposal_refused'")
  })

  it('a re-read (or store write) that finds nothing sends 404, never 200 with proposal: null (fix batch 3, item 4)', () => {
    const text = block()
    const rereadAt = text.indexOf('proposal = await appDataStore.getProposal(proposal.id)')
    expect(text.slice(rereadAt, rereadAt + 200)).toMatch(
      /if \(!proposal\) \{\s*sendJson\(response, 404, \{ error: 'Proposal not found' \}\)/,
    )
    const savedAt = text.indexOf('saved = await appDataStore.appendProposalMessages(proposal.id, [')
    const afterSaved = text.slice(savedAt, savedAt + 600)
    expect(afterSaved).toMatch(
      /if \(!saved\) \{\s*sendJson\(response, 404, \{ error: 'Proposal not found' \}\)/,
    )
  })

  it('never sends email and never changes a status', () => {
    const text = block()
    expect(text).not.toContain('sendInvoiceEmail')
    expect(text).not.toContain('setProposalStatus')
    expect(text).not.toContain('acceptProposal')
  })

  it('turns a model failure into a sentence, never a crash, and only hides the raw message when there is no statusCode (fix batch 3, item 7)', () => {
    const text = block()
    expect(text).toContain("error: 'proposal_chat_failed'")
    expect(text).toContain("message: error?.statusCode ? error.message : 'The AI could not answer right now.'")
  })

  it('only forwards inputs/selections to updateProposal when this turn actually touched them (Important 2a, final fix wave)', () => {
    const text = block()
    expect(text).toContain('const touchedInputs = Object.keys(turn.patch.inputs ?? {}).length > 0')
    expect(text).toContain(
      "(turn.patch.selections?.add?.length ?? 0) > 0 || (turn.patch.selections?.remove?.length ?? 0) > 0",
    )
    expect(text).toContain('if (!touchedInputs) delete storePatch.inputs')
    expect(text).toContain('if (!touchedSelections) delete storePatch.selections')
  })
})
