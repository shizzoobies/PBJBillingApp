import { useEffect, useId, useRef, useState } from 'react'
import { Download, Paperclip, Trash2 } from 'lucide-react'
import { createFeedbackAbortController, downloadFeedbackAttachment, listFeedbackAttachments, removeFeedbackAttachment, uploadFeedbackAttachment } from '../lib/api'
import type { FeatureRequestAttachment } from '../lib/types'
import './FeedbackAttachments.css'

type Pending = { id: string; file: File; error: string | null; busy: boolean }
const accept = '.jpg,.jpeg,.png,.gif,.webp,.pdf,.docx,.xlsx,.pptx,.txt,.csv'
const sizeLabel = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not complete that action. Please retry.'

export function FeedbackAttachments({ requestId, draft = false }: { requestId: string | null; draft?: boolean }) {
  const inputId = useId()
  const [files, setFiles] = useState<FeatureRequestAttachment[]>([])
  const [pending, setPending] = useState<Pending[]>([])
  const pendingRef = useRef<Pending[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const loading = refreshing || Boolean(requestId && loadedId !== requestId)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ id: string; name: string; url: string } | null>(null)
  const controller = useRef<AbortController | null>(null)
  const objectUrls = useRef(new Set<string>())
  const running = useRef(false)
  const removeButton = useRef<HTMLButtonElement | null>(null)
  const previewButton = useRef<HTMLButtonElement | null>(null)
  const updatePending = (next: Pending[]) => { pendingRef.current = next; setPending(next) }

  const uploadQueue = async (parentId: string, signal: AbortSignal) => {
    if (running.current || signal.aborted) return
    running.current = true
    try {
      // Snapshot the queue: successful items are removed, failures retain their
      // original UUID, even when a response was lost after the server saved it.
      for (const item of [...pendingRef.current]) {
        if (signal.aborted) break
        if (!pendingRef.current.some((queued) => queued.id === item.id)) continue
        updatePending(pendingRef.current.map((p) => p.id === item.id ? { ...p, busy: true, error: null } : p))
        try {
          const saved = await uploadFeedbackAttachment(parentId, item.file, item.id, signal)
          if (signal.aborted) return
          setFiles((current) => [...current.filter((f) => f.id !== saved.id), saved])
          updatePending(pendingRef.current.filter((p) => p.id !== item.id))
        } catch (failure) {
          if (signal.aborted) return
          updatePending(pendingRef.current.map((p) => p.id === item.id ? { ...p, busy: false, error: message(failure) } : p))
        }
      }
    } finally { running.current = false }
  }

  useEffect(() => {
    const active = createFeedbackAbortController()
    controller.current = active
    const urls = objectUrls.current
    if (requestId) {
      void (async () => {
        try {
          const result = await listFeedbackAttachments(requestId, active.signal)
          if (active.signal.aborted) return
          setFiles(result)
          setLoadedId(requestId)
          setError(null)
          await uploadQueue(requestId, active.signal)
        } catch (failure) { if (!active.signal.aborted) setError(message(failure)) }
      })()
    }
    return () => { active.abort(); for (const url of urls) URL.revokeObjectURL(url); urls.clear() }
    // The queue is event-owned. An ID change begins it once, never a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  const choose = (selected: FileList | null) => {
    if (!selected || loading) return
    const additions = Array.from(selected)
    if (files.length + pendingRef.current.length + additions.length > 10) { setError('Choose up to 10 files per update.'); return }
    if (additions.some((file) => file.size === 0 || file.size > 10 * 1024 * 1024)) { setError('Each file must be nonempty and 10 MB or smaller.'); return }
    if (additions.some((file) => !accept.split(',').some((extension) => file.name.toLowerCase().endsWith(extension)))) { setError('Choose a supported picture, PDF, Office document, TXT or CSV file.'); return }
    setError(null)
    updatePending([...pendingRef.current, ...additions.map((file) => ({ id: crypto.randomUUID(), file, busy: false, error: null }))])
    if (requestId && controller.current) void uploadQueue(requestId, controller.current.signal)
  }
  const openFile = async (file: FeatureRequestAttachment, inline: boolean) => {
    const signal = controller.current?.signal
    if (!requestId || !signal || signal.aborted) return
    setBusyId(file.id); setError(null)
    try {
      const blob = await downloadFeedbackAttachment(requestId, file.id, inline, signal)
      if (signal.aborted) return
      const url = URL.createObjectURL(blob)
      objectUrls.current.add(url)
      if (inline) {
        if (preview) { URL.revokeObjectURL(preview.url); objectUrls.current.delete(preview.url) }
        setPreview({ id: file.id, name: file.filename, url })
      } else {
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = file.filename; document.body.append(anchor); anchor.click(); anchor.remove()
        window.setTimeout(() => { URL.revokeObjectURL(url); objectUrls.current.delete(url) }, 1000)
      }
    } catch (failure) { if (!signal.aborted) setError(message(failure)) }
    finally { if (!signal.aborted) setBusyId(null) }
  }
  const remove = async (file: FeatureRequestAttachment) => {
    const signal = controller.current?.signal
    if (!requestId || !signal || signal.aborted) return
    setBusyId(file.id); setError(null)
    try {
      await removeFeedbackAttachment(requestId, file.id, signal)
      if (signal.aborted) return
      setFiles((current) => current.filter((f) => f.id !== file.id)); setRemoveId(null)
      if (preview?.id === file.id) { URL.revokeObjectURL(preview.url); objectUrls.current.delete(preview.url); setPreview(null) }
      document.getElementById(inputId)?.focus()
    } catch (failure) { if (!signal.aborted) setError(message(failure)) }
    finally { if (!signal.aborted) setBusyId(null) }
  }

  return <section className="feedback-attachments" aria-label="Attachments">
    <label className="feedback-attachment-label" htmlFor={inputId}><Paperclip size={16} aria-hidden="true" /> Attachments {draft && !requestId ? '(optional)' : ''}</label>
    <p id={`${inputId}-help`} className="muted-text">Pictures, PDF, Word, Excel, PowerPoint, TXT or CSV. Up to 10 files, 10 MB each.</p>
    <input id={inputId} type="file" accept={accept} multiple aria-describedby={`${inputId}-help`} disabled={loading || pending.some((p) => p.busy) || files.length + pending.length >= 10} onChange={(event) => { choose(event.target.files); event.target.value = '' }} />
    {loading ? <p role="status">Loading attachments...</p> : null}
    {error ? <p role="alert" className="updates-form-error">{error} {requestId ? <button type="button" disabled={refreshing || busyId !== null || pending.some((p) => p.busy)} onClick={() => {
      const signal = controller.current?.signal
      if (!signal) return
      setRefreshing(true)
      void listFeedbackAttachments(requestId, signal).then((items) => { if (!signal.aborted) { setFiles(items); setLoadedId(requestId); setError(null); void uploadQueue(requestId, signal) } }).catch((failure) => { if (!signal.aborted) setError(message(failure)) }).finally(() => { if (!signal.aborted) setRefreshing(false) })
    }}>Try again</button> : null}</p> : null}
    {files.length ? <ul className="feedback-file-list">{files.map((file) => <li key={file.id}>
      <div className="feedback-file-info"><strong>{file.filename}</strong><span>{sizeLabel(file.size)}</span></div>
      <div className="feedback-file-actions">
        {file.contentType.startsWith('image/') ? <button type="button" disabled={loading || busyId !== null} onClick={(event) => { previewButton.current = event.currentTarget; void openFile(file, true) }}>Preview</button> : null}
        <button type="button" disabled={loading || busyId !== null} aria-label={`Download ${file.filename}`} onClick={() => void openFile(file, false)}><Download size={14} aria-hidden="true" /> Download</button>
        <button type="button" disabled={loading || busyId !== null} aria-label={`Remove ${file.filename}`} onClick={(event) => { removeButton.current = event.currentTarget; setRemoveId(file.id) }}><Trash2 size={14} aria-hidden="true" /> Remove</button>
      </div>
      {removeId === file.id ? <div className="feedback-remove-confirm" role="group" aria-label={`Remove ${file.filename}?`}>
        <p>Remove {file.filename}? It will no longer be available on this update.</p>
        <button type="button" disabled={loading || busyId !== null} onClick={() => void remove(file)}>Yes, remove</button>
        <button type="button" disabled={loading || busyId !== null} onClick={() => { setRemoveId(null); removeButton.current?.focus() }}>Keep file</button>
      </div> : null}
      {busyId === file.id ? <span role="status">Working...</span> : null}
    </li>)}</ul> : null}
    {pending.length ? <ul className="feedback-file-list" aria-live="polite">{pending.map((item) => <li key={item.id}>
      <div className="feedback-file-info"><strong>{item.file.name}</strong><span>{sizeLabel(item.file.size)} · {item.busy ? 'Uploading...' : item.error ? 'Upload failed' : requestId ? 'Waiting to upload' : 'Ready to attach'}</span></div>
      {item.error ? <p className="updates-form-error">{item.error}</p> : null}
      {!item.busy ? <button type="button" onClick={() => updatePending(pendingRef.current.filter((p) => p.id !== item.id))}>Remove selected file</button> : null}
    </li>)}</ul> : null}
    {requestId && pending.some((p) => p.error) ? <button type="button" disabled={loading || pending.some((p) => p.busy)} onClick={() => { if (controller.current) void uploadQueue(requestId, controller.current.signal) }}>Retry failed uploads</button> : null}
    {preview ? <div className="feedback-image-preview">
      <button type="button" onClick={() => { URL.revokeObjectURL(preview.url); objectUrls.current.delete(preview.url); setPreview(null); previewButton.current?.focus() }}>Close preview</button>
      <img src={preview.url} alt={preview.name} width={640} height={480} />
    </div> : null}
  </section>
}
