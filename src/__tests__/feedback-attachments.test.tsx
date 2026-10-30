import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeedbackAttachments } from '../components/FeedbackAttachments'
import { UpdatesPage } from '../pages/UpdatesPage'
import type { AppContextValue } from '../AppContext'
import type { FeatureRequestAttachment } from '../lib/types'
import { createFeedbackAbortController, listFeedbackAttachments, uploadFeedbackAttachment, downloadFeedbackAttachment, removeFeedbackAttachment } from '../lib/api'

vi.mock('../AppContext', () => ({ useAppContext: () => context }))
vi.mock('../lib/api', () => ({
  listFeedbackAttachments: vi.fn(), uploadFeedbackAttachment: vi.fn(), downloadFeedbackAttachment: vi.fn(), removeFeedbackAttachment: vi.fn(),
  createFeedbackAbortController: vi.fn(),
  confirmRejectFeedbackRequest: vi.fn(), spitballNewSessionRequest: vi.fn(), spitballRequest: vi.fn(), spitballSessionRequest: vi.fn(), walkthroughFeatureRequestRequest: vi.fn(),
}))
let context: AppContextValue
const metadata = (id: string, name = 'picture.png'): FeatureRequestAttachment => ({ id, requestId: 'saved-update', filename: name, size: 100, contentType: 'image/png', createdAt: '', uploadedBy: 'owner' })
const choose = (files: File[]) => fireEvent.change(screen.getByLabelText(/Attachments/, { selector: 'input' }), { target: { files } })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listFeedbackAttachments).mockResolvedValue([])
  vi.mocked(createFeedbackAbortController).mockImplementation(() => new AbortController())
  context = { ownerMode: true, previewMode: false, sessionUser: { id: 'owner' }, data: { employees: [] }, featureRequests: [],
    addFeatureRequest: vi.fn().mockResolvedValue({ id: 'saved-update' }), updateFeatureRequest: vi.fn(), reorderFeatureRequests: vi.fn(), removeFeatureRequest: vi.fn(), refineFeatureRequest: vi.fn(),
  } as unknown as AppContextValue
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:local-preview'), revokeObjectURL: vi.fn() }))
})
afterEach(cleanup)

describe('feedback attachment UI', () => {
  it('does not start uploads when creation finishes after logout cancellation', async () => {
    const controllers: AbortController[] = []
    vi.mocked(createFeedbackAbortController).mockImplementation(() => { const controller = new AbortController(); controllers.push(controller); return controller })
    let finishCreate!: (value: Awaited<ReturnType<AppContextValue['addFeatureRequest']>>) => void
    vi.mocked(context.addFeatureRequest).mockImplementationOnce(() => new Promise((resolve) => { finishCreate = resolve }))
    render(<UpdatesPage />)
    fireEvent.change(screen.getByLabelText('Update title'), { target: { value: 'Local fixture' } })
    fireEvent.change(screen.getByLabelText('Update description'), { target: { value: 'Fictional feedback' } })
    choose([new File(['first'], 'first.txt')])
    fireEvent.click(screen.getByRole('button', { name: 'Add update' }))
    controllers.forEach((controller) => controller.abort())
    finishCreate({ id: 'saved-update' } as Awaited<ReturnType<AppContextValue['addFeatureRequest']>>)
    await waitFor(() => expect(context.addFeatureRequest).toHaveBeenCalledTimes(1))
    expect(listFeedbackAttachments).not.toHaveBeenCalled()
    expect(uploadFeedbackAttachment).not.toHaveBeenCalled()
  })
  it('blocks removal and retries during a delayed refresh', async () => {
    vi.mocked(listFeedbackAttachments).mockResolvedValueOnce([metadata('one')])
    vi.mocked(uploadFeedbackAttachment).mockRejectedValue(new Error('Upload failed'))
    render(<FeedbackAttachments requestId="saved-update" />)
    await screen.findByRole('button', { name: 'Download picture.png' })
    choose([new File(['second'], 'second.txt')])
    await screen.findByRole('button', { name: 'Retry failed uploads' })
    vi.mocked(downloadFeedbackAttachment).mockRejectedValue(new Error('Download unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Download picture.png' }))
    await screen.findByRole('button', { name: 'Try again' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).not.toBeDisabled())
    vi.mocked(listFeedbackAttachments).mockImplementationOnce(() => new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(listFeedbackAttachments).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Remove picture.png' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Retry failed uploads' })).toBeDisabled()
  })
  it('waits for the saved parent list before enabling new uploads', async () => {
    let finishList!: (value: FeatureRequestAttachment[]) => void
    vi.mocked(listFeedbackAttachments).mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve }))
    vi.mocked(uploadFeedbackAttachment).mockResolvedValue(metadata('one', 'first.txt'))
    const view = render(<FeedbackAttachments requestId={null} draft />)
    choose([new File(['first'], 'first.txt')])
    view.rerender(<FeedbackAttachments requestId="saved-update" draft />)
    expect(screen.getByLabelText(/Attachments/, { selector: 'input' })).toBeDisabled()
    expect(uploadFeedbackAttachment).not.toHaveBeenCalled()
    finishList([])
    await screen.findByRole('button', { name: 'Download first.txt' })
    expect(screen.getByLabelText(/Attachments/, { selector: 'input' })).not.toBeDisabled()
  })
  it('does not upload a queued file removed while another upload is in flight', async () => {
    let finish!: (value: FeatureRequestAttachment) => void
    vi.mocked(uploadFeedbackAttachment).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    render(<FeedbackAttachments requestId="saved-update" />)
    await waitFor(() => expect(screen.getByLabelText(/Attachments/, { selector: 'input' })).not.toBeDisabled())
    choose([new File(['first'], 'first.txt'), new File(['second'], 'second.txt')])
    await waitFor(() => expect(uploadFeedbackAttachment).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected file' }))
    finish(metadata('one', 'first.txt'))
    await screen.findByRole('button', { name: 'Download first.txt' })
    expect(uploadFeedbackAttachment).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('second.txt')).not.toBeInTheDocument()
  })
  it('creates once, retains partial successes and retries only failed upload IDs', async () => {
    vi.mocked(uploadFeedbackAttachment).mockResolvedValueOnce(metadata('one', 'first.txt')).mockRejectedValueOnce(new Error('Storage temporarily unavailable')).mockResolvedValueOnce(metadata('two', 'second.txt'))
    render(<UpdatesPage />)
    fireEvent.change(screen.getByLabelText('Update title'), { target: { value: 'Local fixture' } })
    fireEvent.change(screen.getByLabelText('Update description'), { target: { value: 'Fictional feedback' } })
    choose([new File(['first'], 'first.txt'), new File(['second'], 'second.txt')])
    fireEvent.click(screen.getByRole('button', { name: 'Add update' }))
    await screen.findByText('Storage temporarily unavailable')
    expect(context.addFeatureRequest).toHaveBeenCalledTimes(1)
    expect(uploadFeedbackAttachment).toHaveBeenCalledTimes(2)
    const failedId = vi.mocked(uploadFeedbackAttachment).mock.calls[1][2]
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed uploads' }))
    await screen.findByRole('button', { name: 'Download second.txt' })
    expect(context.addFeatureRequest).toHaveBeenCalledTimes(1)
    expect(uploadFeedbackAttachment).toHaveBeenCalledTimes(3)
    expect(vi.mocked(uploadFeedbackAttachment).mock.calls[2][2]).toBe(failedId)
    expect(screen.getByRole('button', { name: 'Update saved' })).toBeDisabled()
  })
  it('retains files if creation fails and does not upload before a parent exists', async () => {
    vi.mocked(context.addFeatureRequest).mockRejectedValueOnce(new Error('Cannot save update'))
    render(<UpdatesPage />)
    fireEvent.change(screen.getByLabelText('Update title'), { target: { value: 'Local fixture' } })
    fireEvent.change(screen.getByLabelText('Update description'), { target: { value: 'Fictional feedback' } })
    choose([new File(['first'], 'first.txt')])
    fireEvent.click(screen.getByRole('button', { name: 'Add update' }))
    await screen.findByText('Cannot save update')
    expect(screen.getByText('first.txt')).toBeInTheDocument()
    expect(uploadFeedbackAttachment).not.toHaveBeenCalled()
  })
  it('requires removal confirmation and revokes preview URLs on unmount', async () => {
    vi.mocked(listFeedbackAttachments).mockResolvedValue([metadata('one')])
    vi.mocked(downloadFeedbackAttachment).mockResolvedValue(new Blob(['picture']))
    vi.mocked(removeFeedbackAttachment).mockResolvedValue(undefined)
    const view = render(<FeedbackAttachments requestId="saved-update" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    await screen.findByRole('img', { name: 'picture.png' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove picture.png' }))
    expect(removeFeedbackAttachment).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep file' }))
    expect(removeFeedbackAttachment).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove picture.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Download picture.png' })).not.toBeInTheDocument())
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview')
    view.unmount()
  })
  it('aborts queued work when entering preview and ignores a late response', async () => {
    let finish!: (value: FeatureRequestAttachment) => void
    vi.mocked(uploadFeedbackAttachment).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const view = render(<UpdatesPage />)
    fireEvent.change(screen.getByLabelText('Update title'), { target: { value: 'Local fixture' } })
    fireEvent.change(screen.getByLabelText('Update description'), { target: { value: 'Fictional feedback' } })
    choose([new File(['first'], 'first.txt'), new File(['second'], 'second.txt')])
    fireEvent.click(screen.getByRole('button', { name: 'Add update' }))
    await waitFor(() => expect(uploadFeedbackAttachment).toHaveBeenCalledTimes(1))
    const signal = vi.mocked(uploadFeedbackAttachment).mock.calls[0][3]
    context = { ...context, previewMode: true }
    view.rerender(<UpdatesPage />)
    expect(signal.aborted).toBe(true)
    finish(metadata('late'))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Attachments' })).not.toBeInTheDocument())
    expect(uploadFeedbackAttachment).toHaveBeenCalledTimes(1)
  })
  it('rejects invalid selections without starting an upload', () => {
    render(<FeedbackAttachments requestId={null} draft />)
    choose([new File([], 'empty.txt')])
    expect(screen.getByRole('alert')).toHaveTextContent('nonempty')
    choose([new File(['x'], 'active.svg')])
    expect(screen.getByRole('alert')).toHaveTextContent('supported')
    expect(uploadFeedbackAttachment).not.toHaveBeenCalled()
  })
})
