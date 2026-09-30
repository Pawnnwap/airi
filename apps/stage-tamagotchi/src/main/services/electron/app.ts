import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow } from 'electron'

import process from 'node:process'

import { defineInvokeHandler } from '@moeru/eventa'
import { app, shell } from 'electron'
import { isLinux, isMacOS, isWindows } from 'std-env'

import { electron, electronAppOpenUserDataFolder, electronAppQuit, sovereignCoreRequest } from '../../../shared/eventa'

const SOVEREIGN_ROUTES = new Set([
  'GET /v1/status',
  'GET /v1/supplement',
  'GET /v1/recall',
  'POST /v1/turns',
  'POST /v1/turns/cancel',
  'POST /v1/turns/commit',
  'POST /v1/events',
  'POST /v1/dream',
  'POST /v1/forget',
  'POST /v1/erase',
  'POST /v1/capabilities/check',
])

export function createAppService(params: { context: ReturnType<typeof createContext>['context'], window: BrowserWindow }) {
  defineInvokeHandler(params.context, sovereignCoreRequest, async (request) => {
    if (!request.path.startsWith('/v1/') || request.path.startsWith('//'))
      throw new Error('Invalid Sovereign Core path')
    const url = new URL(request.path, 'http://127.0.0.1:8700')
    if (url.origin !== 'http://127.0.0.1:8700' || !SOVEREIGN_ROUTES.has(`${request.method} ${url.pathname}`))
      throw new Error('Sovereign Core route denied')
    const token = process.env.SOVEREIGN_API_TOKEN
    const response = await fetch(url, {
      method: request.method,
      headers: {
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(Math.min(Math.max(request.timeoutMs, 100), 30_000)),
    })
    const payload: unknown = await response.json()
    if (!response.ok)
      throw new Error(`Sovereign Core ${url.pathname} returned ${response.status}`)
    return payload
  })
  defineInvokeHandler(params.context, electron.app.isMacOS, () => isMacOS)
  defineInvokeHandler(params.context, electron.app.isWindows, () => isWindows)
  defineInvokeHandler(params.context, electron.app.isLinux, () => isLinux)
  defineInvokeHandler(params.context, electronAppOpenUserDataFolder, async () => {
    const path = app.getPath('userData')
    const openResult = await shell.openPath(path)
    if (openResult) {
      throw new Error(openResult)
    }
    return { path }
  })
  defineInvokeHandler(params.context, electronAppQuit, () => app.quit())
}
