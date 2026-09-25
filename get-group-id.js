const io = require('socket.io-client');
const socket = io('https://arthurvault-backend-production.up.railway.app');

socket.on('connect', () => {
  console.log('Connected!');
  socket.emit('wa:get_groups', (res) => {
     if (res.success && res.groups.length > 0) {
         console.log('Got groups:', res.groups.length);
         console.log('First group ID:', res.groups[0].id);
     } else {
         console.log('Response:', res);
     }
     process.exit(0);
  });
});

setTimeout(() => {
    console.log('Timeout');
    process.exit(1);
}, 10000);
