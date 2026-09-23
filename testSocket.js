const { io } = require('socket.io-client');

const socket = io('https://arthurvault-backend-production.up.railway.app');

socket.on('connect', () => {
  console.log('Connected to Railway Backend:', socket.id);
  console.log('Sending wa:start...');
  socket.emit('wa:start');
});

socket.on('wa:status', (data) => {
  console.log('Received wa:status:', data.status);
  if (data.status === 'ERROR') {
    console.error('Error Details:', data.error);
    process.exit(1);
  }
  if (data.qr) {
    console.log('QR EVENT RECEIVED: YES');
    console.log('QR string length:', data.qr.length);
    process.exit(0);
  }
});

socket.on('disconnect', () => {
  console.log('Disconnected');
});
