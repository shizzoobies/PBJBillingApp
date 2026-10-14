import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppContextValue } from '../AppContext'
import { SavingTextInput } from '../components/SectionKit'
import { emailShapeProblem } from '../lib/emailShape'
import type { AppData, Client } from '../lib/types'
import { ClientsPage } from '../pages/ClientsPage'
import { ContactsPage } from '../pages/ContactsPage'

/**
 * The forms warn about an odd email when it is typed (featreq-9c29491a, Letters leftovers):
 * the reason sits under the field and Save stays off while a value that was CHANGED has a
 * problem. A value already on file is never judged, and the server is not asked to refuse.
 */

vi.mock('../AppContext', () => ({ useAppContext: () => contextValue }))

const OWNER = 'emp-owner'
const CLIENT_A: Client = { id: 'client-a', name: 'Acme Bakery', contact: 'Jo' } as Client
let contextValue: AppContextValue

function signInAsOwner() {
  const data = {
    clients: [CLIENT_A],
    contacts: [],
    employees: [{ id: OWNER, name: 'Alex Owner', role: 'Owner' }],
    checklists: [],
    checklistTemplates: [],
    plans: [],
  } as unknown as AppData
  contextValue = {
    ownerMode: true,
    visibleClients: [CLIENT_A],
    data,
    activeEmployeeId: OWNER,
    effectiveUser: { staffRole: undefined },
    sessionUser: { id: OWNER, name: 'Alex Owner' },
    updateClientPlan: vi.fn(),
    updateClient: vi.fn(),
    addClient: vi.fn(),
    startOnboarding: vi.fn(),
    applyTemplateToClient: vi.fn(),
    setClientLifecycle: vi.fn(),
  } as unknown as AppContextValue
}

afterEach(() => cleanup())

describe('the Add client form - the new contact email', () => {
  it('shows the reason and keeps Add client off for two addresses, and turns it on when fixed', () => {
    signInAsOwner()
    render(
      <MemoryRouter>
        <ClientsPage />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add client' }))
    const dialog = screen.getByRole('dialog', { name: 'Add client' })
    fireEvent.change(within(dialog).getByLabelText('Client name'), { target: { value: 'New Co' } })
    fireEvent.change(within(dialog).getByLabelText('Primary contact'), { target: { value: '__new_contact__' } })
    fireEvent.change(screen.getByPlaceholderText('Name (required)'), { target: { value: 'Jane Roe' } })
    const save = within(dialog).getByRole('button', { name: 'Add client' })
    expect(save).toBeEnabled()

    const email = screen.getByPlaceholderText('Email (optional)')
    fireEvent.change(email, { target: { value: 'a@x.com, b@y.com' } })
    expect(screen.getByText('Enter one email address')).toBeInTheDocument()
    expect(save).toBeDisabled()
    // Enter in a field submits the form without the button: the guard in the handler holds too.
    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement)
    expect(contextValue.addClient).not.toHaveBeenCalled()

    fireEvent.change(email, { target: { value: 'Jane <a@x.com>' } })
    expect(screen.getByText('Enter just the address, no name')).toBeInTheDocument()
    expect(save).toBeDisabled()

    fireEvent.change(email, { target: { value: 'a@x.com' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(save).toBeEnabled()
  })
})

describe('the Add contact form - the email', () => {
  it('shows the reason beside the field, holds Add contact, and a submit without the button does nothing', () => {
    signInAsOwner()
    const addContact = vi.fn()
    contextValue = { ...contextValue, addContact, updateContact: vi.fn(), deleteContact: vi.fn(), setContactLinks: vi.fn(), setContactArchived: vi.fn() } as unknown as AppContextValue
    render(
      <MemoryRouter>
        <ContactsPage />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add contact' }))
    const dialog = screen.getByRole('dialog', { name: 'Add contact' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Jane Roe' } })
    const email = within(dialog).getByLabelText('Email')
    fireEvent.change(email, { target: { value: 'a@x.com, b@y.com' } })

    // The reason sits outside the label and is tied to the field.
    const alert = within(dialog).getByRole('alert')
    expect(alert).toHaveTextContent('Enter one email address')
    expect(alert.closest('label')).toBeNull()
    expect(email).toHaveAttribute('aria-describedby', alert.id)
    expect(within(dialog).getByRole('button', { name: 'Add contact' })).toBeDisabled()

    fireEvent.submit(dialog.querySelector('form') as HTMLFormElement)
    expect(addContact).not.toHaveBeenCalled()

    fireEvent.change(email, { target: { value: 'a@x.com' } })
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add contact' }))
    expect(addContact).toHaveBeenCalledTimes(1)
  })
})

describe('an inline email field that saves as you type', () => {
  it('does not save a changed value with a problem, shows why, and saves it once fixed', () => {
    const onCommit = vi.fn()
    render(<SavingTextInput ariaLabel="Pat email" canonical="pat@acme.com" onCommit={onCommit} validate={emailShapeProblem} />)
    const input = screen.getByLabelText('Pat email')
    fireEvent.change(input, { target: { value: 'pat@acme.com, lee@acme.com' } })
    fireEvent.blur(input)
    expect(screen.getByText('Enter one email address')).toBeInTheDocument()
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'lee@acme.com' } })
    fireEvent.blur(input)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onCommit).toHaveBeenCalledWith('lee@acme.com')
  })

  it('does not judge a value already on file, only one that was changed', () => {
    const onCommit = vi.fn()
    render(<SavingTextInput ariaLabel="Old email" canonical="Jane <a@x.com>" onCommit={onCommit} validate={emailShapeProblem} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.blur(screen.getByLabelText('Old email'))
    expect(onCommit).not.toHaveBeenCalled()
  })
})
