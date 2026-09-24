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
            
            if (enrichedCount === 1) {
                console.log(`\n[GROUP_ENRICH_EMIT]`);
                console.log(`id=${enriched.id}`);
                console.log(`participantsCount=${enriched.participantsCount}`);
                console.log(`photoUrl=${enriched.photoUrl}`);
                console.log(`photoStatus=${enriched.photoStatus}`);

                console.log(`\n[CLIENT] Requesting participants for group: ${enriched.id}`);
                socket.emit('wa:get_group_participants', enriched.id, async (res) => {
                    if (res.success) {
                        let photoStatus = 404;
                        let photoContentType = 'none';
                        if (enriched.photoUrl) {
                            try {
                                const proxyRes = await fetch(enriched.photoUrl);
                                photoStatus = proxyRes.status;
                                photoContentType = proxyRes.headers.get('content-type') || 'unknown';
                            } catch (e) {
                                photoStatus = 'error';
                            }
                        }

                        console.log(`\n[GROUP_RUNTIME_TEST]`);
                        console.log(`id=${enriched.id}`);
                        console.log(`name=${enriched.name}`);
                        console.log(`metadataFound=true`);
                        console.log(`participantsArrayFound=${res.participants.length > 0}`);
                        console.log(`participantsCount=${res.participants.length}`);
                        console.log(`photoResolved=${!!enriched.photoUrl}`);
                        console.log(`photoUrl=${enriched.photoUrl}`);
                        console.log(`photoRequestStatus=${photoStatus}`);
                        console.log(`photoContentType=${photoContentType}`);
                        
                        setTimeout(() => process.exit(0), 1000);
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
