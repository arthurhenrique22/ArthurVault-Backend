const { io } = require('socket.io-client');

const socket = io('https://arthurflow-production.up.railway.app');

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
  if (data.status === 'READY') {
    console.log('WhatsApp is READY. Triggering wa:get_groups...');
    socket.emit('wa:get_groups');
  }
  if (data.qr) {
    console.log('QR EVENT RECEIVED: YES');
    console.log('Please scan the QR in your frontend app to proceed.');
  }
});

socket.on('wa:groups_list', (data) => {
  console.log('Received groups_list:', data.success);
  if (data.groups) {
    console.log(`Received ${data.groups.length} groups.`);
  }
  process.exit(0);
});

socket.on('wa:groups_error', (err) => {
  console.error('Groups Error:', err);
  process.exit(1);
});

socket.on('disconnect', () => {
  console.log('Disconnected');
});
