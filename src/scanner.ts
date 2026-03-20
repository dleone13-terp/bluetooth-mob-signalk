import noble from '@abandonware/noble';
import * as dgram from 'dgram';

// Target UDP configuration
const HOST = process.argv[2] || process.env.SCANNER_HOST || '127.0.0.1';
const PORT = parseInt(process.argv[3] || process.env.SCANNER_PORT || '51234', 10);

const client = dgram.createSocket('udp4');

console.log(`Starting Bluetooth scanner. Sending UDP datagrams to ${HOST}:${PORT}`);

noble.on('stateChange', (state: string) => {
  console.log(`Bluetooth state changed: ${state}`);
  if (state === 'poweredOn') {
    noble.startScanning([], true);
    console.log('Scanning started...');
  } else {
    noble.stopScanning();
    console.log('Scanning stopped.');
  }
});

noble.on('discover', (peripheral: any) => {
  const payload = {
    address: peripheral.address,
    rssi: peripheral.rssi,
    advertisement: {
      localName: peripheral.advertisement?.localName || null
    }
  };

  const message = Buffer.from(JSON.stringify(payload));
  
  client.send(message, PORT, HOST, (err: Error | null) => {
    if (err) {
      console.error(`Error sending UDP message to ${HOST}:${PORT}`, err);
    }
  });
});

process.on('SIGINT', () => {
  client.close();
  noble.stopScanning();
  process.exit(0);
});

process.on('SIGTERM', () => {
  client.close();
  noble.stopScanning();
  process.exit(0);
});
