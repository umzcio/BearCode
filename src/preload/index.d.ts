import type { BearcodeApi } from '../shared/types'

declare global {
  interface Window {
    bearcode: BearcodeApi
  }
}
