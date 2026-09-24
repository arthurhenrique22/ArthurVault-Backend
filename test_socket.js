const io = require('socket.io-client');

const socket = io('https://arthurvault-backend-production.up.railway.app');

socket.on('connect', () => {
    console.log('Connected to Railway Socket.IO');
    socket.emit('wa:get_groups', (res) => {
        console.log(`Initial get_groups returned: ${res?.groups?.length || 0} groups.`);
        console.log(`Waiting for enriched events...`);
    });
});

let enrichedCount = 0;
const enrichedData = [];

socket.on('wa:group_enriched', (data) => {
    enrichedCount++;
    enrichedData.push(data);
    console.log(`[ENRICHED] ${enrichedCount}: ${data.id} - Participants: ${data.participantsCount} (${data.participantStatus}) - Photo: ${data.photoUrl ? 'YES' : 'NO'} (${data.photoStatus})`);

    if (enrichedCount >= 3) { // Stop after 3 for the report
        console.log(`\n\n================ REPORT ================`);
        console.log(JSON.stringify(enrichedData.slice(0, 3), null, 2));
        process.exit(0);
    }
});

setTimeout(() => {
    console.log('Timeout waiting for enrichment events.');
    process.exit(1);
}, 20000);
