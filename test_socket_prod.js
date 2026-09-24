const io = require('socket.io-client');

async function testProd() {
    console.log('[CLIENT] Connecting Socket.IO client...');
    const socket = io('https://arthurvault-backend-production.up.railway.app', {
        transports: ['polling', 'websocket']
    });

    socket.on('connect', () => {
        console.log(`[CLIENT] CONNECTED! Socket ID: ${socket.id}`);
        console.log(`[CLIENT] Requesting groups...`);

        socket.emit('wa:get_groups', (response) => {
            if (response.success) {
                console.log(`[CLIENT] Initial groups received: ${response.groups.length}`);
                if (response.groups.length > 0) {
                    console.log(`[CLIENT] Group 0:`, response.groups[0]);
                }
            } else {
                console.error(`[CLIENT] get_groups error:`, response.error);
            }
        });
    });

    let enrichedCount = 0;
    socket.on('wa:group_enriched', (enriched) => {
        enrichedCount++;
        if (enrichedCount <= 3 || enriched.photoUrl) {
            console.log(`[CLIENT] GROUP_ENRICH_RECEIVED [${enrichedCount}]:`, JSON.stringify(enriched, null, 2));
            
            // Test extraction on the first group that has participants or photo
            if (enrichedCount === 1) {
                console.log(`\n[CLIENT] Requesting participants for group: ${enriched.id}`);
                socket.emit('wa:get_group_participants', enriched.id, (res) => {
                    if (res.success) {
                        console.log(`[CLIENT] PARTICIPANTS RECEIVED! Count: ${res.participants.length}`);
                        console.log(`[CLIENT] First participant:`, res.participants[0]);
                    } else {
                        console.error(`[CLIENT] PARTICIPANTS ERROR:`, res.error);
                    }
                });
            }
        }
    });

    socket.on('connect_error', (err) => {
        console.error(`[CLIENT] connect_error:`, err.message);
        process.exit(1);
    });
    
    setTimeout(() => {
        console.log(`[CLIENT] Timeout reached. Exiting.`);
        process.exit(0);
    }, 20000);
}

testProd();
