import { useEffect, useState } from 'react'
import type { PingResult } from '../../shared/types'
import bearMark from './assets/bear.svg'
import './App.css'

type IpcStatus =
  | { state: 'checking' }
  | { state: 'ok'; result: PingResult; roundTripMs: number }
  | { state: 'failed'; message: string }

function App(): React.JSX.Element {
  const [status, setStatus] = useState<IpcStatus>({ state: 'checking' })

  useEffect(() => {
    const startedAt = Date.now()
    window.bearcode
      .ping()
      .then((result) => {
        setStatus({ state: 'ok', result, roundTripMs: Date.now() - startedAt })
      })
      .catch((err: unknown) => {
        setStatus({ state: 'failed', message: err instanceof Error ? err.message : String(err) })
      })
  }, [])

  return (
    <div className="phase0">
      <img className="phase0-mark" src={bearMark} alt="BearCode" />
      <h1 className="phase0-title">BearCode</h1>
      <p className="phase0-subtitle">Phase 0 scaffold</p>
      {status.state === 'checking' && <p className="phase0-status">Checking IPC…</p>}
      {status.state === 'ok' && (
        <p className="phase0-status ok">
          IPC round trip: {status.result.message} in {status.roundTripMs}ms · Electron{' '}
          {status.result.electron} · Node {status.result.node}
        </p>
      )}
      {status.state === 'failed' && (
        <p className="phase0-status failed">IPC failed: {status.message}</p>
      )}
    </div>
  )
}

export default App
