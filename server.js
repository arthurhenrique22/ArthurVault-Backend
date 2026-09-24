const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const qrcode = require('qrcode');
const whatsappService = require('./whatsappService');

const app = express();
const server = http.createServer(app);

// Setup CORS
app.use(cors({
  origin: '*', // For dev. In production, use FRONTEND_URL
  methods: ['GET', 'POST']
}));

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['polling', 'websocket']
});

whatsappService.setIo(io);

// Build identifier
const BUILD_ID = "build-docker-fix-v2";

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    ok: true, 
    service: "arthurvault-backend",
    build: BUILD_ID,
    runtime: {
      platform: process.platform,
      node: process.version,
      puppeteer_executable: process.env.PUPPETEER_EXECUTABLE_PATH || 'NOT_SET'
    },
    whatsapp: {
      status: whatsappService.status
    }
  });
});

app.get('/diag', async (req, res) => {
  try {
    const diag = await whatsappService.runDiagnostic();
    res.json({ success: true, diagnostic: diag });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, stack: e.stack });
  }
});

app.get('/diag-deep', async (req, res) => {
  try {
    const client = whatsappService.client;
    if (!client) throw new Error('No client');
    
    const chats = await client.getChats();
    const groups = chats.filter(c => c.isGroup);
    
    let results = [];
    for (let i = 0; i < Math.min(3, groups.length); i++) {
        const chat = groups[i];
        let chatDiag = {
            id: chat.id._serialized,
            name: chat.name,
            isGroup: chat.isGroup,
            isArray: Array.isArray(chat.participants),
            length: chat.participants?.length,
            picMethod: typeof chat.getProfilePicUrl
        };
        
        let byIdDiag = {};
        try {
            const groupById = await client.getChatById(chat.id._serialized);
            byIdDiag = {
                constructor: groupById.constructor?.name,
                isGroup: groupById.isGroup,
                isArray: Array.isArray(groupById.participants),
                length: groupById.participants?.length
            };
        } catch(e) { byIdDiag = { error: e.message }; }
        
        let picDiag = {};
        try {
            const pic = await client.getProfilePicUrl(chat.id._serialized);
            picDiag = { url: typeof pic === 'string' ? pic.substring(0, 30) : pic };
        } catch(e) { picDiag = { error: e.message, name: e.name }; }
        
        results.push({ chatDiag, byIdDiag, picDiag });
    }
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, stack: e.stack });
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send current status immediately
  socket.emit('wa:status', { 
    status: whatsappService.status, 
    qr: whatsappService.qrCode,
    error: whatsappService.errorDetails
  });

  socket.on('wa:start', () => {
    // Keep for legacy just in case
    whatsappService.initialize();
  });

  socket.on('wa:initialize', async (callback) => {
    try {
      console.log(`[QR_FLOW] generate requested (Socket client: ${socket.id})`);
      console.log(`[QR_FLOW] Current state: ${whatsappService.status}`);

      if (whatsappService.status === 'READY') {
        if (callback) callback({ success: true, status: 'ready' });
        return;
      }

      if (whatsappService.initializationPromise) {
        console.log('[QR_FLOW] Reusing initialization');
        await whatsappService.initializationPromise;
        if (whatsappService.status === 'ERROR') {
          if (callback) callback({ success: false, error: whatsappService.errorDetails });
        } else {
          if (callback) callback({ success: true, status: whatsappService.status });
        }
        return;
      }

      console.log('[QR_FLOW] initialization started');
      await whatsappService.initialize();
      
      if (whatsappService.status === 'ERROR') {
         if (callback) callback({ success: false, error: whatsappService.errorDetails });
      } else {
         if (callback) callback({ success: true, status: whatsappService.status });
      }
    } catch (err) {
       console.error('[QR_FLOW] Error during initialize:', err);
       if (callback) callback({ success: false, error: err.message });
    }
  });

  socket.on('wa:logout', async () => {
    await whatsappService.logout();
  });

  socket.on('wa:get_contacts', async (callback) => {
    try {
      const contacts = await whatsappService.getContacts();
      callback({ success: true, contacts });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('wa:get_groups', async (callback) => {
    try {
      const groups = await whatsappService.getGroups();
      callback({ success: true, groups });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('wa:get_group_participants', async (groupId, callback) => {
    try {
      const participants = await whatsappService.getGroupParticipants(groupId);
      callback({ success: true, participants });
    } catch (err) {
      callback({ success: false, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});
app.get('/api/group-photo/:groupId', async (req, res) => {
  try {
    const groupId = decodeURIComponent(req.params.groupId);
    // Uses the proxy logic to fetch the image bytes
    const cached = whatsappService.groupCache.get(groupId);
    let url = cached ? cached.originalPhotoUrl : null;
    if (!url) {
        url = await whatsappService.client?.getProfilePicUrl(groupId);
    }
    if (!url) {
      return res.status(404).send('No photo found');
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch image');
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=600'); // 10 minute cache
    res.send(buffer);
  } catch (error) {
    console.error(`[PHOTO_PROXY_ERROR] ${error.message}`);
    res.status(500).send('Error proxying photo');
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
  // We can auto-initialize or wait for frontend command
  // whatsappService.initialize();
});
