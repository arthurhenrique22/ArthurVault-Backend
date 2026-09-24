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
      this._startEnrichment(groups).catch(e => console.error('[GROUPS_DETAILS] Enrichment background error:', e));
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

  // ==========================================
  // METADATA RESOLVER
  // ==========================================
  async resolveGroupMetadata(rawGroupId, isDiag) {
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
    if (typeof participantsCount !== 'number' || participantsCount <= 0) {
        try {
            const fallback = await this.client.pupPage.evaluate(async (gId) => {
                let count = null;
                let isComm = false;

                let chatExists = false;
                let chatSource = 'none';
                let chatKeys = [];
                let metadataExists = false;
                let metadataKeys = [];
                let participantsExists = false;
                let participantsType = 'none';
                let participantsKeys = [];

                let chatModel = null;
                let metadataModel = null;

                if (window.Store && window.Store.Chat) {
                    chatModel = window.Store.Chat.get(gId);
                    if (chatModel) chatSource = 'Store.Chat';
                }
                if (window.Store && window.Store.GroupMetadata) {
                    try { await window.Store.GroupMetadata.update(gId); } catch(e){}
                    metadataModel = window.Store.GroupMetadata.get(gId);
                }

                if (!chatModel && window.WAWebCollections && window.WAWebCollections.Chat) {
                    chatModel = window.WAWebCollections.Chat.get(gId);
                    if (chatModel) chatSource = 'WAWebCollections.Chat';
                }
                if (!metadataModel && window.WAWebCollections && window.WAWebCollections.GroupMetadata) {
                    metadataModel = window.WAWebCollections.GroupMetadata.get(gId);
                }

                if (chatModel) {
                    chatExists = true;
                    try { chatKeys = Object.keys(chatModel).filter(k => !k.startsWith('_')).slice(0, 10); } catch(e) {}
                }
                if (metadataModel) {
                    metadataExists = true;
                    try { metadataKeys = Object.keys(metadataModel).filter(k => !k.startsWith('_')).slice(0, 10); } catch(e) {}
                }

                let pTarget = null;
                if (metadataModel && metadataModel.participants) pTarget = metadataModel.participants;
                else if (chatModel && chatModel.participants) pTarget = chatModel.participants;
                else if (chatModel && chatModel.groupMetadata && chatModel.groupMetadata.participants) pTarget = chatModel.groupMetadata.participants;

                if (pTarget) {
                    participantsExists = true;
                    try { participantsKeys = Object.keys(pTarget).filter(k => !k.startsWith('_')).slice(0, 10); } catch(e) {}
                    if (Array.isArray(pTarget)) participantsType = 'array';
                    else if (typeof pTarget.getModelsArray === 'function') participantsType = 'collection.getModelsArray()';
                    else if (Array.isArray(pTarget._models)) participantsType = 'collection._models';
                    else participantsType = typeof pTarget;
                }

                if (gId === '120363359964959175@g.us') {
                    console.log(`\n[GROUP_MODEL_RUNTIME]`);
                    console.log(`groupId=${gId}`);
                    console.log(`chatExists=${chatExists}`);
                    console.log(`chatSource=${chatSource}`);
                    console.log(`chatKeys=[${chatKeys.join(', ')}]`);
                    console.log(`metadataExists=${metadataExists}`);
                    console.log(`metadataKeys=[${metadataKeys.join(', ')}]`);
                    console.log(`participantsExists=${participantsExists}`);
                    console.log(`participantsType=${participantsType}`);
                    console.log(`participantsKeys=[${participantsKeys.join(', ')}]`);
                }

                const extractSize = (val) => {
                    if (!val) return null;
                    if (Array.isArray(val)) return val.length;
                    if (typeof val.length === 'number') return val.length;
                    if (typeof val.size === 'number') return val.size;
                    if (Array.isArray(val._models)) return val._models.length;
                    if (Array.isArray(val.models)) return val.models.length;
                    if (typeof val.getModelsArray === 'function') {
                        const arr = val.getModelsArray();
                        if (Array.isArray(arr)) return arr.length;
                    }
                    return null;
                };

                let chatModel = null;
                let metadataModel = null;

                if (window.Store && window.Store.Chat) chatModel = window.Store.Chat.get(gId);
                if (window.Store && window.Store.GroupMetadata) {
                    try { await window.Store.GroupMetadata.update(gId); } catch(e){}
                    metadataModel = window.Store.GroupMetadata.get(gId);
                }

                if (!chatModel && window.WAWebCollections && window.WAWebCollections.Chat) chatModel = window.WAWebCollections.Chat.get(gId);
                if (!metadataModel && window.WAWebCollections && window.WAWebCollections.GroupMetadata) metadataModel = window.WAWebCollections.GroupMetadata.get(gId);

                // Removed WWebJS.getChatModel because it expects an internal chat object, not a string ID.
                if (metadataModel) {
                    count = extractSize(metadataModel.participants);
                    isComm = !!metadataModel.isCommunity;
                    if (typeof count === 'number') return { count, isComm, source: 'evaluate.GroupMetadata' };
                }

                if (chatModel) {
                    count = extractSize(chatModel.participants);
                    isComm = !!chatModel.isCommunity;
                    if (typeof count === 'number') return { count, isComm, source: 'evaluate.Chat.participants' };
                    
                    if (chatModel.groupMetadata) {
                        count = extractSize(chatModel.groupMetadata.participants);
                        isComm = !!chatModel.isCommunity;
                        if (typeof count === 'number') return { count, isComm, source: 'evaluate.Chat.groupMetadata' };
                    }
                }

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
                let profilePicModule = null;
                let modulesFound = [];
                let methodsFound = [];

                if (window.Store && window.Store.ProfilePic) {
                    profilePicModule = window.Store.ProfilePic;
                    modulesFound.push('Store.ProfilePic');
                } else if (window.WAWebCollections && window.WAWebCollections.ProfilePic) {
                    profilePicModule = window.WAWebCollections.ProfilePic;
                    modulesFound.push('WAWebCollections.ProfilePic');
                }

                let thumbModule = null;
                if (window.Store && window.Store.ProfilePicThumb) {
                    thumbModule = window.Store.ProfilePicThumb;
                    modulesFound.push('Store.ProfilePicThumb');
                } else if (window.WAWebCollections && window.WAWebCollections.ProfilePicThumb) {
                    thumbModule = window.WAWebCollections.ProfilePicThumb;
                    modulesFound.push('WAWebCollections.ProfilePicThumb');
                }

                if (window.WWebJS) modulesFound.push('WWebJS');
                if (window.Store && window.Store.Contact) modulesFound.push('Store.Contact');

                if (thumbModule) {
                    if (typeof thumbModule.get === 'function') methodsFound.push('thumbModule.get');
                    if (typeof thumbModule.find === 'function') methodsFound.push('thumbModule.find');
                }
                if (profilePicModule) {
                    if (typeof profilePicModule.profilePicFind === 'function') methodsFound.push('profilePic.profilePicFind');
                    if (typeof profilePicModule.requestProfilePicFromServer === 'function') methodsFound.push('profilePic.requestProfilePicFromServer');
                }
                if (window.WWebJS && typeof window.WWebJS.getProfilePicThumb === 'function') methodsFound.push('WWebJS.getProfilePicThumb');

                let strategySelected = 'none';
                let resultUrl = null;

                if (thumbModule) {
                    try {
                        let t = thumbModule.get(gId);
                        if (!t && typeof thumbModule.find === 'function') {
                            t = await thumbModule.find(gId);
                            strategySelected = 'evaluate.ProfilePicThumb.find';
                        } else {
                            strategySelected = 'evaluate.ProfilePicThumb.get';
                        }
                        if (t && t.img) resultUrl = t.img;
                        else if (t && t.eurl) resultUrl = t.eurl;
                    } catch(e) {}
                }

                if (!resultUrl && profilePicModule && typeof profilePicModule.profilePicFind === 'function') {
                    const res = await profilePicModule.profilePicFind(gId);
                    if (res && res.eurl) { resultUrl = res.eurl; strategySelected = 'evaluate.ProfilePic.profilePicFind'; }
                } 
                if (!resultUrl && profilePicModule && typeof profilePicModule.requestProfilePicFromServer === 'function') {
                    const res = await profilePicModule.requestProfilePicFromServer(gId);
                    if (res && res.eurl) { resultUrl = res.eurl; strategySelected = 'evaluate.ProfilePic.requestProfilePicFromServer'; }
                }
                if (!resultUrl && window.WWebJS && typeof window.WWebJS.getProfilePicThumb === 'function') {
                    const res = await window.WWebJS.getProfilePicThumb(gId);
                    if (res && res.img) { resultUrl = res.img; strategySelected = 'evaluate.WWebJS.getProfilePicThumb'; }
                }
                if (!resultUrl && window.Store && window.Store.Contact) {
                    const contact = window.Store.Contact.get(gId);
                    if (contact && typeof contact.getProfilePicUrl === 'function') {
                        const res = await contact.getProfilePicUrl();
                        if (res) { resultUrl = res; strategySelected = 'evaluate.Contact.getProfilePicUrl'; }
                    }
                }

                if (gId === '120363359964959175@g.us') {
                    console.log(`\n[PHOTO_DISCOVERY]`);
                    console.log(`groupId=${gId}`);
                    console.log(`modulesFound=[${modulesFound.join(', ')}]`);
                    console.log(`methodsFound=[${methodsFound.join(', ')}]`);
                    console.log(`strategySelected=${strategySelected}`);
                }

                if (resultUrl) return { url: resultUrl, source: strategySelected };
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

    if (typeof participantsCount === 'number' && participantsCount <= 0) {
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

  async _startEnrichment(groups) {
    if (!this.client || this.status !== 'READY') return;
    
    console.log(`\n========================================`);
    console.log(`[GROUP_ENRICH] started: ${groups.length}`);
    console.log(`========================================\n`);

    let enrichedCount = 0;
    let photosFound = 0;
    let photosUnavailable = 0;
    let photosFailed = 0;
    let participantsLoaded = 0;
    let participantsFailed = 0;
    
    const limit = 1;
    const active = new Set();
    let processed = 0;

    const isolatedGroups = groups.filter(g => g.id === '120363359964959175@g.us');
    if (isolatedGroups.length === 0) {
        console.log(`[GROUP_ENRICH] Group 120363359964959175@g.us not found in list. Aborting.`);
        return;
    }
    
    console.log(`[GROUP_ENRICH] Isolating diagnostics. Processing only group: 120363359964959175@g.us`);

    for (const group of isolatedGroups) {
      if (!this.client || this.status !== 'READY') break;

      const enrichTask = (async () => {
        processed++;
        const isDiag = processed <= 3; // Mostrar diagnóstico dos 3 primeiros apenas
        const rawGroupId = group.id;

        const result = await this.resolveGroupMetadata(rawGroupId, isDiag);

        if (isDiag) {
            console.log(`\n[GROUP_VERIFY]`);
            console.log(`name=${group.name}`);
            console.log(`id=${result.id}`);
            console.log(`participants=${result.participantsCount}`);
            console.log(`participantsSource=${result.participantsSource}`);
            console.log(`photo=${typeof result.photoUrl === 'string' ? 'true' : (result.photoUrl === null && result.photoSource !== 'none' ? 'no_photo' : 'false')}`);
            console.log(`photoSource=${result.photoSource}`);
        }

        const proxyPhotoUrl = result.photoUrl ? `${process.env.PUBLIC_URL || 'https://arthurvault-backend-production.up.railway.app'}/api/group-photo/${encodeURIComponent(result.id)}` : null;

        const enriched = { 
          id: result.id, 
          photoUrl: proxyPhotoUrl, 
          originalPhotoUrl: result.photoUrl,
          participantsCount: result.participantsCount,
          isCommunity: result.isCommunity,
          participantStatus: typeof result.participantsCount === 'number' ? 'success' : 'failed',
          photoStatus: typeof result.photoUrl === 'string' ? 'success' : (result.photoUrl === null && result.photoSource !== 'none' ? 'no_photo' : 'failed')
        };
        
        if (enriched.participantStatus === 'success' || enriched.photoStatus === 'success' || enriched.photoStatus === 'no_photo') {
            this.groupCache.set(result.id, enriched);
        }
        
        console.log(`\n[GROUP_ENRICH_EMIT]`);
        console.log(`id=${enriched.id}`);
        console.log(`participantsCount=${enriched.participantsCount}`);
        console.log(`participantStatus=${enriched.participantStatus}`);
        console.log(`photoUrl=${enriched.photoUrl}`);
        console.log(`photoStatus=${enriched.photoStatus}`);

        this.io?.emit('wa:group_enriched', enriched);
        
        if (enriched.participantStatus === 'success') participantsLoaded++;
        else participantsFailed++;

        if (enriched.photoStatus === 'success') photosFound++;
        else if (enriched.photoStatus === 'no_photo') photosUnavailable++;
        else photosFailed++;

        enrichedCount++;
      })();

      active.add(enrichTask);
      enrichTask.finally(() => active.delete(enrichTask));
      
      if (active.size >= limit) {
        await Promise.race(active);
      }
    }
    
    await Promise.all(active);
    
    console.log(`\n========================================`);
    console.log(`ARTHURVAULT GROUP ENRICHMENT REPORT`);
    console.log(`========================================`);
    console.log(`WHATSAPP-WEB.JS VERSION: 1.34.7`);
    console.log(`WEB VERSION REQUESTED: Native default (none forced)`);
    console.log(`GROUPS DISCOVERED: ${groups.length}`);
    console.log(`GROUPS ENRICHED: ${enrichedCount}\n`);
    console.log(`PARTICIPANTS:`);
    console.log(`SUCCESS: ${participantsLoaded}`);
    console.log(`FAILED: ${participantsFailed}\n`);
    console.log(`PHOTOS:`);
    console.log(`SUCCESS: ${photosFound}`);
    console.log(`NO PHOTO: ${photosUnavailable}`);
    console.log(`FAILED: ${photosFailed}`);
    console.log(`========================================\n`);
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

        let participantCount = 0;
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
      const participantsCount = Array.isArray(group.participants) ? group.participants.length : (typeof group.participants?.length === 'number' ? group.participants.length : null);
      return { id, name, participantsCount, participantStatus: 'loading', photoStatus: 'loading' };
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
      const participants = await this.client.pupPage.evaluate(async (gId) => {
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
            if (!metadataModel && window.WAWebCollections && window.WAWebCollections.GroupMetadata) metadataModel = window.WAWebCollections.GroupMetadata.get(gId);
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

      return participants;
    } catch (error) {
      console.error(`[GET_PARTICIPANTS_ERROR] for group ${groupId}:`, error);
      throw error;
    }
  }
}

module.exports = new WhatsAppService();
