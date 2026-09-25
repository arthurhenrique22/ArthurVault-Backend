const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const puppeteer = require('puppeteer-core'); // Requires puppeteer-core or puppeteer depending on the setup

class WhatsAppService {
  constructor() {
    this.client = null;
    this.status = 'IDLE'; // IDLE, INITIALIZING, WAITING_QR, AUTHENTICATING, READY, ERROR, DISCONNECTED
    this.qrCode = null;
    this.io = null;
    this.errorDetails = null;
    this.groupsPromise = null;
    this.initializationPromise = null;
    this.generation = 0;
    this.groupCache = new Map();
  }

  setIo(io) {
    this.io = io;
  }

  emitStatus() {
    if (this.io) {
      this.io.emit('wa:status', { 
        status: this.status, 
        qr: this.qrCode,
        error: this.errorDetails
      });
    }
  }

  async destroyClient() {
    if (this.client) {
      console.log('[WA] Destroying old client instance...');
      try {
        await this.client.destroy();
      } catch (err) {
        console.error('[WA] Error destroying client:', err.message);
      }
      this.client = null;
    }
  }

  async initialize() {
    if (this.initializationPromise) {
      console.log('[WA_INIT] reusing active initialization');
      return this.initializationPromise;
    }

    if (this.status === 'WAITING_QR' || this.status === 'AUTHENTICATING' || this.status === 'READY') {
      console.log('[WA] Initialization skipped. Current status is already:', this.status);
      this.emitStatus();
      return;
    }

    this.initializationPromise = this._actuallyInitialize();
    
    try {
      await this.initializationPromise;
    } finally {
      // Clear the lock only if it hasn't been overwritten (which shouldn't happen here)
      if (this.initializationPromise) {
         this.initializationPromise = null;
      }
    }
  }

  async _actuallyInitialize() {
    this.generation++;
    console.log(`[WA_INIT] generation: ${this.generation}`);
    console.log('[WA] Starting initialization process...');
    this.status = 'INITIALIZING';
    this.errorDetails = null;
    this.qrCode = null;
    this.emitStatus();

    await this.destroyClient();

    console.log('[WA] Creating new Client instance...');
    
    // Configurações de Puppeteer. No Windows, usaremos um fallback de executablePath caso a instalação automática do Puppeteer falhe
    const puppeteerOptions = {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    };

    // Obter executável do ambiente (definido pela imagem Docker do Puppeteer)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      console.log(`[WA] Using Docker environment browser executable: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
      puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    } else if (process.platform === 'win32') {
      console.log('[WA] Windows detected and no explicit path set. Puppeteer will try to use downloaded Chrome cache.');
    } else if (process.platform === 'linux') {
      console.log('[WA] Linux detected without PUPPETEER_EXECUTABLE_PATH. Make sure chromium is installed if this fails.');
      // Fallback para Railway Nixpacks se Chromium for instalado pelo apt
      puppeteerOptions.executablePath = '/usr/bin/chromium';
    }

    console.log('[WA] Checking browser executable...');
    const knownPaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/chromium',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    ];

    let actualBrowserPath = null;
    for (const p of knownPaths) {
      if (p && fs.existsSync(p)) {
        actualBrowserPath = p;
        break;
      }
    }

    if (!actualBrowserPath) {
      console.log('[WA] Browser exists: false');
      console.error('[WA] Cannot start WhatsApp Client. Browser executable not found!');
      this.status = 'ERROR';
      this.errorDetails = { code: 'INIT_FAILED', message: 'Não foi possível iniciar o serviço de conexão.' };
      this.emitStatus();
      return;
    }

    console.log(`[WA] Executable Path: ${actualBrowserPath}`);
    console.log('[WA] Browser exists: true');
    puppeteerOptions.executablePath = actualBrowserPath;

    // Testar o browser real
    try {
      console.log('[WA] Browser launch test starting');
      const testBrowser = await puppeteer.launch({
        headless: true,
        executablePath: actualBrowserPath,
        args: puppeteerOptions.args
      });
      const version = await testBrowser.version();
      console.log(`[WA] Browser version: ${version}`);
      const page = await testBrowser.newPage();
      await page.close();
      await testBrowser.close();
      console.log('[WA] Browser launch test: PASS');
    } catch (launchError) {
      console.error('[WA] Browser launch test: FAIL');
      console.error(launchError);
      this.status = 'ERROR';
      this.errorDetails = { code: 'INIT_FAILED', message: 'Não foi possível iniciar o serviço de conexão.' };
      this.emitStatus();
      return;
    }

    console.log('[WA] Creating new Client instance...');
    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: puppeteerOptions,
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
      }
    });

    console.log('[WA] Registering event listeners...');

    this.client.on('change_state', state => {
      console.log('[QR_FLOW] change_state:', state);
    });

    this.client.on('qr', (qr) => {
      console.log('[QR_FLOW] qr received');
      this.status = 'WAITING_QR';
      this.qrCode = qr;
      this.emitStatus();
      if (this.io) {
         this.io.emit('wa:qr', { qr, timestamp: Date.now() });
      }
    });

    this.client.on('authenticated', () => {
      console.log('[QR_FLOW] authenticated');
      this.status = 'AUTHENTICATING';
      this.qrCode = null;
      this.emitStatus();
    });

    this.client.on('auth_failure', msg => {
      console.error('[QR_FLOW] Auth failure:', msg);
      this.status = 'ERROR';
      this.errorDetails = { code: 'AUTH_FAILURE', message: 'Falha na autenticação da sessão.' };
      this.emitStatus();
    });

    this.client.on('ready', () => {
      console.log('[QR_FLOW] ready');
      this.status = 'READY';
      this.qrCode = null;
      this.emitStatus();
    });

    this.client.on('disconnected', (reason) => {
      console.log('[WA] Disconnected. Reason:', reason);
      this.status = 'DISCONNECTED';
      this.qrCode = null;
      this.destroyClient();
      this.emitStatus();
    });

    console.log('[WA] Calling client.initialize()...');
    
    try {
      await this.client.initialize();
      console.log('[WA] client.initialize() promise resolved (Browser started).');
      if (this.client.pupPage) {
          this.client.pupPage.on('console', msg => console.log('[PUP_CONSOLE]', msg.type(), msg.text()));
          this.client.pupPage.on('pageerror', err => console.error('[PUP_PAGE_ERROR]', err.message));
          this.client.pupPage.on('error', err => console.error('[PUP_ERROR]', err.message));
      }
    } catch (error) {
      console.error("[WA_INIT] FAILED");
      if (error instanceof Error) {
          console.error(`[WA_INIT] Error name: ${error.name}`);
          console.error(`[WA_INIT] Error message: ${error.message}`);
          console.error(`[WA_INIT] Error stack: ${error.stack}`);
      } else {
          console.error(`[WA_INIT] Error message: ${error}`);
      }
      this.status = 'ERROR';
      this.errorDetails = { code: 'INIT_FAILED', message: 'Não foi possível iniciar o serviço de conexão.' };
      this.emitStatus();
      await this.destroyClient(); // Only destroy this specific instance that failed
    }
  }

  async logout() {
    if (this.client) {
      try {
        console.log('[WA] Logging out...');
        await this.client.logout();
      } catch (err) {
        console.error('[WA] Error during logout:', err);
      }
      this.status = 'DISCONNECTED';
      await this.destroyClient();
      this.emitStatus();
    }
  }

  async getContacts() {
    if (this.status !== 'READY' || !this.client) {
      throw new Error('WhatsApp is not ready');
    }
    return await this.client.getContacts();
  }



  async getGroups() {
    console.log('[GROUPS] Request received');
    console.log('[GROUPS] Client exists:', !!this.client);
    console.log('[GROUPS] WhatsApp state:', this.status);
    
    if (this.status !== 'READY' || !this.client) {
      throw new Error('WhatsApp is not ready');
    }

    if (this.groupsPromise) {
      console.log('[GROUPS] Reusing in-flight groups request');
      return this.groupsPromise;
    }

    this.groupsPromise = this._actuallyLoadGroups();
    
    try {
      const groups = await this.groupsPromise;
      // Start background enrichment
      this._startEnrichment(groups).catch(e => console.error('[GROUPS_DETAILS] Photo Enrichment error:', e));
      this._startParticipantEnrichment(groups).catch(e => console.error('[GROUPS_DETAILS] Participant Enrichment error:', e));
      return groups;
    } finally {
      this.groupsPromise = null;
    }
  }

  // ==========================================
  // ID NORMALIZATION
  // ==========================================
  normalizeGroupId(value) {
     if (!value) return null;
     if (typeof value === 'string') {
        if (value.endsWith('@g.us')) return value;
        if (value.includes('-')) return value + '@g.us';
        return value;
     }
     if (typeof value === 'object') {
        if (typeof value._serialized === 'string') return value._serialized;
        if (typeof value.user === 'string' && typeof value.server === 'string') {
           return `${value.user}@${value.server}`;
        }
     }
     return String(value);
  }

  async resolveParticipantsCount(rawGroupId) {
    const groupId = this.normalizeGroupId(rawGroupId);
    
    let count = null;
    let source = 'none';
    let error = null;

    try {
        const fallback = await this.client.pupPage.evaluate(async (gId) => {
            try {
                let chatModel = null;
                if (window.Store?.Chat) chatModel = window.Store.Chat.get(gId);
                if (!chatModel && window.WAWebCollections?.Chat) chatModel = window.WAWebCollections.Chat.get(gId);
                
                if (chatModel && Array.isArray(chatModel.participants) && chatModel.participants.length > 0) {
                    return { count: chatModel.participants.length, source: 'Chat.participants.array' };
                }
                
                let metadata = null;
                if (window.Store?.GroupMetadata) metadata = window.Store.GroupMetadata.get(gId);
                if (!metadata && window.WAWebCollections?.GroupMetadata) metadata = window.WAWebCollections.GroupMetadata.get(gId);
                
                if (metadata && Array.isArray(metadata.participants) && metadata.participants.length > 0) {
                    return { count: metadata.participants.length, source: 'GroupMetadata.participants.array' };
                }

                // If exists but no participants, try to hydrate
                const col = window.WAWebCollections?.GroupMetadata || window.Store?.GroupMetadata;
                if (col && typeof col.update === 'function') {
                    try {
                        await col.update(gId);
                        let updated = col.get(gId);
                        if (updated && Array.isArray(updated.participants) && updated.participants.length > 0) {
                            return { count: updated.participants.length, source: 'GroupMetadata.update.array' };
                        }
                    } catch(e) {}
                }

                if (window.WWebJS?.getChatModel) {
                    try {
                        const wwebChat = window.WWebJS.getChatModel(gId);
                        if (wwebChat && Array.isArray(wwebChat.participants) && wwebChat.participants.length > 0) {
                            return { count: wwebChat.participants.length, source: 'WWebJS.participants' };
                        }
                    } catch(e) {}
                }

                return { count: null, source: 'none' };
            } catch (err) {
                return { count: null, source: 'evaluate.error', error: err.message };
            }
        }, groupId);

        if (fallback && Number.isInteger(fallback.count) && fallback.count >= 0) {
            count = fallback.count;
            source = fallback.source;
        } else if (fallback && fallback.error) {
            error = fallback.error;
        }
    } catch(err) {
        error = err.message;
        source = 'pupPage.error';
    }

    return {
        count: Number.isInteger(count) && count >= 0 ? count : null,
        status: Number.isInteger(count) && count >= 0 ? 'success' : 'failed',
        source,
        error
    };
  }

  async resolveGroupPhoto(rawGroupId) {
    const groupId = this.normalizeGroupId(rawGroupId);
    
    let photoUrl = null;
    let source = 'none';

    try {
        const url = await this.client.getProfilePicUrl(groupId);
        if (typeof url === 'string' && url.length > 0) {
            return { url, source: 'getProfilePicUrl', status: 'success' };
        }
    } catch(err) {}

    try {
        const fallbackPic = await this.client.pupPage.evaluate(async (gId) => {
            try {
                // Try WWebJS Contact fallback
                try {
                    const chat = window.WWebJS?.getChatModel?.(gId);
                    if (chat && typeof chat.getProfilePicUrl === 'function') {
                        const pic = await chat.getProfilePicUrl();
                        if (pic) return { url: pic, source: 'WWebJS.Chat.getProfilePicUrl' };
                    }
                    const contact = window.WWebJS?.getContactModel?.(gId);
                    if (contact && typeof contact.getProfilePicUrl === 'function') {
                        const pic = await contact.getProfilePicUrl();
                        if (pic) return { url: pic, source: 'WWebJS.Contact.getProfilePicUrl' };
                    }
                } catch(e) {}

                // Try WAWebCollections ProfilePicThumb
                try {
                    let col = window.WAWebCollections?.ProfilePicThumb || window.Store?.ProfilePicThumb;
                    if (col) {
                        let pic = col.get(gId);
                        if (!pic && typeof col.find === 'function') {
                            pic = await col.find(gId);
                        }
                        if (pic && pic.eurl) return { url: pic.eurl, source: 'WAWebCollections.ProfilePicThumb.eurl' };
                        if (pic && pic.img) return { url: pic.img, source: 'WAWebCollections.ProfilePicThumb.img' };
                    }
                } catch(e) {}

                // Try WAWebCollections Contact
                try {
                    let col = window.WAWebCollections?.Contact || window.Store?.Contact;
                    if (col) {
                        const contact = col.get(gId);
                        if (contact && typeof contact.getProfilePicUrl === 'function') {
                            const pic = await contact.getProfilePicUrl();
                            if (pic) return { url: pic, source: 'WAWebCollections.Contact.getProfilePicUrl' };
                        }
                    }
                } catch(e) {}

                // Try ProfilePic
                try {
                    let col = window.WAWebCollections?.ProfilePic || window.Store?.ProfilePic;
                    if (col) {
                        if (typeof col.requestProfilePicFromServer === 'function') {
                            const pic = await col.requestProfilePicFromServer(gId);
                            if (pic && pic.eurl) return { url: pic.eurl, source: 'WAWebCollections.ProfilePic.request' };
                        }
                    }
                } catch(e) {}

                return { url: null, source: 'evaluate.no_photo' };
            } catch(e) {
                return { url: null, source: 'evaluate.error' };
            }
        }, groupId);

        if (fallbackPic && typeof fallbackPic.url === 'string' && fallbackPic.url.length > 0) {
            return { url: fallbackPic.url, source: fallbackPic.source, status: 'success' };
        } else if (fallbackPic && fallbackPic.source === 'evaluate.no_photo') {
            return { url: null, source: fallbackPic.source, status: 'no_photo' };
        }
    } catch(err) {}

    return { url: null, source: 'failed', status: 'failed' };
  }


  // ==========================================
  // METADATA RESOLVER
  // ==========================================
  async resolveGroupMetadata(rawGroupId, isDiag, fetchPhoto = true) {
    const groupId = this.normalizeGroupId(rawGroupId);
    
    let participantsCount = null;
    let photoUrl = null;
    let participantsSource = 'none';
    let photoSource = 'none';
    let errorDetails = null;
    let isCommunity = false;

    // 1. PARTICIPANTS

    // A) Try the already fetched chats
    let chatObj = this.loadedChatsCache ? this.loadedChatsCache.get(groupId) : null;
    
    if (chatObj) {
        if (Array.isArray(chatObj.participants)) {
            participantsCount = chatObj.participants.length;
            participantsSource = 'getChats.GroupChat.participants';
            isCommunity = chatObj.isCommunity || false;
        } else if (chatObj.groupMetadata && Array.isArray(chatObj.groupMetadata.participants)) {
            participantsCount = chatObj.groupMetadata.participants.length;
            participantsSource = 'getChats.GroupChat.groupMetadata';
            isCommunity = chatObj.isCommunity || false;
        } else if (typeof chatObj.participants?.length === 'number') {
            participantsCount = chatObj.participants.length;
            participantsSource = 'getChats.GroupChat.participants.length';
            isCommunity = chatObj.isCommunity || false;
        } else if (chatObj.participants && typeof chatObj.participants._models?.length === 'number') {
            participantsCount = chatObj.participants._models.length;
            participantsSource = 'getChats.GroupChat.participants._models';
            isCommunity = chatObj.isCommunity || false;
        } else if (chatObj.participants && typeof chatObj.participants.size === 'number') {
            participantsCount = chatObj.participants.size;
            participantsSource = 'getChats.GroupChat.participants.size';
            isCommunity = chatObj.isCommunity || false;
        }
    }

    // B) Try getChatById if not found (REMOVED due to WWebJS crash)
    // C) Try pupPage.evaluate (deep dive)
    if (!Number.isInteger(participantsCount) || participantsCount < 0) {
        try {
            const fallback = await this.client.pupPage.evaluate(async (gId) => {
                let count = null;
                let source = 'none';
                let isComm = false;

                const tryExtractSize = (obj) => {
                    if (!obj) return null;
                    if (Array.isArray(obj)) return obj.length;
                    if (Array.isArray(obj._models)) return obj._models.length;
                    if (Array.isArray(obj.models)) return obj.models.length;
                    if (typeof obj.length === 'number') return obj.length;
                    if (typeof obj.size === 'number') return obj.size;
                    if (typeof obj.getModelsArray === 'function') {
                        const arr = obj.getModelsArray();
                        if (Array.isArray(arr)) return arr.length;
                    }
                    return null;
                };

                const tryGetFromChat = (chatObj, namespace) => {
                    if (!chatObj) return false;
                    isComm = !!chatObj.isCommunity;
                    let c = tryExtractSize(chatObj.participants);
                    if (c !== null && c > 0) { count = c; source = namespace + '.participants'; return true; }
                    
                    if (chatObj.groupMetadata) {
                        c = tryExtractSize(chatObj.groupMetadata.participants);
                        if (c !== null && c > 0) { count = c; source = namespace + '.groupMetadata'; return true; }
                    }
                    return false;
                };

                const tryGetFromGm = (gmObj, namespace) => {
                    if (!gmObj) return false;
                    isComm = !!gmObj.isCommunity;
                    let c = tryExtractSize(gmObj.participants);
                    if (c !== null && c > 0) { count = c; source = namespace + '.participants'; return true; }
                    return false;
                };

                // 1. window.require('WAWebCollections')
                try {
                    if (window.require) {
                        let WAWebCollections;
                        try { WAWebCollections = window.require('WAWebCollections'); } catch(e) {}
                        if (WAWebCollections) {
                            if (WAWebCollections.GroupMetadata) {
                                if (tryGetFromGm(WAWebCollections.GroupMetadata.get(gId), 'require.WAWebCollections.GroupMetadata')) return { count, isComm, source };
                            }
                            if (WAWebCollections.Chat) {
                                if (tryGetFromChat(WAWebCollections.Chat.get(gId), 'require.WAWebCollections.Chat')) return { count, isComm, source };
                            }
                        }
                    }
                } catch(e) {}

                // 2. window.WAWebCollections
                try {
                    if (window.WAWebCollections) {
                        if (window.WAWebCollections.GroupMetadata) {
                            if (tryGetFromGm(window.WAWebCollections.GroupMetadata.get(gId), 'window.WAWebCollections.GroupMetadata')) return { count, isComm, source };
                        }
                        if (window.WAWebCollections.Chat) {
                            if (tryGetFromChat(window.WAWebCollections.Chat.get(gId), 'window.WAWebCollections.Chat')) return { count, isComm, source };
                        }
                    }
                } catch(e) {}

                // 3. window.require('Store')
                try {
                    if (window.require) {
                        let Store;
                        try { Store = window.require('Store'); } catch(e) {}
                        if (Store) {
                            if (Store.GroupMetadata) {
                                if (tryGetFromGm(Store.GroupMetadata.get(gId), 'require.Store.GroupMetadata')) return { count, isComm, source };
                            }
                            if (Store.Chat) {
                                if (tryGetFromChat(Store.Chat.get(gId), 'require.Store.Chat')) return { count, isComm, source };
                            }
                        }
                    }
                } catch(e) {}

                // 4. window.Store
                try {
                    if (window.Store) {
                        if (window.Store.GroupMetadata) {
                            if (tryGetFromGm(window.Store.GroupMetadata.get(gId), 'window.Store.GroupMetadata')) return { count, isComm, source };
                        }
                        if (window.Store.Chat) {
                            if (tryGetFromChat(window.Store.Chat.get(gId), 'window.Store.Chat')) return { count, isComm, source };
                        }
                    }
                } catch(e) {}

                return { count: null, isComm: false, source: 'evaluate.failed' };
            }, groupId);

            if (fallback && typeof fallback.count === 'number') {
                participantsCount = fallback.count;
                participantsSource = fallback.source;
                isCommunity = fallback.isComm;
            } else if (isDiag) {
                errorDetails = 'All fallback strategies failed to find a valid participants array length.';
            }

            if (groupId === '120363359964959175@g.us') {
                console.log('\n[PARTICIPANTS_RUNTIME]');
                console.log(`groupId=${groupId}`);
                console.log(`metadataExists=${!!fallback}`);
                console.log(`participantsExists=${fallback && fallback.count !== null}`);
                console.log(`participantsType=${fallback ? fallback.source : 'none'}`);
                console.log(`count=${participantsCount}`);
                console.log(`source=${participantsSource}`);
            }
        } catch(err) {
            if (isDiag) {
                console.log(`[PARTICIPANTS_FALLBACK_ERROR] strategy=evaluate name=${err.name} message=${err.message}`);
            }
        }
    }

    // 2. PHOTO

    if (fetchPhoto) {
        try {
            const url = await this.client.getProfilePicUrl(groupId);
        if (typeof url === 'string') {
            photoUrl = url;
            photoSource = 'getProfilePicUrl';
        }
    } catch(err) {
        if (isDiag) {
            console.log(`[PHOTO_NATIVE_ERROR] strategy=getProfilePicUrl name=${err.name} message=${err.message}`);
        }
        
        try {
            const fallbackPic = await this.client.pupPage.evaluate(async (gId) => {
                let url = null;
                let source = 'none';

                // Try WWebJS Contact fallback
                try {
                    const chat = window.WWebJS?.getChatModel?.(gId);
                    if (chat && typeof chat.getProfilePicUrl === 'function') {
                        const pic = await chat.getProfilePicUrl();
                        if (pic) return { url: pic, source: 'WWebJS.Chat.getProfilePicUrl' };
                    }
                    const contact = window.WWebJS?.getContactModel?.(gId);
                    if (contact && typeof contact.getProfilePicUrl === 'function') {
                        const pic = await contact.getProfilePicUrl();
                        if (pic) return { url: pic, source: 'WWebJS.Contact.getProfilePicUrl' };
                    }
                } catch(e) {}

                // Try WAWebCollections ProfilePicThumb
                try {
                    let col = window.WAWebCollections?.ProfilePicThumb || window.Store?.ProfilePicThumb;
                    if (!col && window.require) {
                        try { col = window.require('WAWebCollections')?.ProfilePicThumb; } catch(e) {}
                    }
                    if (col) {
                        let pic = col.get(gId);
                        if (!pic && typeof col.find === 'function') {
                            pic = await col.find(gId);
                        }
                        if (pic && pic.eurl) return { url: pic.eurl, source: 'WAWebCollections.ProfilePicThumb.eurl' };
                        if (pic && pic.img) return { url: pic.img, source: 'WAWebCollections.ProfilePicThumb.img' };
                    }
                } catch(e) {}

                // Try WAWebCollections Contact
                try {
                    let col = window.WAWebCollections?.Contact || window.Store?.Contact;
                    if (!col && window.require) {
                        try { col = window.require('WAWebCollections')?.Contact; } catch(e) {}
                    }
                    if (col) {
                        const contact = col.get(gId);
                        if (contact && typeof contact.getProfilePicUrl === 'function') {
                            const pic = await contact.getProfilePicUrl();
                            if (pic) return { url: pic, source: 'WAWebCollections.Contact.getProfilePicUrl' };
                        }
                    }
                } catch(e) {}

                // Try ProfilePic
                try {
                    let col = window.WAWebCollections?.ProfilePic || window.Store?.ProfilePic;
                    if (!col && window.require) {
                        try { col = window.require('WAWebCollections')?.ProfilePic; } catch(e) {}
                    }
                    if (col) {
                        if (typeof col.requestProfilePicFromServer === 'function') {
                            const pic = await col.requestProfilePicFromServer(gId);
                            if (pic && pic.eurl) return { url: pic.eurl, source: 'WAWebCollections.ProfilePic.request' };
                        }
                    }
                } catch(e) {}

                return { url: null, source: 'evaluate.failed' };
            }, groupId);

            if (fallbackPic && typeof fallbackPic.url === 'string') {
                photoUrl = fallbackPic.url;
                photoSource = fallbackPic.source;
            } else if (fallbackPic && fallbackPic.source !== 'evaluate.failed') {
                photoUrl = null;
                photoSource = fallbackPic.source;
            }

            if (groupId === '120363359964959175@g.us') {
                console.log('\n[PHOTO_RUNTIME]');
                console.log(`groupId=${groupId}`);
                console.log(`success=${!!photoUrl}`);
                console.log(`url=${photoUrl}`);
                console.log(`source=${photoSource}`);
                console.log(`error=none`);
            }
        } catch(err) {
            if (isDiag) {
                console.log(`[PHOTO_FALLBACK_ERROR] strategy=evaluate name=${err.name} message=${err.message}`);
            }
        }
    }
    }

    if (typeof participantsCount === 'number' && participantsCount < 0) {
        participantsCount = null;
    }

    return {
        id: groupId,
        participantsCount,
        photoUrl,
        participantsSource,
        photoSource,
        error: errorDetails,
        isCommunity
    };
  }


  // ==========================================
  // PARTICIPANT SYNC PIPELINE
  // ==========================================

  _emitParticipantSyncProgress() {
      if (this.io && this.participantSync) {
          this.io.emit('wa:sync_progress', {
              syncId: this.participantSync.syncId,
              type: 'group_participants',
              total: this.participantSync.total,
              processed: this.participantSync.processed,
              success: this.participantSync.success,
              failed: this.participantSync.failed,
              pending: this.participantSync.pending,
              percentage: this.participantSync.percentage,
              running: this.participantSync.running
          });
      }
  }

  async _startParticipantEnrichment(groups) {
    if (!this.client || this.status !== 'READY') return;

    const participantGroups = groups.filter(
        group => typeof group.id === 'string' && group.id.endsWith('@g.us')
    );

    const crypto = require('crypto');
    this.participantSyncId = crypto.randomUUID();
    const currentSyncId = this.participantSyncId;

    this.participantSync = {
        syncId: currentSyncId,
        total: participantGroups.length,
        processed: 0,
        success: 0,
        failed: 0,
        pending: participantGroups.length,
        percentage: 0,
        running: true
    };
    
    this.participantRetryQueue = [];

    for (const g of participantGroups) {
        const cached = this.groupCache.get(g.id) || { id: g.id, name: g.name };
        this.groupCache.set(g.id, cached);
        
        if (cached.participantStatus === 'success') {
            this.participantSync.success++;
            this.participantSync.processed++;
            this.participantSync.pending--;
        } else {
            this.participantRetryQueue.push({
                id: g.id,
                name: g.name,
                attempts: 0,
                status: 'pending',
                nextTry: 0
            });
        }
    }
    
    this.participantSync.percentage = Math.floor((this.participantSync.processed / (this.participantSync.total || 1)) * 100);
    this._emitParticipantSyncProgress();
    
    if (this.participantSyncRunning) {
        return;
    }
    
    this.participantSyncRunning = true;
    try {
        await this._processParticipantQueue(currentSyncId);
    } finally {
        if (this.participantSyncId === currentSyncId) {
            this.participantSyncRunning = false;
        }
    }
  }

  async _processParticipantQueue(syncId) {
    const CONCURRENCY = 5;
    const activeWorkers = new Set();
    
    while (this.participantSyncId === syncId && this.status === 'READY') {
        const now = Date.now();
        const nextIdx = this.participantRetryQueue.findIndex(item => 
            (item.status === 'pending') ||
            (item.status === 'retrying' && now >= item.nextTry)
        );
        
        if (nextIdx !== -1 && activeWorkers.size < CONCURRENCY) {
            const item = this.participantRetryQueue.splice(nextIdx, 1)[0];
            const worker = this._processParticipantItem(item, syncId);
            activeWorkers.add(worker);
            worker.finally(() => activeWorkers.delete(worker));
            continue;
        }
        
        if (activeWorkers.size > 0) {
            await Promise.race(Array.from(activeWorkers));
            continue;
        }
        
        const hasRetrying = this.participantRetryQueue.some(item => item.status === 'retrying');
        if (hasRetrying) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }
        
        break;
    }
    
    if (this.participantSyncId === syncId && this.participantSync.processed === this.participantSync.total) {
        this.participantSync.running = false;
        this.participantSync.percentage = 100;
        this._emitParticipantSyncProgress();
        console.log(`[PARTICIPANT_SYNC_SUMMARY] total=${this.participantSync.total} success=${this.participantSync.success} failed=${this.participantSync.failed} pending=${this.participantSync.pending}`);
    }
  }

  async _processParticipantItem(item, syncId) {
    if (this.participantSyncId !== syncId) return;
    
    item.attempts++;
    item.status = 'loading';
    
    let result = null;
    let errMessage = null;

    try {
        const fetchPromise = this.resolveParticipantsCount(item.id);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT:resolveGroupMetadata')), 12000));
        result = await Promise.race([fetchPromise, timeoutPromise]);
    } catch(err) {
        errMessage = err.message;
    }

    if (this.participantSyncId !== syncId) return;

    const RETRY_DELAYS = [0, 3000, 7000, 15000];
    const maxAttempts = RETRY_DELAYS.length;
    
    if (result && result.status === 'success' && Number.isInteger(result.count) && result.count > 0) {
        const cached = this.groupCache.get(item.id) || {};
        cached.participantsCount = result.count;
        cached.participantStatus = 'success';
        this.groupCache.set(item.id, cached);
        
        this.participantSync.success++;
        
        console.log(`[PARTICIPANT_SYNC] groupId=${item.id} count=${result.count} status=success source=${result.source}`);
        this.io?.emit('wa:group_enriched', cached);
    } else {
        if (item.attempts < maxAttempts) {
            item.status = 'retrying';
            item.nextTry = Date.now() + RETRY_DELAYS[item.attempts];
            this.participantRetryQueue.push(item);
            return;
        } else {
            const cached = this.groupCache.get(item.id) || {};
            cached.participantStatus = 'failed';
            this.groupCache.set(item.id, cached);

            this.participantSync.failed++;
            
            console.log(`[PARTICIPANT_SYNC] groupId=${item.id} count=null status=failed source=none`);
            this.io?.emit('wa:group_enriched', cached);
        }
    }

    this.participantSync.processed = this.participantSync.success + this.participantSync.failed;
    this.participantSync.pending = this.participantSync.total - this.participantSync.processed;
    this.participantSync.percentage = Math.floor((this.participantSync.processed / (this.participantSync.total || 1)) * 100);
    this._emitParticipantSyncProgress();
  }

  async _startEnrichment(groups) {
    if (!this.client || this.status !== 'READY') return;

    const photoGroups = groups.filter(
        group => typeof group.id === 'string' && group.id.endsWith('@g.us')
    );
    
    console.log(`\n[GROUP_PHOTO_QUEUE]`);
    console.log(`totalGroups=${photoGroups.length}`);
    console.log(`invalidIds=${groups.length - photoGroups.length}`);
    console.log(`participantPhotoRequests=0`);

    const crypto = require('crypto');
    this.photoSyncId = crypto.randomUUID();
    const currentSyncId = this.photoSyncId;

    this.photoSync = {
        syncId: currentSyncId,
        total: photoGroups.length,
        processed: 0,
        success: 0,
        noPhoto: 0,
        failed: 0,
        pending: photoGroups.length,
        percentage: 0,
        running: true
    };
    
    this.photoRetryQueue = [];

    for (const g of photoGroups) {
        const cached = this.groupCache.get(g.id) || { id: g.id, name: g.name };
        this.groupCache.set(g.id, cached);
        
        if (cached.photoStatus === 'success' || cached.photoStatus === 'no_photo') {
            this.photoSync.success += (cached.photoStatus === 'success' ? 1 : 0);
            this.photoSync.noPhoto += (cached.photoStatus === 'no_photo' ? 1 : 0);
            this.photoSync.processed++;
            this.photoSync.pending--;
        } else {
            this.photoRetryQueue.push({
                id: g.id,
                name: g.name,
                attempts: 0,
                status: 'pending',
                nextTry: 0
            });
        }
    }
    
    this.photoSync.percentage = Math.floor((this.photoSync.processed / (this.photoSync.total || 1)) * 100);
    this._emitPhotoSyncProgress();
    
    if (this.photoSyncRunning) {
        return;
    }
    
    this.photoSyncRunning = true;
    try {
        await this._processPhotoQueue(currentSyncId);
    } finally {
        if (this.photoSyncId === currentSyncId) {
            this.photoSyncRunning = false;
        }
    }
  }

  _emitPhotoSyncProgress() {
      if (this.io && this.photoSync) {
          this.io.emit('wa:sync_progress', {
              syncId: this.photoSync.syncId,
              type: 'group_photos',
              total: this.photoSync.total,
              processed: this.photoSync.processed,
              success: this.photoSync.success,
              noPhoto: this.photoSync.noPhoto,
              failed: this.photoSync.failed,
              pending: this.photoSync.pending,
              percentage: this.photoSync.percentage,
              running: this.photoSync.running
          });
          
          console.log(`[GROUP_PHOTO_PROGRESS] syncId=${this.photoSync.syncId} processed=${this.photoSync.processed}/${this.photoSync.total} success=${this.photoSync.success} noPhoto=${this.photoSync.noPhoto} failed=${this.photoSync.failed} percentage=${this.photoSync.percentage} queue=${this.photoRetryQueue.length}`);
      }
  }

  async _processPhotoQueue(syncId) {
    const PHOTO_CONCURRENCY = 4;
    const activeWorkers = new Set();
    
    while (this.photoSyncId === syncId && this.status === 'READY') {
        const now = Date.now();
        const nextIdx = this.photoRetryQueue.findIndex(item => 
            (item.status === 'pending') ||
            (item.status === 'retrying' && now >= item.nextTry)
        );
        
        if (nextIdx !== -1 && activeWorkers.size < PHOTO_CONCURRENCY) {
            const item = this.photoRetryQueue.splice(nextIdx, 1)[0];
            const worker = this._processPhotoItem(item, syncId);
            activeWorkers.add(worker);
            worker.finally(() => activeWorkers.delete(worker));
            continue;
        }
        
        if (activeWorkers.size > 0) {
            await Promise.race(Array.from(activeWorkers));
            continue;
        }
        
        const hasRetrying = this.photoRetryQueue.some(item => item.status === 'retrying');
        if (hasRetrying) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }
        
        break;
    }
    
    if (this.photoSyncId === syncId && this.photoSync.processed === this.photoSync.total) {
        this.photoSync.running = false;
        this.photoSync.percentage = 100;
        this._emitPhotoSyncProgress();
        console.log(`\n[GROUP_PHOTO_SYNC_COMPLETE]`);
        console.log(`total=${this.photoSync.total}`);
        console.log(`success=${this.photoSync.success}`);
        console.log(`noPhoto=${this.photoSync.noPhoto}`);
        console.log(`failed=${this.photoSync.failed}`);
    }
  }

  async _processPhotoItem(item, syncId) {
    if (this.photoSyncId !== syncId) return;
    
    item.attempts++;
    item.status = 'loading';
    console.log(`[PHOTO_QUEUE] group=${item.id} attempt=${item.attempts}`);
    
    const startMs = Date.now();
    let result = null;
    let errMessage = null;

    try {
        const fetchPromise = this.resolveGroupPhoto(item.id);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT:resolveGroupMetadata')), 12000));
        result = await Promise.race([fetchPromise, timeoutPromise]);
    } catch(err) {
        errMessage = err.message;
    }

    if (this.photoSyncId !== syncId) return;

    const RETRY_DELAYS = [0, 3000, 7000, 15000];
    const maxAttempts = RETRY_DELAYS.length;
    
    if (result && result.status === 'success' && typeof result.url === 'string') {
        const proxyPhotoUrl = `${process.env.PUBLIC_URL || 'https://arthurvault-backend-production.up.railway.app'}/api/group-photo/${encodeURIComponent(item.id)}?v=${Date.now()}`;
        const cached = this.groupCache.get(item.id) || {};
        cached.photoUrl = proxyPhotoUrl;
        cached.originalPhotoUrl = result.url;
        cached.photoStatus = 'success';
        this.groupCache.set(item.id, cached);
        
        this.photoSync.success++;
        
        console.log(`[GROUP_PHOTO]`);
        console.log(`id=${item.id}`);
        console.log(`attempt=${item.attempts}`);
        console.log(`status=success`);
        console.log(`durationMs=${Date.now() - startMs}`);

        this.io?.emit('wa:group_enriched', cached);
    } else if (result && result.status === 'no_photo') {
        const cached = this.groupCache.get(item.id) || {};
        cached.photoStatus = 'no_photo';
        this.groupCache.set(item.id, cached);

        this.photoSync.noPhoto++;
        
        console.log(`[GROUP_PHOTO]`);
        console.log(`id=${item.id}`);
        console.log(`status=no_photo`);

        this.io?.emit('wa:group_enriched', cached);
    } else {
        if (item.attempts < maxAttempts) {
            item.status = 'retrying';
            item.nextTry = Date.now() + RETRY_DELAYS[item.attempts];
            this.photoRetryQueue.push(item);
            
            console.log(`[GROUP_PHOTO]`);
            console.log(`id=${item.id}`);
            console.log(`attempt=${item.attempts}`);
            console.log(`status=retrying`);
            console.log(`reason=${errMessage || 'no_url_found'}`);
            return;
        } else {
            const cached = this.groupCache.get(item.id) || {};
            cached.photoStatus = 'failed';
            this.groupCache.set(item.id, cached);

            this.photoSync.failed++;
            
            console.log(`[GROUP_PHOTO]`);
            console.log(`id=${item.id}`);
            console.log(`attempt=${item.attempts}`);
            console.log(`status=failed_final`);
            
            this.io?.emit('wa:group_enriched', cached);
        }
    }

    this.photoSync.processed = this.photoSync.success + this.photoSync.noPhoto + this.photoSync.failed;
    this.photoSync.pending = this.photoSync.total - this.photoSync.processed;
    this.photoSync.percentage = Math.floor((this.photoSync.processed / (this.photoSync.total || 1)) * 100);
    this._emitPhotoSyncProgress();
  }

  retryFailedPhotos() {
  }

  onDemandPhotoLocks = new Map();

  async validatePhotoUrl(url) {
      if (!this.client || !this.client.pupPage || !url) return false;
      try {
          const isValid = await this.client.pupPage.evaluate(async (imgUrl) => {
              try {
                  const res = await fetch(imgUrl);
                  if (!res.ok) return false;
                  const blob = await res.blob();
                  return blob.size > 0 && blob.type.startsWith('image/');
              } catch(e) { return false; }
          }, url);
          return !!isValid;
      } catch(e) {
          return false;
      }
  }

  async resolvePhotoOnDemand(groupId) {
      if (this.status !== 'READY') return null;
      
      const cached = this.groupCache.get(groupId);
      if (cached && cached.photoStatus === 'success' && cached.originalPhotoUrl) {
          return cached.originalPhotoUrl;
      }
      
      // Return existing promise if already fetching
      if (this.onDemandPhotoLocks.has(groupId)) {
          return this.onDemandPhotoLocks.get(groupId);
      }
      
      console.log(`[PHOTO_ONDEMAND] Requesting robust resolution for id=${groupId}`);
      const promise = (async () => {
          try {
              const result = await this.resolveGroupPhoto(groupId);
              if (typeof result.url === 'string') {
                  const proxyPhotoUrl = `${process.env.PUBLIC_URL || 'https://arthurvault-backend-production.up.railway.app'}/api/group-photo/${encodeURIComponent(groupId)}?v=${Date.now()}`;
                  if (cached) {
                      cached.photoUrl = proxyPhotoUrl;
                      cached.originalPhotoUrl = result.url;
                      cached.photoStatus = 'success';
                      this.groupCache.set(groupId, cached);
                      this.io?.emit('wa:group_enriched', cached);
                  }
                  console.log(`[PHOTO_ONDEMAND_SUCCESS] id=${groupId}`);
                  return result.photoUrl;
              }
              console.log(`[PHOTO_ONDEMAND_FAILED] id=${groupId} source=${result.photoSource}`);
              return null;
          } catch(e) {
              console.log(`[PHOTO_ONDEMAND_ERROR] id=${groupId} err=${e.message}`);
              return null;
          } finally {
              this.onDemandPhotoLocks.delete(groupId);
          }
      })();
      
      this.onDemandPhotoLocks.set(groupId, promise);
      return promise;
  }

  async runDiagnostic() {
    if (!this.client || !this.client.pupPage) {
      throw new Error('Client or pupPage not ready');
    }
    
    const diag = {
      status: this.status,
      getChatsMethod: false,
      getChatsTotal: 0,
      storeTotal: 0,
      storeDiagnostic: {},
      chatsDiagnostic: {}
    };

    // 1. Diagnose via getChats
    try {
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000));
      const chats = await Promise.race([this.client.getChats(), timeoutPromise]);
      diag.getChatsMethod = true;
      diag.getChatsTotal = chats.length;
      
      let isGroupTrue = 0, isGroupFalse = 0;
      const servers = {};
      const suffixes = {};
      const constructors = {};
      const foundGroups = [];
      
      for (const chat of chats) {
         if (chat.isGroup === true) isGroupTrue++;
         else isGroupFalse++;
         
         const srv = (chat.id && chat.id.server) ? chat.id.server : 'undefined';
         servers[srv] = (servers[srv] || 0) + 1;
         
         let sfx = 'other';
         if (chat.id && chat.id._serialized) {
           const parts = chat.id._serialized.split('@');
           if (parts.length > 1) sfx = '@' + parts[1];
         }
         suffixes[sfx] = (suffixes[sfx] || 0) + 1;
         
         const ctor = chat.constructor ? chat.constructor.name : 'Unknown';
         constructors[ctor] = (constructors[ctor] || 0) + 1;
         
         if ((chat.isGroup === true || srv === 'g.us' || sfx === '@g.us') && foundGroups.length < 5) {
            foundGroups.push({
               serialized: chat.id ? chat.id._serialized : null,
               server: srv,
               isGroup: chat.isGroup,
               type: chat.type,
               name: chat.name,
               constructorName: ctor
            });
         }
      }
      
      diag.chatsDiagnostic = {
        isGroupTrue,
        isGroupFalse,
        servers,
        suffixes,
        constructors,
        foundGroups
      };
      
    } catch (e) {
      diag.getChatsError = e.message;
    }
    
    // 2. Diagnose via Store Evaluate
    try {
      const storeDiag = await this.client.pupPage.evaluate(() => {
        const res = {
          storeExists: !!window.Store,
          chatExists: !!(window.Store && window.Store.Chat),
          modelsCount: 0,
          gusCount: 0,
          lidCount: 0,
          cusCount: 0,
          otherCount: 0,
          sampleGroups: []
        };
        if (res.chatExists && typeof window.Store.Chat.getModelsArray === 'function') {
          const models = window.Store.Chat.getModelsArray();
          res.modelsCount = models.length;
          for (const m of models) {
            const idStr = m.id && m.id._serialized ? m.id._serialized : '';
            if (idStr.endsWith('@g.us')) res.gusCount++;
            else if (idStr.endsWith('@lid')) res.lidCount++;
            else if (idStr.endsWith('@c.us')) res.cusCount++;
            else res.otherCount++;
            
            if (idStr.endsWith('@g.us') && res.sampleGroups.length < 5) {
              res.sampleGroups.push({
                serialized: idStr,
                server: m.id ? m.id.server : undefined,
                isGroup: m.isGroup,
                type: m.type,
                name: m.name || m.formattedTitle,
                constructorName: m.constructor ? m.constructor.name : 'Unknown'
              });
            }
          }
        }
        return res;
      });
      diag.storeDiagnostic = storeDiag;
      diag.storeTotal = storeDiag.modelsCount;
    } catch (e) {
      diag.storeError = e.message;
    }

    return diag;
  }

  async _getChatsFallback() {
    console.log('[GROUPS] Starting injected fallback');
    
    const fallbackResult = await this.client.pupPage.evaluate(() => {
      let models = null;
      let namespace = 'none';

      try {
        if (window.require) {
          const WAWebCollections = window.require('WAWebCollections');
          if (WAWebCollections && WAWebCollections.Chat && typeof WAWebCollections.Chat.getModelsArray === 'function') {
            models = WAWebCollections.Chat.getModelsArray();
            namespace = 'WAWebCollections.Chat';
          }
        }
      } catch (e) {
        // Ignorar erros
      }

      if (!models) {
        try {
          if (window.Store && window.Store.Chat && typeof window.Store.Chat.getModelsArray === 'function') {
            models = window.Store.Chat.getModelsArray();
            namespace = 'Store.Chat';
          }
        } catch(e) {}
      }

      if (!models) {
        try {
          if (window.WWebJS && typeof window.WWebJS.getChats === 'function') {
            // WWebJS returns mapped chats, not models
            models = window.WWebJS.getChats();
            namespace = 'WWebJS.getChats';
          }
        } catch(e) {}
      }

      if (!models) {
        return { success: false, namespace: 'none', rawModels: [] };
      }

      // Extrair apenas o necessário para evitar erros de serialização ("Maximum call stack" ou outros)
      const rawModels = models.map(c => {
        let idStr = '';
        let serverStr = '';

        if (c && c.id) {
          if (c.id._serialized) idStr = String(c.id._serialized);
          else if (c.id.user && c.id.server) idStr = `${c.id.user}@${c.id.server}`;
          serverStr = String(c.id.server || '');
        }

        let participantCount = null;
        if (c.isGroup) {
          if (c.participants && c.participants.length !== undefined) {
            participantCount = c.participants.length;
          } else if (c.groupMetadata && c.groupMetadata.participants) {
            participantCount = c.groupMetadata.participants.length;
          }
        }

        return {
          id: { _serialized: idStr, server: serverStr },
          name: c.name || c.formattedTitle || c.contact?.pushname || 'Grupo sem nome',
          isGroup: !!c.isGroup,
          type: c.type,
          participants: { length: participantCount }
        };
      });

      return { success: true, namespace, rawModels };
    });

    console.log(`[GROUPS] Fallback namespace available: ${fallbackResult.namespace}`);
    console.log(`[GROUPS] Raw models: ${fallbackResult.rawModels.length}`);
    
    if (!fallbackResult.success) {
      throw new Error('All fallback namespaces failed or returned no data.');
    }
    
    return fallbackResult.rawModels;
  }

  async _actuallyLoadGroups() {
    console.log('[GROUPS] Request received');
    console.log(`[GROUPS] WhatsApp state: ${this.status}`);
    
    // Check real WWeb version requested vs loaded
    try {
      const waVersion = await this.client.pupPage.evaluate(() => {
        return window.Debug?.VERSION || 'unknown';
      });
      const webVersionCache = this.client.options.webVersionCache || {};
      console.log(`[WA_VERSION] requested: ${webVersionCache.remotePath || 'default'}`);
      console.log(`[WA_VERSION] loaded: ${waVersion}`);
      console.log(`[WA_VERSION] cache type: ${webVersionCache.type || 'none'}`);
    } catch(e) {}

    let chats = [];
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('getChats timeout after 30000ms')), 30000);
    });

    console.log('[GROUPS] Primary strategy: client.getChats()');
    try {
      chats = await Promise.race([
        this.client.getChats(),
        timeoutPromise
      ]);
      console.log('[GROUPS] Primary strategy succeeded');
      console.log(`[GROUPS] Chats loaded: ${chats.length}`);
    } catch (officialError) {
      console.log(`[GROUPS] Primary failed: ${officialError.message || officialError}`);
      
      chats = await this._getChatsFallback();
    }

    // ==========================================
    // CORREÇÃO DEFINITIVA DE CLASSIFICAÇÃO
    // ==========================================
    function getSerializedChatId(chat) {
      if (typeof chat?.id?._serialized === 'string') {
        return chat.id._serialized;
      }
      if (typeof chat?.id?.user === 'string' && typeof chat?.id?.server === 'string') {
        return `${chat.id.user}@${chat.id.server}`;
      }
      return String(chat?.id || '');
    }

    function isWhatsAppGroup(chat) {
      const id = getSerializedChatId(chat);
      return (
        id.endsWith('@g.us') ||
        chat?.id?.server === 'g.us' ||
        chat?.isGroup === true
      );
    }

    let identifiedByGus = 0;
    
    this.loadedChatsCache = new Map();
    const groupChats = chats.filter(chat => {
      const id = getSerializedChatId(chat);
      const endsWithGus = id.endsWith('@g.us') || chat?.id?.server === 'g.us';
      
      if (endsWithGus) identifiedByGus++;
      
      const isGroup = isWhatsAppGroup(chat);
      if (isGroup) {
          this.loadedChatsCache.set(id, chat);
      }
      return isGroup;
    });

    console.log(`[GROUPS] @g.us identified: ${identifiedByGus}`);
    console.log(`[GROUPS] Groups found: ${groupChats.length}`);

    // Mapeamento extraindo apenas dados reais
    const mappedGroups = groupChats.map(group => {
      const id = getSerializedChatId(group);
      const name = group.name || group.formattedTitle || group.contact?.pushname || 'Grupo sem nome';
      const participantsCount = (Array.isArray(group.participants) && group.participants.length > 0) ? group.participants.length : (typeof group.participants?.length === 'number' && group.participants.length > 0 ? group.participants.length : null);
      return { id, name, participantsCount, participantStatus: participantsCount ? 'success' : 'pending', photoStatus: 'pending' };
    });

    // Deduplicação exclusiva pelo ID serializado
    const uniqueGroups = Array.from(
      new Map(mappedGroups.map(group => [group.id, group])).values()
    );

    console.log(`[GROUPS] Unique groups: ${uniqueGroups.length}`);
    console.log(`[GROUPS] Sending groups to frontend: ${uniqueGroups.length}`);
    
    return uniqueGroups;
  }

  async getGroupParticipants(groupId) {
    if (this.status !== 'READY' || !this.client) {
      throw new Error('WhatsApp is not ready');
    }
    console.log(`[GROUP] Selected: ${groupId}`);

    try {
      const evalPromise = this.client.pupPage.evaluate(async (gId) => {
        let parts = null;

        let chatModel = null;
        if (window.Store && window.Store.Chat) chatModel = window.Store.Chat.get(gId);
        if (!chatModel && window.WAWebCollections && window.WAWebCollections.Chat) chatModel = window.WAWebCollections.Chat.get(gId);
        
        if (chatModel && chatModel.participants) {
            if (Array.isArray(chatModel.participants)) parts = chatModel.participants;
            else if (typeof chatModel.participants.getModelsArray === 'function') parts = chatModel.participants.getModelsArray();
            else if (Array.isArray(chatModel.participants._models)) parts = chatModel.participants._models;
        } else if (chatModel && chatModel.groupMetadata && chatModel.groupMetadata.participants) {
            const gp = chatModel.groupMetadata.participants;
            if (Array.isArray(gp)) parts = gp;
            else if (typeof gp.getModelsArray === 'function') parts = gp.getModelsArray();
            else if (Array.isArray(gp._models)) parts = gp._models;
        }

        if (!parts) {
            let metadataModel = null;
            if (window.Store && window.Store.GroupMetadata) {
                try { await window.Store.GroupMetadata.update(gId); } catch(e){}
                metadataModel = window.Store.GroupMetadata.get(gId);
            }
            if (!metadataModel && window.WAWebCollections && window.WAWebCollections.GroupMetadata) {
                try { await window.WAWebCollections.GroupMetadata.update(gId); } catch(e){}
                metadataModel = window.WAWebCollections.GroupMetadata.get(gId);
            }
            if (metadataModel && metadataModel.participants) {
                const gp = metadataModel.participants;
                if (Array.isArray(gp)) parts = gp;
                else if (typeof gp.getModelsArray === 'function') parts = gp.getModelsArray();
                else if (Array.isArray(gp._models)) parts = gp._models;
            }
        }

        if (!parts) return [];

        const ContactStore = window.Store ? window.Store.Contact : (window.WAWebCollections ? window.WAWebCollections.Contact : null);

        return parts.map(p => {
            const idObj = p.id || {};
            const serializedId = idObj._serialized || (idObj.user && idObj.server ? `${idObj.user}@${idObj.server}` : null);
            
            let name = p.name || p.pushname || p.shortName || p.notifyName || null;
            let number = serializedId ? serializedId.split('@')[0] : null;

            if (serializedId && ContactStore && typeof ContactStore.get === 'function') {
                const contact = ContactStore.get(serializedId);
                if (contact) {
                    if (!name) name = contact.name || contact.pushname || contact.shortName || contact.notifyName || null;
                }
            }

            return {
                id: serializedId,
                number: number,
                name: name,
                isAdmin: !!p.isAdmin,
                isSuperAdmin: !!p.isSuperAdmin
            };
        }).filter(p => p.id);
      }, groupId);

      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT: getGroupParticipants')), 15000));
      const participants = await Promise.race([evalPromise, timeoutPromise]);
      
      return participants;
    } catch (error) {
      console.error(`[GET_PARTICIPANTS_ERROR] for group ${groupId}:`, error);
      throw error;
    }
  }
}

module.exports = new WhatsAppService();
