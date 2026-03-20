import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('Bluetooth MOB Plugin', () => {
  let plugin: any
  let mockApp: any
  let noble: any
  let discoverHandler: any
  let stateChangeHandler: any

  beforeEach(async () => {
    vi.clearAllMocks()
    
    // Create noble mock
    noble = {
      on: vi.fn((event: string, handler: any) => {
        if (event === 'discover') discoverHandler = handler
        if (event === 'stateChange') stateChangeHandler = handler
      }),
      startScanning: vi.fn(),
      stopScanning: vi.fn(),
      removeAllListeners: vi.fn(),
      _state: 'poweredOff'
    }
    
    // Mock Signal K server API
    mockApp = {
      debug: vi.fn(),
      setPluginStatus: vi.fn(),
      getSelfPath: vi.fn().mockReturnValue({ latitude: 38.0, longitude: -75.0 }),
      handleMessage: vi.fn(),
      subscriptionmanager: {
        subscribe: vi.fn((msg, unsubs, errCb, cb) => {
          unsubs.push(() => {})
        })
      }
    }

    const path = require('path')
    const fs = require('fs')

    // Ensure noble mock is available for both CJS and ESM imports
    const noblePath = require.resolve('@abandonware/noble')
    try { delete require.cache[noblePath] } catch (e) {}
    const nobleModule = { default: noble, __esModule: true }
    require.cache[noblePath] = {
      id: noblePath,
      filename: noblePath,
      loaded: true,
      exports: nobleModule
    } as any

    // Prefer compiled plugin if present, otherwise import TS source
    const compiledPath = path.resolve(__dirname, '../plugin/index.js')
    let pluginConstructor: any
    if (fs.existsSync(compiledPath)) {
      try { delete require.cache[require.resolve(compiledPath)] } catch (e) {}
      pluginConstructor = require(compiledPath)
    } else {
      const mod = await import('../src/index')
      pluginConstructor = (mod && (mod as any).default) || mod
    }
    plugin = pluginConstructor(mockApp)
  })

  afterEach(() => {
    if (plugin.stop) {
      try {
        plugin.stop()
      } catch (e) {
        // Ignore noble errors in test cleanup
      }
    }
    delete require.cache[require.resolve('@abandonware/noble')]
  })

  describe('Device Discovery', () => {
    it('should track new devices when discovered', () => {
      plugin.start()
      
      // Verify handler was captured
      expect(noble.on).toHaveBeenCalledWith('discover', expect.any(Function))
      expect(discoverHandler).toBeDefined()
      
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50,
        advertisement: { localName: 'Test Device' }
      }
      
      discoverHandler(peripheral)
      
      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining('New device: aa:bb:cc:dd:ee:ff')
      )
    })

    it('should update existing device RSSI and timestamp', () => {
      plugin.start()
      
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50,
        advertisement: { localName: 'Test' }
      }
      
      discoverHandler(peripheral)
      discoverHandler({ ...peripheral, rssi: -45 })
      
      // Device should have been discovered twice
      expect(mockApp.debug).toHaveBeenCalledTimes(2) // Started + New device
    })

    it('should store vessel position with device sighting', () => {
      plugin.start()
      
      mockApp.getSelfPath.mockReturnValue({ latitude: 39.0, longitude: -76.0 })
      
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50,
        advertisement: {}
      }
      
      discoverHandler(peripheral)
      
      expect(mockApp.getSelfPath).toHaveBeenCalledWith('navigation.position.value')
    })

    it('should handle devices without names', () => {
      plugin.start()
      
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50,
        advertisement: {}
      }
      
      expect(() => discoverHandler(peripheral)).not.toThrow()
      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining('Unknown')
      )
    })

    it('should update device name if initially unknown', () => {
      plugin.start()
      
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50,
        advertisement: {}
      }
      
      discoverHandler(peripheral)
      discoverHandler({ ...peripheral, advertisement: { localName: 'Named Device' } })
      
      // Should log the update
      expect(mockApp.debug).toHaveBeenCalled()
    })
  })

  describe('Watch Functionality', () => {
    let mockRouter: any

    beforeEach(() => {
      mockRouter = {
        get: vi.fn((path, handler) => { mockRouter[`get_${path}`] = handler }),
        post: vi.fn((path, handler) => { mockRouter[`post_${path}`] = handler }),
        delete: vi.fn((path, handler) => { mockRouter[`delete_${path}`] = handler })
      }
      
      plugin.registerWithRouter(mockRouter)
    })

    it('should add device to watched list', () => {
      const req = {
        body: { address: 'aa:bb:cc:dd:ee:ff', userName: 'John', timeoutSeconds: 30 }
      }
      const res = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis()
      }
      
      mockRouter['post_/watch'](req, res)
      
      expect(res.json).toHaveBeenCalledWith({ success: true })
      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining('Watching John')
      )
    })

    it('should require all fields (address, userName, timeoutSeconds)', () => {
      const req = { body: { address: 'aa:bb:cc:dd:ee:ff' } }
      const res = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis()
      }
      
      mockRouter['post_/watch'](req, res)
      
      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing required fields' })
    })

    it('should remove device from watched list', () => {
      // First add a watch
      const addReq = {
        body: { address: 'aa:bb:cc:dd:ee:ff', userName: 'John', timeoutSeconds: 30 }
      }
      const addRes = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      mockRouter['post_/watch'](addReq, addRes)
      
      // Then remove it
      const delReq = { params: { address: 'aa:bb:cc:dd:ee:ff' } }
      const delRes = { json: vi.fn() }
      mockRouter['delete_/watch/:address'](delReq, delRes)
      
      expect(delRes.json).toHaveBeenCalledWith({ success: true })
      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining('Unwatching device: aa:bb:cc:dd:ee:ff')
      )
    })

    it('should update plugin status when watches change', () => {
      const req = {
        body: { address: 'aa:bb:cc:dd:ee:ff', userName: 'Alice', timeoutSeconds: 30 }
      }
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      
      mockRouter['post_/watch'](req, res)
      
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith(
        expect.stringContaining('Watching: Alice')
      )
    })

    it('should subscribe to notification path when watching', () => {
      const req = {
        body: { address: 'aa:bb:cc:dd:ee:ff', userName: 'John Doe', timeoutSeconds: 30 }
      }
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      
      mockRouter['post_/watch'](req, res)
      
      expect(mockApp.subscriptionmanager.subscribe).toHaveBeenCalledWith(
        expect.objectContaining({
          context: 'vessels.self',
          subscribe: expect.arrayContaining([
            expect.objectContaining({
              path: 'notifications.mob.john_doe'
            })
          ])
        }),
        expect.any(Array),
        expect.any(Function),
        expect.any(Function)
      )
    })
  })

  describe('MOB Alert Triggering', () => {
    let mockRouter: any

    beforeEach(() => {
      mockRouter = {
        get: vi.fn((path, handler) => { mockRouter[`get_${path}`] = handler }),
        post: vi.fn((path, handler) => { mockRouter[`post_${path}`] = handler }),
        delete: vi.fn((path, handler) => { mockRouter[`delete_${path}`] = handler })
      }
      
      plugin.registerWithRouter(mockRouter)
      plugin.start()
    })

    it('should trigger MOB when device not seen for timeout period', async () => {
      // Discover device
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50,
        advertisement: { localName: 'John Device' }
      }
      discoverHandler(peripheral)
      
      // Add watch
      const req = {
        body: { address: 'aa:bb:cc:dd:ee:ff', userName: 'John', timeoutSeconds: 1 }
      }
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      mockRouter['post_/watch'](req, res)
      
      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 6000))
      
      expect(mockApp.handleMessage).toHaveBeenCalledWith(
        'signalk-bluetooth-scanner',
        expect.objectContaining({
          context: 'vessels.self',
          updates: expect.arrayContaining([
            expect.objectContaining({
              values: expect.arrayContaining([
                expect.objectContaining({
                  path: 'notifications.mob.john',
                  value: expect.objectContaining({
                    state: 'emergency'
                  })
                })
              ])
            })
          ])
        })
      )
    }, 10000)

    it('should include last known position in notification', async () => {
      mockApp.getSelfPath.mockReturnValue({ latitude: 38.5, longitude: -75.5 })
      
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50,
        advertisement: {}
      }
      discoverHandler(peripheral)
      
      const req = {
        body: { address: 'aa:bb:cc:dd:ee:ff', userName: 'Test', timeoutSeconds: 1 }
      }
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      mockRouter['post_/watch'](req, res)
      
      await new Promise(resolve => setTimeout(resolve, 6000))
      
      expect(mockApp.handleMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          updates: expect.arrayContaining([
            expect.objectContaining({
              values: expect.arrayContaining([
                expect.objectContaining({
                  value: expect.objectContaining({
                    position: { latitude: 38.5, longitude: -75.5 }
                  })
                })
              ])
            })
          ])
        })
      )
    }, 10000)

    it('should use emergency state', async () => {
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50,
        advertisement: {}
      }
      discoverHandler(peripheral)
      
      const req = {
        body: { address: 'aa:bb:cc:dd:ee:ff', userName: 'Test', timeoutSeconds: 1 }
      }
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      mockRouter['post_/watch'](req, res)
      
      await new Promise(resolve => setTimeout(resolve, 6000))
      
      const call = mockApp.handleMessage.mock.calls[0]
      expect(call[1].updates[0].values[0].value.state).toBe('emergency')
    }, 10000)

    it('should sanitize userName for path (spaces to underscores)', async () => {
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50,
        advertisement: {}
      }
      discoverHandler(peripheral)
      
      const req = {
        body: { address: 'aa:bb:cc:dd:ee:ff', userName: 'John Doe', timeoutSeconds: 1 }
      }
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      mockRouter['post_/watch'](req, res)
      
      await new Promise(resolve => setTimeout(resolve, 6000))
      
      const call = mockApp.handleMessage.mock.calls[0]
      expect(call[1].updates[0].values[0].path).toBe('notifications.mob.john_doe')
    }, 10000)
  })

  describe('REST API Endpoints', () => {
    let mockRouter: any

    beforeEach(() => {
      mockRouter = {
        get: vi.fn((path, handler) => { mockRouter[`get_${path}`] = handler }),
        post: vi.fn((path, handler) => { mockRouter[`post_${path}`] = handler }),
        delete: vi.fn((path, handler) => { mockRouter[`delete_${path}`] = handler })
      }
      
      plugin.registerWithRouter(mockRouter)
      plugin.start()
    })

    it('GET /devices should return all discovered devices', () => {
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50,
        advertisement: { localName: 'Test' }
      }
      discoverHandler(peripheral)
      
      const req = {}
      const res = { json: vi.fn() }
      
      mockRouter['get_/devices'](req, res)
      
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          devices: expect.arrayContaining([
            expect.objectContaining({
              address: 'aa:bb:cc:dd:ee:ff'
            })
          ]),
          count: 1
        })
      )
    })

    it('GET /watched should return watched devices list', () => {
      const addReq = {
        body: { address: 'aa:bb:cc:dd:ee:ff', userName: 'John', timeoutSeconds: 30 }
      }
      const addRes = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      mockRouter['post_/watch'](addReq, addRes)
      
      const req = {}
      const res = { json: vi.fn() }
      mockRouter['get_/watched'](req, res)
      
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          watched: expect.arrayContaining([
            expect.objectContaining({
              address: 'aa:bb:cc:dd:ee:ff',
              userName: 'John'
            })
          ])
        })
      )
    })
  })

  describe('Plugin Lifecycle', () => {
    it('should initialize Bluetooth on start', () => {
      plugin.start()
      
      expect(mockApp.debug).toHaveBeenCalledWith('Plugin started')
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Initializing...')
    })

    it('should start scanning when Bluetooth powered on', () => {
      plugin.start()
      
      stateChangeHandler('poweredOn')
      
      expect(noble.startScanning).toHaveBeenCalledWith([], true)
    })

    it('should start scanning if already powered on', () => {
      noble._state = 'poweredOn'
      
      plugin.start()
      
      expect(noble.startScanning).toHaveBeenCalled()
    })

    it('should stop scanning on plugin stop', () => {
      plugin.start()
      plugin.stop()
      
      expect(noble.stopScanning).toHaveBeenCalled()
    })

    it('should remove noble listeners on stop', () => {
      plugin.start()
      plugin.stop()
      
      expect(noble.removeAllListeners).toHaveBeenCalled()
    })
  })

  describe('Plugin Status', () => {
    let mockRouter: any

    beforeEach(() => {
      mockRouter = {
        get: vi.fn((path, handler) => { mockRouter[`get_${path}`] = handler }),
        post: vi.fn((path, handler) => { mockRouter[`post_${path}`] = handler }),
        delete: vi.fn((path, handler) => { mockRouter[`delete_${path}`] = handler })
      }
      
      plugin.registerWithRouter(mockRouter)
    })

    it('should show "Initializing..." on start', () => {
      plugin.start()
      
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Initializing...')
    })

    it('should show "Scanning - no watches set" when not watching', () => {
      plugin.start()
      noble._state = 'poweredOn'
      stateChangeHandler('poweredOn')
      
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Scanning - no watches set')
    })

    it('should show watched device names when watching', () => {
      plugin.start()
      
      const req = {
        body: { address: 'aa:bb:cc:dd:ee:ff', userName: 'Alice', timeoutSeconds: 30 }
      }
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
      
      mockRouter['post_/watch'](req, res)
      
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Watching: Alice')
    })

    it('should show multiple watched devices comma-separated', () => {
      plugin.start()
      
      mockRouter['post_/watch'](
        { body: { address: 'aa:bb:cc:dd:ee:ff', userName: 'Alice', timeoutSeconds: 30 } },
        { json: vi.fn(), status: vi.fn().mockReturnThis() }
      )
      
      mockRouter['post_/watch'](
        { body: { address: 'bb:bb:cc:dd:ee:ff', userName: 'Bob', timeoutSeconds: 30 } },
        { json: vi.fn(), status: vi.fn().mockReturnThis() }
      )
      
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Watching: Alice, Bob')
    })
  })

  describe('Edge Cases & Error Handling', () => {
    it('should handle devices without advertisement', () => {
      plugin.start()
      
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50
      }
      
      expect(() => discoverHandler(peripheral)).not.toThrow()
    })

    it('should handle missing GPS position gracefully', () => {
      mockApp.getSelfPath.mockReturnValue(null)
      plugin.start()
      
      const peripheral = {
        address: 'aa:bb:cc:dd:ee:ff',
        rssi: -50,
        advertisement: {}
      }
      
      expect(() => discoverHandler(peripheral)).not.toThrow()
    })

    it('should handle Bluetooth state change to poweredOff', () => {
      plugin.start()
      
      stateChangeHandler('poweredOff')
      
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Bluetooth poweredOff')
      expect(noble.stopScanning).toHaveBeenCalled()
    })
  })
})
