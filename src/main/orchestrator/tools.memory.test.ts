import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory')>()),
  addMemory: vi.fn()
}))
import { addMemory } from '../memory'
import { buildMemoryTools } from './tools'

interface InvokableTool {
  name: string
  invoke: (input: unknown, config?: unknown) => Promise<string>
}
const memTools = (projectPath: string | null): InvokableTool[] =>
  buildMemoryTools('c1', projectPath) as unknown as InvokableTool[]

describe('remember tool', () => {
  beforeEach(() => vi.mocked(addMemory).mockReset())

  it('appends the bullet and confirms in the transcript', async () => {
    vi.mocked(addMemory).mockReturnValue('ok')
    const [remember] = memTools('/proj')
    const out = await remember.invoke({ text: 'user prefers pnpm', scope: 'project' })
    expect(addMemory).toHaveBeenCalledWith('project', 'user prefers pnpm', '/proj')
    expect(out).toMatch(/remembered/i)
  })
  it('reports "memory full — prune" when the scope is at cap', async () => {
    vi.mocked(addMemory).mockReturnValue('full')
    const [remember] = memTools('/proj')
    expect(await remember.invoke({ text: 'x', scope: 'project' })).toMatch(/full|prune/i)
  })
  it('refuses project scope with no folder open', async () => {
    const [remember] = memTools(null)
    const out = await remember.invoke({ text: 'x', scope: 'project' })
    expect(out).toMatch(/no project|folder|open/i)
    expect(addMemory).not.toHaveBeenCalled()
  })
})
