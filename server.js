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
    methods: ['GET', 'POST']
  }
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

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Send current status immediately
  socket.emit('wa:status', { 
    status: whatsappService.status, 
    qr: whatsappService.qrCode,
    error: whatsappService.errorDetails
  });

  socket.on('wa:start', () => {
    whatsappService.initialize();
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

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  // We can auto-initialize or wait for frontend command
  // whatsappService.initialize();
});
