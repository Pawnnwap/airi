import { createContext, defineInvoke } from '@moeru/eventa'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { electronAppOpenUserDataFolder, sovereignCoreRequest } from '../../../shared/eventa'
import { createAppService } from './app'

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(),
  quit: vi.fn(),
}))

const shellMock = vi.hoisted(() => ({
  openPath: vi.fn(),
}))

vi.mock('electron', () => ({
  app: appMock,
  shell: shellMock,
}))

vi.mock('std-env', () => ({
  isLinux: false,
  isMacOS: false,
  isWindows: true,
}))

describe('createAppService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('opens the Electron userData folder and returns its path', async () => {
    const context = createContext()
    appMock.getPath.mockReturnValue('/tmp/airi-user-data')
    shellMock.openPath.mockResolvedValue('')

    createAppService({ context: context as never, window: {} as never })

    const openUserDataFolder = defineInvoke(context, electronAppOpenUserDataFolder)

    await expect(openUserDataFolder()).resolves.toEqual({ path: '/tmp/airi-user-data' })
    expect(appMock.getPath).toHaveBeenCalledWith('userData')
    expect(shellMock.openPath).toHaveBeenCalledWith('/tmp/airi-user-data')
  })

  it('throws when Electron fails to open the userData folder', async () => {
    const context = createContext()
    appMock.getPath.mockReturnValue('/tmp/airi-user-data')
    shellMock.openPath.mockResolvedValue('Failed to open path')

    createAppService({ context: context as never, window: {} as never })

    const openUserDataFolder = defineInvoke(context, electronAppOpenUserDataFolder)

    await expect(openUserDataFolder()).rejects.toThrow('Failed to open path')
    expect(appMock.getPath).toHaveBeenCalledWith('userData')
    expect(shellMock.openPath).toHaveBeenCalledWith('/tmp/airi-user-data')
  })

  it('keeps Sovereign Core requests on approved loopback routes', async () => {
    const context = createContext()
    createAppService({ context: context as never, window: {} as never })
    const requestCore = defineInvoke(context, sovereignCoreRequest)
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{"bundle_id":"local"}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestCore({ method: 'GET', path: '//remote.example/v1/status', timeoutMs: 500 })).rejects.toThrow('Invalid Sovereign Core path')
    await expect(requestCore({ method: 'POST', path: '/v1/status', timeoutMs: 500 })).rejects.toThrow('Sovereign Core route denied')
    expect(fetchMock).not.toHaveBeenCalled()

    await expect(requestCore({ method: 'GET', path: '/v1/status', timeoutMs: 500 })).resolves.toEqual({ bundle_id: 'local' })
    await expect(requestCore({ method: 'POST', path: '/v1/turns/cancel', body: { request_id: 'turn-1' }, timeoutMs: 500 })).resolves.toEqual({ bundle_id: 'local' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0].origin).toBe('http://127.0.0.1:8700')
    expect(fetchMock.mock.calls[1][0].pathname).toBe('/v1/turns/cancel')
  })
})
