import http from 'http'
import type { AddressInfo } from 'net'

export interface LoopbackCapture {
  redirectUri: string
  wait(timeoutMs?: number): Promise<URLSearchParams>
  close(): void
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Starts an ephemeral HTTP server bound to 127.0.0.1 (OS-assigned port) that
 * captures the query params of the first request to /callback — the OAuth
 * redirect target (RFC 8252 loopback interface redirection).
 */
export function startLoopbackCapture(): Promise<LoopbackCapture> {
  return new Promise((resolveCapture, rejectCapture) => {
    let settled = false
    let resolveWait: ((params: URLSearchParams) => void) | undefined
    let rejectWait: ((err: Error) => void) | undefined

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body>Signed in — you can close this tab.</body></html>')
      if (resolveWait) {
        resolveWait(url.searchParams)
      }
      // Auto-close after handling the callback.
      server.close()
    })

    server.on('error', (err) => {
      if (!settled) {
        settled = true
        rejectCapture(err as Error)
      } else if (rejectWait) {
        rejectWait(err as Error)
      }
    })

    server.listen(0, '127.0.0.1', () => {
      settled = true
      const address = server.address() as AddressInfo
      const redirectUri = `http://127.0.0.1:${address.port}/callback`

      const capture: LoopbackCapture = {
        redirectUri,
        wait(timeoutMs = DEFAULT_TIMEOUT_MS) {
          return new Promise<URLSearchParams>((resolve, reject) => {
            resolveWait = (params) => {
              clearTimeout(timer)
              resolve(params)
            }
            rejectWait = (err) => {
              clearTimeout(timer)
              reject(err)
            }
            const timer = setTimeout(() => {
              server.close()
              reject(new Error('Loopback capture timeout: no OAuth redirect received'))
            }, timeoutMs)
          })
        },
        close() {
          server.close()
        }
      }

      resolveCapture(capture)
    })
  })
}
