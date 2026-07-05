// Human-facing message for a caught unknown, with Electron's IPC wrapper
// stripped: a main-side `throw new Error('X')` reaches the renderer via
// ipcRenderer.invoke as "Error invoking remote method '<channel>': Error: X",
// which is debugging noise in a toast (Ba3 follow-up). Shared by every
// surface that shows a caught error to the user (store toasts, the Settings
// permissions manager). The copy always comes from the throw site -- this
// helper only unwraps, never rewrites.
export function describeError(err: unknown): string {
  if (!(err instanceof Error) || !err.message) return 'Something went wrong. Try again.'
  const m = /^Error invoking remote method '[^']*': (?:Error: )?([\s\S]+)$/.exec(err.message)
  return m ? m[1] : err.message
}
