import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event, HermesAttachment } from '../shared/types'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const userDataDir = '/tmp/bearcode-user-data'
const bytes = Buffer.from([0, 255, 19, 88])
const attachment: HermesAttachment = {
  id: 'att_123',
  name: '../../unsafe/report.pdf',
  mime: 'application/pdf',
  kind: 'document',
  sizeBytes: bytes.length,
  sha256: 'a'.repeat(64)
}
const persistedEvents: Event[] = [{ id: 'evt_123', type: 'assistant_attachment', attachment }]

const { getEvents, readVerifiedStoredAttachment, saveVerifiedBytes, showSaveDialog } = vi.hoisted(
  () => ({
    getEvents: vi.fn(),
    readVerifiedStoredAttachment: vi.fn(),
    saveVerifiedBytes: vi.fn(),
    showSaveDialog: vi.fn()
  })
)

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userDataDir) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  clipboard: { writeText: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog
  },
  shell: { openPath: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  }
}))
vi.mock('./db', () => ({ getEvents }))
vi.mock('./hermes/attachmentAccess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hermes/attachmentAccess')>()),
  readVerifiedStoredAttachment
}))
vi.mock('./hermes/attachmentSave', () => ({ saveVerifiedBytes }))

import { registerIpc } from './ipc'

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  getEvents.mockReturnValue(persistedEvents)
  readVerifiedStoredAttachment.mockResolvedValue({ attachment, bytes })
  showSaveDialog.mockResolvedValue({ canceled: true })
  saveVerifiedBytes.mockResolvedValue(undefined)
  registerIpc()
})

describe('attachments:save IPC', () => {
  it('verifies persisted bytes before showing a sanitized default filename', async () => {
    const result = await handlers.get('bearcode:attachments:save')!({}, 'conv_123', 'att_123')

    expect(getEvents).toHaveBeenCalledWith('conv_123')
    expect(readVerifiedStoredAttachment).toHaveBeenCalledWith(
      userDataDir,
      'conv_123',
      'att_123',
      persistedEvents
    )
    expect(showSaveDialog).toHaveBeenCalledWith({ defaultPath: 'report.pdf' })
    expect(saveVerifiedBytes).not.toHaveBeenCalled()
    expect(result).toBe('cancelled')
  })

  it('passes the exact verified bytes to the confirmed destination', async () => {
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/chosen/report.pdf'
    })

    const result = await handlers.get('bearcode:attachments:save')!({}, 'conv_123', 'att_123')

    expect(saveVerifiedBytes).toHaveBeenCalledWith('/chosen/report.pdf', bytes)
    expect(result).toBe('saved')
  })

  it('treats a missing confirmed path as cancellation without writing', async () => {
    showSaveDialog.mockResolvedValueOnce({ canceled: false })

    const result = await handlers.get('bearcode:attachments:save')!({}, 'conv_123', 'att_123')

    expect(saveVerifiedBytes).not.toHaveBeenCalled()
    expect(result).toBe('cancelled')
  })

  it('rejects verification failures before opening the destination dialog', async () => {
    const failure = new Error('Attachment could not be verified')
    readVerifiedStoredAttachment.mockRejectedValueOnce(failure)

    await expect(
      handlers.get('bearcode:attachments:save')!({}, 'conv_123', 'att_123')
    ).rejects.toBe(failure)

    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(saveVerifiedBytes).not.toHaveBeenCalled()
  })

  it('rejects destination write failures for renderer error reporting', async () => {
    const failure = new Error('disk full')
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/chosen/report.pdf'
    })
    saveVerifiedBytes.mockRejectedValueOnce(failure)

    await expect(
      handlers.get('bearcode:attachments:save')!({}, 'conv_123', 'att_123')
    ).rejects.toBe(failure)
  })

  it('never lets a malicious stored name choose the dialog parent directory', async () => {
    await handlers.get('bearcode:attachments:save')!({}, 'conv_123', 'att_123')

    expect(showSaveDialog).toHaveBeenCalledWith({ defaultPath: 'report.pdf' })
    expect(JSON.stringify(vi.mocked(showSaveDialog).mock.calls)).not.toContain('..')
    expect(JSON.stringify(vi.mocked(showSaveDialog).mock.calls)).not.toContain('/')
  })

  it.each(['C:\\unsafe\\report.pdf', 'C:report.pdf'])(
    'uses a plain safe leaf for Windows-style stored name %s',
    async (storedName) => {
      readVerifiedStoredAttachment.mockResolvedValueOnce({
        attachment: { ...attachment, name: storedName },
        bytes
      })

      await handlers.get('bearcode:attachments:save')!({}, 'conv_123', 'att_123')

      const options = vi.mocked(showSaveDialog).mock.calls[0]?.[0] as {
        defaultPath: string
      }
      expect(options).toEqual({ defaultPath: 'report.pdf' })
      expect(options.defaultPath).not.toMatch(/[\\/:]/)
    }
  )

  it.each([
    ['in<va>l"id|name?.txt*', 'invalidname.txt'],
    ['report.txt. ', 'report.txt'],
    ['CON', '_CON'],
    ['NUL.txt', '_NUL.txt'],
    ['COM1', '_COM1'],
    ['LPT9.log', '_LPT9.log']
  ])('uses the platform-safe default path %s -> %s', async (storedName, safeName) => {
    readVerifiedStoredAttachment.mockResolvedValueOnce({
      attachment: { ...attachment, name: storedName },
      bytes
    })

    await handlers.get('bearcode:attachments:save')!({}, 'conv_123', 'att_123')

    expect(showSaveDialog).toHaveBeenCalledWith({ defaultPath: safeName })
  })
})
