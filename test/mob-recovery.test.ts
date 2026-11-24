import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const udpSocket = vi.hoisted(() => ({ on: vi.fn(), bind: vi.fn(), close: vi.fn() }))
vi.mock('dgram', () => ({ createSocket: vi.fn(() => udpSocket) }))

describe('Optional MOB clearing on beacon return', () => {
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

  function notificationValues() {
    return app.handleMessage.mock.calls.flatMap(([, delta]: any[]) =>
      delta.updates.flatMap((update: any) => update.values || [])
    ).filter((entry: any) => entry.path.startsWith('notifications.mob.'))
  }

  function mobValues() {
    return notificationValues().filter((entry: any) => entry.value?.state === 'emergency')
  }

  function nativeAlarms() {
    const values = new Map<string, any>()
    app.getSelfPath.mockImplementation((path: string) => path === 'navigation.position.value'
      ? { latitude: 38, longitude: -75 } : values.get(path))
    app.notifications = {
      mob: vi.fn(() => {
        const id = `alarm-${app.notifications.mob.mock.calls.length}`
        values.set(`notifications.mob.${id}.value`, { state: 'emergency' })
        clearNotification()
        return id
      }),
      clear: vi.fn((id: string) => {
        values.set(`notifications.mob.${id}.value`, { state: 'normal' })
        clearNotification()
      })
    }
    return values
  }

  function watch(timeoutSeconds = 6) {
    router['POST /watch'](
      { body: { address, userName: 'Crew member', timeoutSeconds } },
      { json: vi.fn(), status: vi.fn().mockReturnThis() }
    )
  }

  it('exposes automatic clearing as an unchecked configuration checkbox', () => {
    expect(plugin.schema().properties.autoClearMobOnReturn).toMatchObject({
      type: 'boolean', default: false,
      title: 'Automatically clear MOB when beacon returns'
    })
  })

  it.each([undefined, {}, { autoClearMobOnReturn: false }])(
    'keeps the native MOB active on return unless explicitly opted in: %j', options => {
      const alarms = nativeAlarms()
      plugin.start(options)
      watch(1)
      emit()
      vi.advanceTimersByTime(5000)
      emit()
      expect(app.notifications.clear).not.toHaveBeenCalled()
      expect(alarms.get('notifications.mob.alarm-1.value').state).toBe('emergency')
      vi.advanceTimersByTime(5000)
      expect(app.notifications.mob).toHaveBeenCalledTimes(1)
    }
  )

  it.each([undefined, {}, { autoClearMobOnReturn: false }])(
    'keeps the legacy MOB active on return unless explicitly opted in: %j', options => {
      plugin.start(options)
      watch(1)
      emit()
      vi.advanceTimersByTime(5000)
      emit()
      expect(notificationValues()).toHaveLength(1)
      expect(notificationValues()[0].value.state).toBe('emergency')
    }
  )

  it('reads the setting again on restart instead of retaining the previous enabled state', () => {
    nativeAlarms()
    plugin.start({ autoClearMobOnReturn: true })
    watch(1)
    emit()
    vi.advanceTimersByTime(5000)
    plugin.stop()
    plugin.start()
    emit()
    expect(app.notifications.clear).not.toHaveBeenCalled()
    plugin.stop()
    plugin.start({ autoClearMobOnReturn: true })
    emit()
    expect(app.notifications.clear).toHaveBeenCalledExactlyOnceWith('alarm-1')
  })

  it('clears only its native MOB on return, once, and re-alerts after another loss', () => {
    const alarms = nativeAlarms()
    alarms.set('notifications.mob.someone-else.value', { state: 'emergency' })
    plugin.start({ autoClearMobOnReturn: true })
    watch(1)
    emit()
    vi.advanceTimersByTime(5000)
    expect(app.notifications.mob).toHaveBeenCalledTimes(1)
    emit()
    expect(app.notifications.clear).toHaveBeenCalledExactlyOnceWith('alarm-1')
    expect(alarms.get('notifications.mob.alarm-1.value').state).toBe('normal')
    expect(alarms.get('notifications.mob.someone-else.value').state).toBe('emergency')
    vi.advanceTimersByTime(500)
    emit()
    expect(app.notifications.clear).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(4500)
    expect(app.notifications.mob).toHaveBeenCalledTimes(2)
  })

  it('clears the legacy alarm at the path used when it was raised, even after renaming', () => {
    plugin.start({ autoClearMobOnReturn: true })
    watch(1)
    emit()
    vi.advanceTimersByTime(5000)
    router['POST /watch']({ body: { address, userName: 'Renamed tag', timeoutSeconds: 1 } },
      { json: vi.fn() })
    emit()
    expect(notificationValues().at(-1)).toEqual({ path: 'notifications.mob.crew_member', value: null })
    vi.advanceTimersByTime(5000)
    expect(mobValues().at(-1).path).toBe('notifications.mob.renamed_tag')
  })

  it('does not clear a MOB for stale, out-of-order, invalid or future reports', () => {
    nativeAlarms()
    plugin.start({ autoClearMobOnReturn: true })
    watch(1)
    const first = Date.now()
    emit()
    vi.advanceTimersByTime(5000)
    emit({ timestamp: first })
    emit({ timestamp: first - 1 })
    emit({ timestamp: first + 1000 }) // Newer report, still beyond the timeout.
    emit({ timestamp: NaN })
    emit({ timestamp: Date.now() + 1000 })
    emit({ mac: '11:22:33:44:55:66' }) // A different beacon is not recovery.
    expect(app.notifications.clear).not.toHaveBeenCalled()
    emit()
    expect(app.notifications.clear).toHaveBeenCalledExactlyOnceWith('alarm-1')
  })

  it('retries an unsuccessful clear when the next recent contact arrives', () => {
    nativeAlarms()
    plugin.start({ autoClearMobOnReturn: true })
    watch(1)
    emit()
    vi.advanceTimersByTime(5000)
    app.notifications.clear.mockImplementationOnce(() => { throw new Error('Temporary error') })
    emit()
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining('Failed to clear MOB'))
    vi.advanceTimersByTime(100)
    emit()
    expect(app.notifications.clear).toHaveBeenCalledTimes(2)
    expect(app.notifications.clear).toHaveBeenLastCalledWith('alarm-1')
  })

  it('does not clear another MOB when its own alert was already manually cleared', () => {
    const alarms = nativeAlarms()
    plugin.start({ autoClearMobOnReturn: true })
    watch(1)
    emit()
    vi.advanceTimersByTime(5000)
    alarms.set('notifications.mob.alarm-1.value', { state: 'normal' })
    clearNotification()
    emit()
    expect(app.notifications.clear).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    expect(app.notifications.mob).toHaveBeenCalledTimes(2)
  })

  it('also clears a legacy alert when the external UDP scanner receives the beacon again', () => {
    plugin.start({ useExternalScanner: true, autoClearMobOnReturn: true })
    watch(1)
    const onMessage = udpSocket.on.mock.calls.find(([event]) => event === 'message')![1]
    const packet = Buffer.from(JSON.stringify({ address, rssi: -65 }))
    onMessage(packet)
    vi.advanceTimersByTime(5000)
    expect(mobValues()).toHaveLength(1)
    onMessage(packet)
    expect(notificationValues().at(-1)).toEqual({ path: 'notifications.mob.crew_member', value: null })
  })

})
