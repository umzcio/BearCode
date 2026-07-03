import type { RunSink } from '../ursa/run'
import { getSettings } from '../settings'

export function useOrchestrator(): boolean {
  return process.env['BEARCODE_ENGINE'] === 'orchestrator' || getSettings().experimentalEngine
}

export async function startRunOrchestrator(
  conversationId: string,
  _userText: string,
  _modelRef: string,
  sink: RunSink
): Promise<void> {
  // Filled in by Task 5.
  sink.setState(conversationId, 'error')
  sink.emit(conversationId, {
    type: 'error',
    id: `${conversationId}-not-impl`,
    message: 'Orchestrator engine not implemented yet.',
    recoverable: false
  })
  throw new Error('startRunOrchestrator not implemented')
}

export function cancelRunOrchestrator(_conversationId: string): void {
  // Filled in by Task 7.
}
