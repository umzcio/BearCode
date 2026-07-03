import './styles/tokens.css'
import './styles/shared.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useAppStore } from './state/store'

if (import.meta.env.DEV) {
  // Handle for the dev smoke harness (src/main/devSmoke.ts).
  Object.assign(window, { __bearcodeStore: useAppStore })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
