import { shell } from 'electron'

/**
 * Opens an OAuth sign-in URL in the user's system browser. Never uses an
 * embedded webview — some IdPs (e.g. Google) block OAuth flows in webviews,
 * and it's also the safer place for the user to verify the URL/cert.
 */
export function openSignIn(url: string): Promise<void> {
  return shell.openExternal(url)
}
