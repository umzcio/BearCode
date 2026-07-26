import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event, HermesAttachment, PreviewPayload } from '../shared/types'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const userDataDir = '/tmp/bearcode-user-data'
const bytes = Buffer.from('<h1>Hermes attachment</h1>')
const attachment: HermesAttachment = {
  id: 'att_123',
  name: '../unsafe/report.html',
  mime: 'text/html',
  kind: 'document',
  sizeBytes: bytes.length,
  sha256: 'a'.repeat(64)
}
const persistedEvents: Event[] = [{ id: 'evt_123', type: 'assistant_attachment', attachment }]

const { getEvents, readVerifiedStoredAttachment, renderPreviewPayload, sanitizeAttachmentName } =
  vi.hoisted(() => ({
    getEvents: vi.fn(),
    readVerifiedStoredAttachment: vi.fn(),
    renderPreviewPayload: vi.fn(),
    sanitizeAttachmentName: vi.fn()
  }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  }
}))
vi.mock('./db', () => ({ getEvents }))
vi.mock('./hermes/attachmentAccess', () => ({
  readVerifiedStoredAttachment,
  sanitizeAttachmentName
}))
vi.mock('./preview/render', () => ({ renderPreviewPayload }))

import { registerIpc } from './ipc'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  getEvents.mockReturnValue(persistedEvents)
  sanitizeAttachmentName.mockReturnValue('report.html')
  readVerifiedStoredAttachment.mockResolvedValue({ attachment, bytes })
  renderPreviewPayload.mockResolvedValue({
    kind: 'html-url',
    url: 'bearcode-preview://attachment/conv_123/att_123/report.html'
  } satisfies PreviewPayload)
  registerIpc()
})

describe('attachments:preview IPC', () => {
  it('renders verified persisted attachment metadata and bytes behind opaque IDs', async () => {
    const result = await handlers.get('bearcode:attachments:preview')!({}, 'conv_123', 'att_123')

    expect(getEvents).toHaveBeenCalledWith('conv_123')
    expect(readVerifiedStoredAttachment).toHaveBeenCalledWith(
      userDataDir,
      'conv_123',
      'att_123',
      persistedEvents
    )
    expect(renderPreviewPayload).toHaveBeenCalledWith({
      name: '../unsafe/report.html',
      mime: 'text/html',
      bytes,
      htmlUrl: 'bearcode-preview://attachment/conv_123/att_123/report.html'
    })
    expect(result).toEqual({
      kind: 'html-url',
      url: 'bearcode-preview://attachment/conv_123/att_123/report.html'
    })
    expect(JSON.stringify(vi.mocked(renderPreviewPayload).mock.calls)).not.toContain(userDataDir)
    expect(JSON.stringify(result)).not.toContain(userDataDir)
  })

  it('returns the stable unsupported payload when rendering rejects asynchronously', async () => {
    renderPreviewPayload.mockRejectedValueOnce(new Error('Office rendering failed'))

    const result = await handlers.get('bearcode:attachments:preview')!(
      {},
      'conv_123',
      'att_123'
    )

    expect(result).toEqual({
      kind: 'unsupported',
      note: 'Attachment could not be loaded'
    })
  })

  it.each([
    new Error('Attachment is no longer available'),
    new Error('Attachment could not be verified')
  ])('returns a stable unsupported payload when verified reading fails', async (error) => {
    readVerifiedStoredAttachment.mockRejectedValueOnce(error)

    const result = await handlers.get('bearcode:attachments:preview')!({}, 'conv_123', 'att_123')

    expect(result).toEqual({
      kind: 'unsupported',
      note: 'Attachment could not be loaded'
    })
    expect(renderPreviewPayload).not.toHaveBeenCalled()
  })
})
