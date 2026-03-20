# Bluetooth MOB Signal K Plugin

A Signal K plugin that monitors Bluetooth devices for Man Overboard (MOB) detection. When a watched device is no longer detected after a specified timeout, the plugin triggers an emergency MOB notification with the vessel's position.

## Philosophy

This plugin implements a "virtual tether" system similar to ACR OLAS. Crew members wear BLE tags that just send out a signal. When the signal isn't found for a certain amount of time, they are considered MOB. This approach provides continuous safety monitoring without the restrictions of physical tethers.

## Features

- 🔍 Continuous Bluetooth device scanning
- 👤 Watch specific devices (crew members)
- 🚨 Automatic MOB alert when device not detected
- 📍 Includes vessel position in MOB notification
- 🌐 Simple web interface for managing watches

## Installation

### Via Signal K AppStore

1. Open Signal K Admin UI
2. Navigate to **AppStore**
3. Search for "Bluetooth MOB"
4. Click **Install**

### Manual Installation

```bash
cd ~/.signalk
npm install signalk-bluetooth-scanner
```

### Development Installation

```bash
cd bluetooth-mob-signalk
npm install
npm run build
npm link

cd ~/.signalk
npm link signalk-bluetooth-scanner
```

## Setup

### Internal Scanner: Linux Bluetooth Permissions (Default)

If you intend to run the scanner within the Node.js process running Signal K, grant Node.js permission to access Bluetooth without root:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)
```

### External Root Scanner (Alternative)

If you do not want to give the `node` binary network capabilities or if your system does not support `setcap`, you can run a standalone root scanner script provided with this plugin. The script transmits telemetry back to the plugin via UDP.

This is primarily for use with VenusOS. It's a little hacky but it gets around the lack of setcap in Venus.

1. Navigate to **Server → Plugin Config** in the Signal K Admin UI.
2. Enable "Use External Scanner" in the Bluetooth Scanner settings. You can also configure the target UDP port.
3. Run the standalone scanner script as a system service or root process. You can optionally pass the host and port arguments (default `127.0.0.1 51234`):

```bash
# Example running the script via sudo:
sudo node ~/.signalk/node_modules/signalk-bluetooth-scanner/plugin/scanner.js 127.0.0.1 51234
```

**Recommended (`systemd` Service)**
To run the external scanner continuously in the background, create a systemd service file `/etc/systemd/system/bluetooth-mob-scanner.service`:
```ini
[Unit]
Description=Signal K Bluetooth MOB Scanner
After=bluetooth.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/node /home/pi/.signalk/node_modules/signalk-bluetooth-scanner/plugin/scanner.js 127.0.0.1 51234
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
Start and enable the service:
```bash
sudo systemctl daemon-reload
sudo systemctl start bluetooth-mob-scanner
sudo systemctl enable bluetooth-mob-scanner
```

### Enable Plugin

1. Navigate to **Server → Plugin Config** in the Signal K Admin UI
2. Find "Bluetooth Scanner" and enable it

## Usage

### Web Interface

Access at: `http://[your-signalk-server]:3000/signalk-bluetooth-scanner`

**To watch a device:**

1. Wait for devices to appear in the "Devices Seen" table
2. Click **Watch** on the device you want to monitor
3. Enter the person's name
4. Set timeout in seconds (e.g., 30 for 30 seconds)

**To stop watching:**

- Click **Unwatch** on any watched device

### MOB Notifications

When a watched device is not detected for the specified timeout:

- Emergency notification is sent to `notifications.mob.[person_name]`
- Notification includes the vessel's last known position
- Message format: `{name} not seen since: {time}`

### Clearing MOB Alerts

When you clear the MOB notification in Signal K:

- The watch continues monitoring
- A new alert can be triggered if the device is still missing

## API Endpoints

- `GET /plugins/signalk-bluetooth-scanner/devices` - List discovered devices
- `GET /plugins/signalk-bluetooth-scanner/watched` - List watched devices  
- `POST /plugins/signalk-bluetooth-scanner/watch` - Add a watch
- `DELETE /plugins/signalk-bluetooth-scanner/watch/:address` - Remove a watch

## Troubleshooting

### Bluetooth not working

Ensure Bluetooth is enabled:

```bash
sudo systemctl status bluetooth
sudo bluetoothctl power on
```

### Permission errors

Run the setcap command from the setup section above.

### Devices not appearing

- Ensure devices are powered on and transmitting
- Move closer to the devices
- Check that Bluetooth Low Energy (BLE) devices are advertising

## Use Case

This plugin is designed for monitoring crew members wearing Bluetooth-enabled devices (phones, smartwatches, dedicated MOB beacons). When someone goes overboard and their device is no longer in range, an immediate MOB alert is triggered with the vessel's position at the time of detection.
