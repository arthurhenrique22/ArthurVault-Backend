const io = require('socket.io-client');
const fetch = require('node-fetch'); // actually Node 20 has native fetch

async function testPolling() {
    try {
        const res = await fetch('https://arthurvault-backend-production.up.railway.app/socket.io/?EIO=4&transport=polling');
        const text = await res.text();
        console.log(`[TEST 2] Polling HTTP Status: ${res.status}`);
        console.log(`[TEST 2] Polling Handshake: ${text.substring(0, 100)}...`);
    } catch(e) {
        console.error(`[TEST 2] Failed:`, e.message);
    }
}

function testSocketClient() {
    console.log('[TEST 3] Connecting Socket.IO client...');
    const socket = io('https://arthurvault-backend-production.up.railway.app', {
        transports: ['polling', 'websocket']
    });

    socket.on('connect', () => {
        console.log(`[TEST 3] CONNECTED! Socket ID: ${socket.id}`);
        process.exit(0);
    });

    socket.on('connect_error', (err) => {
        console.error(`[TEST 3] connect_error:`, err.message);
        process.exit(1);
    });

    setTimeout(() => {
        console.error(`[TEST 3] Timeout`);
        process.exit(1);
    }, 10000);
}

testPolling().then(testSocketClient);
