const io = require('socket.io-client');
const socket = io('https://arthurvault-backend-production.up.railway.app', { transports: ['websocket', 'polling'] });
socket.on('connect', () => {
    console.log('Connected');
    socket.emit('wa:start');
});

socket.on('wa:status', (data) => {
    console.log('Status:', data.status);
    if (data.status === 'READY') {
        socket.emit('wa:get_groups', (res) => {
            console.log('Got groups response. Waiting for enrichment logs on railway...');
            setTimeout(() => {
                console.log('Closing');
                process.exit(0);
            }, 30000);
        });
    }
});
