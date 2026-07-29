import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifact } from '../shared/types'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, Handler>()
const artifact: Artifact = {
  id: 'provider:opaque/artifact id',
  conversationId: 'conversation-1',
  type: 'plan',
  version: 2,
  title: 'Release Notes.md',
  body: '## Durable ✅\n\u0000not-a-path:C:\\outside',
  status: 'approved',
  createdAt: 123,
  resolvedAt: 456
}

const { getArtifact, saveVerifiedBytes, showSaveDialog } = vi.hoisted(() => ({
  getArtifact: vi.fn(),
  saveVerifiedBytes: vi.fn(),
  showSaveDialog: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/bearcode-user-data') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  clipboard: { writeText: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog
  },
  shell: { openPath: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('./db', () => ({ getArtifact }))
vi.mock('./hermes/attachmentSave', () => ({ saveVerifiedBytes }))

import { registerIpc } from './ipc'

function saveMarkdown(...args: unknown[]): unknown {
  const handler = handlers.get('bearcode:artifacts:save-markdown')
  if (!handler) throw new Error('Expected artifact Markdown export handler to be registered')
  return handler({}, ...args)
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  getArtifact.mockReturnValue(artifact)
  showSaveDialog.mockResolvedValue({ canceled: true })
  saveVerifiedBytes.mockResolvedValue(undefined)
  registerIpc()
})

describe('artifacts:save-markdown IPC', () => {
  it.each([undefined, null, '', 42, {}, []])(
    'rejects malformed artifact ID %j before consulting storage or opening a dialog',
    async (artifactId) => {
      await expect(saveMarkdown(artifactId)).rejects.toThrow('Invalid artifact ID')

      expect(getArtifact).not.toHaveBeenCalled()
      expect(showSaveDialog).not.toHaveBeenCalled()
      expect(saveVerifiedBytes).not.toHaveBeenCalled()
    }
  )

  it('uses durable storage existence as authority for an unknown opaque ID', async () => {
    getArtifact.mockReturnValueOnce(null)

    await expect(saveMarkdown('provider-id-with arbitrary shape')).rejects.toThrow(
      'Artifact not found'
    )

    expect(getArtifact).toHaveBeenCalledWith('provider-id-with arbitrary shape')
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(saveVerifiedBytes).not.toHaveBeenCalled()
  })

  it('proposes a plain sanitized leaf with exactly one Markdown extension', async () => {
    await expect(saveMarkdown(artifact.id)).resolves.toBe('cancelled')

    expect(getArtifact).toHaveBeenCalledWith(artifact.id)
    expect(showSaveDialog).toHaveBeenCalledWith({ defaultPath: 'Release Notes.md' })
    expect(saveVerifiedBytes).not.toHaveBeenCalled()
  })

  it('returns cancelled and writes nothing when Save As is cancelled', async () => {
    showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '/ignored/export.md' })

    await expect(saveMarkdown(artifact.id)).resolves.toBe('cancelled')

    expect(saveVerifiedBytes).not.toHaveBeenCalled()
  })

  it('treats a missing confirmed path as cancellation', async () => {
    showSaveDialog.mockResolvedValueOnce({ canceled: false })

    await expect(saveMarkdown(artifact.id)).resolves.toBe('cancelled')

    expect(saveVerifiedBytes).not.toHaveBeenCalled()
  })

  it('writes the durable Markdown body as exact UTF-8 bytes to the confirmed destination', async () => {
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/chosen/release-notes.md'
    })

    await expect(saveMarkdown(artifact.id)).resolves.toBe('saved')

    expect(saveVerifiedBytes).toHaveBeenCalledWith(
      '/chosen/release-notes.md',
      Buffer.from(artifact.body, 'utf8')
    )
  })

  it('rejects destination write failures', async () => {
    const failure = new Error('disk full')
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/chosen/release-notes.md'
    })
    saveVerifiedBytes.mockRejectedValueOnce(failure)

    await expect(saveMarkdown(artifact.id)).rejects.toBe(failure)
  })

  it.each([
    ['../../Roadmap.md', 'Roadmap.md'],
    ['C:\\outside\\CON', '_CON.md'],
    ['NUL.md.md', '_NUL.md'],
    ['in<va>l"id|name?.md*', 'invalidname.md'],
    ['..', 'attachment.md'],
    ['report.md.md', 'report.md']
  ])('sanitizes malicious title %s to safe leaf %s', async (title, expectedLeaf) => {
    getArtifact.mockReturnValueOnce({ ...artifact, title })

    await saveMarkdown(artifact.id)

    expect(showSaveDialog).toHaveBeenCalledWith({ defaultPath: expectedLeaf })
    expect(expectedLeaf).not.toMatch(/[\\/:]/)
  })

  it('ignores extra renderer body and destination arguments', async () => {
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/chosen/durable.md'
    })

    await saveMarkdown(artifact.id, '# forged renderer body', '/renderer-controlled/escape.md')

    expect(getArtifact).toHaveBeenCalledWith(artifact.id)
    expect(showSaveDialog).toHaveBeenCalledWith({ defaultPath: 'Release Notes.md' })
    expect(saveVerifiedBytes).toHaveBeenCalledWith(
      '/chosen/durable.md',
      Buffer.from(artifact.body, 'utf8')
    )
  })
})
