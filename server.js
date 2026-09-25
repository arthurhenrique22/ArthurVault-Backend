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
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    return callback(null, true);
  },
  methods: ['GET', 'POST'],
  credentials: true
}));

const io = new Server(server, {
  cors: {
    origin: function(origin, callback) {
      if (!origin) return callback(null, true);
      return callback(null, true);
    },
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['polling', 'websocket'],
  allowEIO3: true
});

whatsappService.setIo(io);

// Build identifier
const BUILD_ID = "build-docker-fix-v2";

app.get('/api/test-group/:groupId', async (req, res) => {
  try {
    const groupId = decodeURIComponent(req.params.groupId);
    const client = whatsappService.client;
    if (!client || !client.pupPage) throw new Error('No client or pupPage');
    
    const diag = await client.pupPage.evaluate(async (gId) => {
       const result = { id: gId, photoInspection: {} };
       
       try {
           // 1. WWebJS Chat & Contact
           if (window.WWebJS) {
               result.photoInspection.wwebjsChat = !!window.WWebJS.getChatModel;
               if (window.WWebJS.getChatModel) {
                   const chat = window.WWebJS.getChatModel(gId);
                   result.photoInspection.chatExists = !!chat;
                   result.photoInspection.chatGetProfilePicUrlType = chat ? typeof chat.getProfilePicUrl : 'N/A';
               }
               const contact = window.WWebJS.getContactModel ? window.WWebJS.getContactModel(gId) : null;
               result.photoInspection.contactExists = !!contact;
               result.photoInspection.contactGetProfilePicUrlType = contact ? typeof contact.getProfilePicUrl : 'N/A';
           }

           // 2. WAWebCollections
           let WAWebCollections = window.WAWebCollections;
           if (!WAWebCollections && window.require) {
               try { WAWebCollections = window.require('WAWebCollections'); } catch(e) {}
           }
           let Store = window.Store;
           if (!Store && window.require) {
               try { Store = window.require('Store'); } catch(e) {}
           }
           
           const collections = WAWebCollections || Store || {};
           
           // ProfilePicThumb
           if (collections.ProfilePicThumb) {
               result.photoInspection.ProfilePicThumbCollection = true;
               const thumb = collections.ProfilePicThumb.get(gId);
               result.photoInspection.thumbExists = !!thumb;
               if (thumb) {
                   result.photoInspection.thumbEurl = thumb.eurl || null;
                   result.photoInspection.thumbImg = thumb.img || null;
                   result.photoInspection.thumbId = thumb.id ? thumb.id._serialized : null;
               }
           } else {
               result.photoInspection.ProfilePicThumbCollection = false;
           }

           // ProfilePic
           if (collections.ProfilePic) {
               result.photoInspection.ProfilePicCollection = true;
               result.photoInspection.ProfilePicRequestFunction = typeof collections.ProfilePic.requestProfilePicFromServer;
           }

           // Contact
           if (collections.Contact) {
               result.photoInspection.ContactCollection = true;
               const contactObj = collections.Contact.get(gId);
               result.photoInspection.contactObjExists = !!contactObj;
               if (contactObj) {
                   result.photoInspection.contactObjProfilePic = contactObj.profilePicThumbObj ? true : false;
                   if (contactObj.profilePicThumbObj) {
                       result.photoInspection.contactObjProfilePicEurl = contactObj.profilePicThumbObj.eurl;
                   }
               }
           }
       } catch (e) {
           result.photoInspection.error = e.message;
       }
       return result;
    }, groupId);
    
    res.json({ success: true, diag });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, stack: e.stack });
  }
});

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

  socket.on('wa:retry_failed_photos', (callback) => {
    try {
      const count = whatsappService.retryFailedPhotos();
      if (callback) callback({ success: true, count });
    } catch (err) {
      if (callback) callback({ success: false, error: err.message });
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
app.get('/api/groups', (req, res) => {
  try {
    const cachedGroups = Array.from(whatsappService.groupCache.values());
    res.json({ success: true, groups: cachedGroups });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/group-photo/:groupId', async (req, res) => {
  try {
    const groupId = decodeURIComponent(req.params.groupId);
    const cached = whatsappService.groupCache.get(groupId);
    let url = cached ? cached.originalPhotoUrl : null;
    if (!url && whatsappService.status === 'READY') {
        url = await whatsappService.resolvePhotoOnDemand(groupId);
    }
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return res.status(404).send('No photo found or invalid URL');
    }

    if (!whatsappService.client || !whatsappService.client.pupPage) {
        throw new Error('Puppeteer page not available for authenticated fetch');
    }

    // Fetch the image inside the authenticated Puppeteer context
    const base64Data = await whatsappService.client.pupPage.evaluate(async (imgUrl) => {
        try {
            const res = await fetch(imgUrl);
            if (!res.ok) return null;
            const blob = await res.blob();
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve({ dataUrl: reader.result, type: blob.type });
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch(e) {
            return null;
        }
    }, url);

    if (!base64Data || !base64Data.dataUrl) {
        throw new Error('Failed to fetch image data through Puppeteer');
    }

    // Extract base64 and decode
    const matches = base64Data.dataUrl.match(/^data:(.+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
        throw new Error('Invalid base64 format');
    }

    const contentType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=600'); // 10 minute cache
    res.send(buffer);
  } catch (error) {
    console.error(`[PHOTO_PROXY_ERROR] ${error.message}`);
    res.status(500).send('Error proxying photo');
  }
});

app.get('/api/test-diagnostic', async (req, res) => {
    try {
        if (!whatsappService.client || !whatsappService.client.pupPage) {
            return res.json({ error: 'WhatsApp client not ready or no pupPage' });
        }
        
        const targetGroupId = '120363410917701029@g.us'; // Tropa do 5M
        
        const diag = await whatsappService.client.pupPage.evaluate(async (gId) => {
            const result = {
                targetGroupId: gId,
                storeKeys: Object.keys(window.Store || {}),
                waWebCollectionsKeys: Object.keys(window.WAWebCollections || {}),
                wwebjsKeys: Object.keys(window.WWebJS || {}),
                chatModel: null,
                groupMetadataModel: null,
            };
            
            try {
                let Store = window.Store;
                if (!Store && window.require) {
                    try { Store = window.require('Store'); } catch(e){}
                }
                let WAW = window.WAWebCollections;
                
                const collections = Store || WAW || {};
                
                if (collections.Chat) {
                    const chat = collections.Chat.get(gId);
                    if (chat) {
                        result.chatModel = {
                            constructorName: chat.constructor ? chat.constructor.name : 'Unknown',
                            keys: Object.keys(chat),
                            participantsType: typeof chat.participants,
                            participantsKeys: chat.participants ? Object.keys(chat.participants) : null,
                            participantsIsArray: Array.isArray(chat.participants),
                            participantsModelsIsArray: chat.participants ? Array.isArray(chat.participants.models) : false,
                            participantsLength: chat.participants ? chat.participants.length : null,
                            participantsModelsLength: (chat.participants && chat.participants.models) ? chat.participants.models.length : null
                        };
                    }
                }
                
                if (collections.GroupMetadata) {
                    const meta = collections.GroupMetadata.get(gId);
                    if (meta) {
                        result.groupMetadataModel = {
                            constructorName: meta.constructor ? meta.constructor.name : 'Unknown',
                            keys: Object.keys(meta),
                            participantsType: typeof meta.participants,
                            participantsKeys: meta.participants ? Object.keys(meta.participants) : null,
                            participantsIsArray: Array.isArray(meta.participants),
                            participantsModelsIsArray: meta.participants ? Array.isArray(meta.participants.models) : false,
                            participantsLength: meta.participants ? meta.participants.length : null,
                            participantsModelsLength: (meta.participants && meta.participants.models) ? meta.participants.models.length : null
                        };
                    }
                }
            } catch(e) {
                result.error = e.message;
            }
            
            return result;
        }, targetGroupId);
        
        let clientApiChat = null;
        try {
            const chatObj = await whatsappService.client.getChatById(targetGroupId);
            clientApiChat = {
                exists: !!chatObj,
                participantsIsArray: chatObj ? Array.isArray(chatObj.participants) : false,
                participantsLength: chatObj && chatObj.participants ? chatObj.participants.length : null
            };
        } catch(e) {
            clientApiChat = { error: e.message };
        }
        
        let clientApiPhoto = null;
        try {
            const url = await whatsappService.client.getProfilePicUrl(targetGroupId);
            clientApiPhoto = {
                url: url
            };
        } catch(e) {
            clientApiPhoto = { error: e.message };
        }
        
        return res.json({ diag, clientApiChat, clientApiPhoto });
    } catch(err) {
        return res.json({ error: err.message, stack: err.stack });
    }
});

app.get('/api/start', async (req, res) => {
    try {
        whatsappService.initialize();
        res.json({ success: true, message: 'Initialization started' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
  // We can auto-initialize or wait for frontend command
  // whatsappService.initialize();
});
