const io = require('socket.io-client');
const socket = io('https://arthurvault-backend-production.up.railway.app', { transports: ['polling', 'websocket'] });

socket.on('connect', () => {
    console.log('[TEST] Connected, calling get_groups...');
    socket.emit('wa:get_groups', (res) => {
        if (res.success) {
            console.log(`[TEST] SUCCESS! Groups length: ${res.groups.length}`);
            // Wait to see if enriched events arrive
            setTimeout(() => {
                console.log('[TEST] Finished waiting for enrich events.');
                process.exit(0);
            }, 10000);
        } else {
            console.log(`[TEST] FAILED! Error: ${res.error}`);
            process.exit(1);
        }
    });
});

let count = 0;
socket.on('wa:group_enriched', (data) => {
    count++;
    console.log(`[ENRICH] ${count}: ${data.id} - Participants: ${data.participantsCount} - Photo: ${data.photoUrl ? 'YES' : 'NO'}`);
});

setTimeout(() => {
    console.log('Timeout overall');
    process.exit(1);
}, 20000);
