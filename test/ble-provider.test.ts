import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const udpSocket = vi.hoisted(() => ({ on: vi.fn(), bind: vi.fn(), close: vi.fn() }))
vi.mock('dgram', () => ({ createSocket: vi.fn(() => udpSocket) }))

describe('Signal K BLE provider', () => {
  let plugin: any
  let app: any
  let router: any
  let advertise: (advertisement: any) => void
  let unsubscribe: ReturnType<typeof vi.fn>
  let clearNotification: () => void
  const address = 'aa:bb:cc:dd:ee:ff'

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    unsubscribe = vi.fn()
    app = {
      debug: vi.fn(),
      setPluginStatus: vi.fn(),
      getSelfPath: vi.fn(() => ({ latitude: 38, longitude: -75 })),
      handleMessage: vi.fn(),
      bleApi: {
        onAdvertisement: vi.fn((_id, callback) => {
          advertise = callback
          return unsubscribe
        }),
        getDevices: vi.fn(),
        stopDiscovery: vi.fn()
      },
      subscriptionmanager: {
        subscribe: vi.fn((_message, unsubscribes, _error, callback) => {
          clearNotification = callback
          unsubscribes.push(vi.fn())
        })
      }
    }
    const mod = await import('../src/index')
    const createPlugin = (mod as any).default || mod
    plugin = createPlugin(app)
    router = {
      get: (path: string, handler: any) => { router[`GET ${path}`] = handler },
      post: (path: string, handler: any) => { router[`POST ${path}`] = handler },
      delete: (path: string, handler: any) => { router[`DELETE ${path}`] = handler }
    }
    plugin.registerWithRouter(router)
  })

  afterEach(() => {
    plugin?.stop()
    vi.useRealTimers()
  })

  function emit(overrides: object = {}) {
    advertise({
      mac: address.toUpperCase(),
      name: 'Crew tag',
      rssi: -55,
      providerId: '_localBLE:hci0',
      timestamp: Date.now(),
      ...overrides
    })
  }

  function devices() {
    let response: any
    router['GET /devices']({}, { json: (value: any) => { response = value } })
    return response.devices
  }

  function watch(timeoutSeconds = 6) {
    router['POST /watch'](
      { body: { address, userName: 'Crew member', timeoutSeconds } },
      { json: vi.fn(), status: vi.fn().mockReturnThis() }
    )
  }

  it('subscribes as a BLE Manager consumer without loading Noble or polling cached devices', () => {
    plugin.start()
    expect(app.bleApi.onAdvertisement).toHaveBeenCalledWith(plugin.id, expect.any(Function))
    expect(app.bleApi.getDevices).not.toHaveBeenCalled()
    expect(require.cache[require.resolve('@abandonware/noble')]).toBeUndefined()
    emit()
    expect(devices()).toEqual([expect.objectContaining({
      address, name: 'Crew tag', rssi: -55, count: 1
    })])
  })

  it('keeps a watch alive on repeated advertisements with unchanged RSSI and payload', () => {
    plugin.start()
    emit()
    watch()
    vi.advanceTimersByTime(5000)
    emit()
    vi.advanceTimersByTime(5000)
    expect(app.handleMessage).not.toHaveBeenCalled()
    expect(devices()[0].count).toBe(2)
    vi.advanceTimersByTime(5000)
    expect(app.handleMessage).toHaveBeenCalledTimes(1)
    const alarm = app.handleMessage.mock.calls[0][1].updates[0].values[0]
    expect(alarm).toMatchObject({
      path: 'notifications.mob.crew_member',
      value: { state: 'emergency', position: { latitude: 38, longitude: -75 } }
    })
  })

  it('uses provider timestamps rather than the delivery time of delayed reports', () => {
    plugin.start()
    const first = Date.now()
    emit()
    watch(3)
    vi.advanceTimersByTime(4000)
    emit({ timestamp: first, providerId: 'esp32-gateway' })
    expect(devices()[0].lastSeen).toBe(new Date(first).toISOString())
    vi.advanceTimersByTime(1000)
    expect(app.handleMessage).toHaveBeenCalledTimes(1)
  })

  it('merges local and gateway reports for the same MAC without regressing lastSeen', () => {
    plugin.start()
    emit()
    vi.advanceTimersByTime(2000)
    emit({ mac: address, providerId: 'esp32-gateway', rssi: -40 })
    emit({ timestamp: Date.now() - 1000, rssi: -80 })
    expect(devices()).toEqual([expect.objectContaining({
      address, count: 2, rssi: -40, lastSeen: new Date().toISOString()
    })])
  })

  it('ignores invalid and future provider timestamps', () => {
    plugin.start()
    emit({ timestamp: NaN })
    emit({ timestamp: Date.now() + 60000 })
    expect(devices()).toEqual([])
  })

  it('does not re-alert until the existing MOB notification has been cleared', () => {
    plugin.start()
    emit()
    watch(1)
    vi.advanceTimersByTime(15000)
    expect(app.handleMessage).toHaveBeenCalledTimes(1)
    app.getSelfPath.mockReturnValue(null)
    clearNotification()
    vi.advanceTimersByTime(5000)
    expect(app.handleMessage).toHaveBeenCalledTimes(2)
  })

  it('does not alert for an unwatched device or a watch with no received sighting', () => {
    plugin.start()
    watch(1)
    vi.advanceTimersByTime(10000)
    expect(app.handleMessage).not.toHaveBeenCalled()
    emit()
    router['DELETE /watch/:address']({ params: { address } }, { json: vi.fn() })
    vi.advanceTimersByTime(10000)
    expect(app.handleMessage).not.toHaveBeenCalled()
  })

  it('unsubscribes on stop without stopping the shared scanner and can restart', () => {
    plugin.start()
    emit()
    plugin.stop()
    plugin.stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(app.bleApi.stopDiscovery).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(devices()).toEqual([])
    plugin.start()
    emit()
    expect(app.bleApi.onAdvertisement).toHaveBeenCalledTimes(2)
    expect(devices()[0].count).toBe(1)
  })

  it('can be stopped before it has started', () => {
    expect(() => plugin.stop()).not.toThrow()
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('honors the existing external UDP scanner setting ahead of the server API', () => {
    plugin.start({ useExternalScanner: true })
    expect(app.bleApi.onAdvertisement).not.toHaveBeenCalled()
    expect(udpSocket.bind).toHaveBeenCalledWith(51234, '127.0.0.1', expect.any(Function))
    const onMessage = udpSocket.on.mock.calls.find(([event]) => event === 'message')![1]
    onMessage(Buffer.from(JSON.stringify({ address, rssi: -65 })))
    expect(devices()[0]).toMatchObject({ address, rssi: -65 })
    plugin.stop()
    expect(udpSocket.close).toHaveBeenCalledTimes(1)
  })
})
