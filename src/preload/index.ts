import { contextBridge, ipcRenderer } from 'electron'
import type { BearcodeApi, PingResult } from '../shared/types'

// The renderer talks to main only through this typed surface.
const bearcode: BearcodeApi = {
  ping: (): Promise<PingResult> => ipcRenderer.invoke('bearcode:ping')
}

contextBridge.exposeInMainWorld('bearcode', bearcode)
