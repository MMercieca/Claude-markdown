import { contextBridge } from 'electron'

// Typed stub — channels are wired in step 7 (typed IPC contract).
// Exposing the key now locks down the surface: renderer can only reach main
// through window.api, never through require or node globals.
const api = {} as const

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
