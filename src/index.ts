import { Plugin, ServerAPI } from '@signalk/server-api'
import noble from '@abandonware/noble'
import * as dgram from 'dgram'

interface SeenDevice {
  address: string
  name: string | null
  firstSeen: string
  lastSeen: string
  rssi: number
  count: number
  lastPosition: { latitude: number; longitude: number } | null
}

interface WatchedDevice {
  address: string
  userName: string
  timeoutSeconds: number
}

let app: ServerAPI
const seenDevices = new Map<string, SeenDevice>()
const watchedDevices = new Map<string, WatchedDevice>()
const mobActive = new Set<string>()
const subscriptions: any[] = []
let checkTimer: NodeJS.Timeout | null = null
let udpServer: dgram.Socket | null = null

const plugin: Plugin = {
  id: 'signalk-bluetooth-scanner',
  name: 'Bluetooth Scanner',

  start: function (options: any) {
    app.debug('Plugin started')
    app.setPluginStatus('Initializing...')

    const useExternalScanner = options?.useExternalScanner || false
    const scannerHost = options?.scannerHost || '127.0.0.1'
    const scannerUdpPort = options?.scannerUdpPort || 51234

    if (useExternalScanner) {
      app.debug(`Starting UDP listener on ${scannerHost}:${scannerUdpPort} for external scanner...`)
      udpServer = dgram.createSocket('udp4')
      
      udpServer.on('error', (err) => {
        app.debug(`UDP Server Error: ${err.message}`)
        if (udpServer) udpServer.close()
        app.setPluginStatus(`Error: ${err.message}`)
      })

      udpServer.on('message', (msg) => {
        try {
          const peripheral = JSON.parse(msg.toString())
          handleDevice(peripheral)
        } catch (e) {
          app.debug('Failed to parse UDP message as JSON', msg.toString())
        }
      })

      udpServer.bind(scannerUdpPort, scannerHost, () => {
        app.setPluginStatus(`Listening on UDP ${scannerHost}:${scannerUdpPort}`)
        app.debug(`UDP server listening on ${scannerHost}:${scannerUdpPort}`)
        updatePluginStatus()
      })
    } else {
      noble.on('stateChange', (state) => {
        app.debug(`Bluetooth state changed: ${state}`)
        if (state === 'poweredOn') {
          noble.startScanning([], true)
          updatePluginStatus()
        } else {
          app.setPluginStatus(`Bluetooth ${state}`)
          noble.stopScanning()
        }
      })

      if ((noble as any)._state === 'poweredOn') {
        noble.startScanning([], true)
        updatePluginStatus()
      }

      noble.on('discover', handleDevice)
    }

    checkTimer = setInterval(checkWatchedDevices, 5000)
  },

  stop: function () {
    if (checkTimer) clearInterval(checkTimer)
    subscriptions.forEach(unsubscribe => unsubscribe())
    subscriptions.length = 0
    if (udpServer) {
      udpServer.close()
      udpServer = null
    } else {
      noble.stopScanning()
      noble.removeAllListeners()
    }
    seenDevices.clear()
  },

  schema: () => ({
    type: 'object',
    properties: {
      useExternalScanner: {
        type: 'boolean',
        title: 'Use External Scanner',
        description: 'Run the Bluetooth scanner externally (e.g. as root) and bind to a UDP port to receive device datagrams',
        default: false
      },
      scannerHost: {
        type: 'string',
        title: 'Scanner Host IP',
        description: 'The IP address to bind the UDP listener',
        default: '127.0.0.1'
      },
      scannerUdpPort: {
        type: 'number',
        title: 'Scanner UDP Port',
        description: 'The UDP port to listen on and the external scanner script to transmit to',
        default: 51234
      }
    }
  }),

  registerWithRouter: function (router) {

    router.get('/devices', (_req: any, res: any) => {
      res.json({ devices: Array.from(seenDevices.values()), count: seenDevices.size })
    })

    router.get('/watched', (_req: any, res: any) => {
      res.json({ watched: Array.from(watchedDevices.values()) })
    })

    router.post('/watch', (req: any, res: any) => {
      const { address, userName, timeoutSeconds } = req.body
      if (!address || !userName || !timeoutSeconds) {
        return res.status(400).json({ error: 'Missing required fields' })
      }
      watchedDevices.set(address, { address, userName, timeoutSeconds })
      app.debug(`Watching ${userName} (${address}) - ${timeoutSeconds}s timeout`)
      
      // Subscribe to notification path to detect when it's cleared
      const key = userName.replace(/\s+/g, '_').toLowerCase()
      const localUnsubscribes: any[] = []
      
      app.subscriptionmanager.subscribe(
        {
          context: 'vessels.self',
          subscribe: [{
            path: `notifications.mob.${key}`,
            period: 1000
          }]
        } as any,
        localUnsubscribes,
        (err: any) => { app.debug(`Subscription error: ${err}`) },
        () => {
          const notification = app.getSelfPath(`notifications.mob.${key}.value`)
          if (!notification || notification.state === 'normal' || notification.state === null) {
            mobActive.delete(address)
            app.debug(`MOB cleared for ${userName}, can re-trigger`)
          }
        }
      )
      
      subscriptions.push(...localUnsubscribes)
      
      updatePluginStatus()
      res.json({ success: true })
    })

    router.delete('/watch/:address', (req: any, res: any) => {
      app.debug(`Unwatching device: ${req.params.address}`)
      watchedDevices.delete(req.params.address)
      mobActive.delete(req.params.address)
      updatePluginStatus()
      res.json({ success: true })
    })
  }
}

function handleDevice(peripheral: any) {
  const address = peripheral.address
  const now = new Date().toISOString()
  const device = seenDevices.get(address)

  const currentPosition = app.getSelfPath('navigation.position.value')
  
  if (device) {
    device.lastSeen = now
    device.rssi = peripheral.rssi
    device.count++
    device.lastPosition = currentPosition || device.lastPosition
    if (peripheral.advertisement?.localName && !device.name) {
      device.name = peripheral.advertisement.localName
    }
  } else {
    seenDevices.set(address, {
      address,
      name: peripheral.advertisement?.localName || null,
      firstSeen: now,
      lastSeen: now,
      rssi: peripheral.rssi,
      count: 1,
      lastPosition: currentPosition
    })
    app.debug(`New device: ${address} (${peripheral.advertisement?.localName || 'Unknown'})`)
  }
}

function checkWatchedDevices() {
  const now = Date.now()

  
  watchedDevices.forEach((watched, address) => {
    const device = seenDevices.get(address)
    if (!device) return

    const elapsed = (now - new Date(device.lastSeen).getTime()) / 1000
    
    if (elapsed > watched.timeoutSeconds && !mobActive.has(address)) {
      mobActive.add(address)
      app.debug(`MOB triggered: ${watched.userName} (${address}) - not seen for ${Math.floor(elapsed)}s`)
      
      const key = watched.userName.replace(/\s+/g, '_').toLowerCase()
      const lastSeenTime = new Date(device.lastSeen).toLocaleTimeString()
      
      app.handleMessage(plugin.id, {
        context: 'vessels.self' as any,
        updates: [{
          timestamp: new Date().toISOString() as any,
          source: { label: plugin.id },
          values: [{
            path: `notifications.mob.${key}` as any,
            value: {
              state: 'emergency',
              method: ['visual', 'sound'],
              message: `${watched.userName} not seen since: ${lastSeenTime}`,
              ...(device.lastPosition && { position: device.lastPosition })
            }
          }]
        }]
      })
    }
  })
}

function updatePluginStatus() {
  if (watchedDevices.size === 0) {
    app.setPluginStatus('Scanning - no watches set')
  } else {
    const names = Array.from(watchedDevices.values()).map(w => w.userName).join(', ')
    app.setPluginStatus(`Watching: ${names}`)
  }
}

const startPlugin = (server: ServerAPI): Plugin => {
  app = server
  return plugin
}

module.exports = startPlugin
