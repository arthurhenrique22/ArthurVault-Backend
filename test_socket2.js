const io = require('socket.io-client');
const socket = io('https://arthurvault-backend-production.up.railway.app', { transports: ['polling', 'websocket'] });

socket.on('connect', () => {
    console.log('[TEST] Connected, checking WA status...');
});

socket.on('wa:status', (data) => {
    console.log(`[WA_STATUS] ${JSON.stringify(data)}`);
    if (data.status === 'IDLE' || data.status === 'ERROR') {
        console.log('[TEST] Attempting to emit wa:initialize...');
        socket.emit('wa:initialize');
    }
});

socket.on('wa:qr', (qr) => {
    console.log(`[WA_QR] Received QR Code length: ${qr?.length}`);
    setTimeout(() => process.exit(0), 1000);
});

setTimeout(() => {
    console.log('Timeout');
    process.exit(0);
}, 10000);
