const io = require('socket.io-client');
const socket = io('https://arthurvault-backend-production.up.railway.app');

socket.on('connect', () => {
  console.log('Connected!');
  
  socket.on('wa:status', (data) => {
      console.log('Status update:', data.status);
      if (data.status === 'READY') {
          console.log('Getting groups...');
          socket.emit('wa:get_groups', async (res) => {
              if (res.success && res.groups.length > 0) {
                  const groupId = res.groups[0].id;
                  console.log('Got groups:', res.groups.length);
                  console.log('First group ID:', groupId);
                  try {
                      const response = await fetch(`https://arthurvault-backend-production.up.railway.app/api/test-group/${encodeURIComponent(groupId)}`);
                      const text = await response.text();
                      console.log('TEST-GROUP RESULT:');
                      console.log(text);
                  } catch(e) {
                      console.error('Fetch error:', e);
                  }
              } else {
                  console.log('No groups or error:', res);
              }
              process.exit(0);
          });
      }
  });

  socket.emit('wa:initialize', (res) => {
      console.log('Initialize response:', res);
  });
});

setTimeout(() => {
    console.log('Timeout (60s)');
    process.exit(1);
}, 60000);
