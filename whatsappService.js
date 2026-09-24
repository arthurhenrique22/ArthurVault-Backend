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

  async getRealParticipantCount(groupId, isDiag) {
    let pCount = null;
    let isCommunity = false;

    try {
      if (isDiag) console.log(`\n[ENRICH_DEBUG] START`);
      if (isDiag) console.log(`[ENRICH_DEBUG] id=${groupId}`);
      if (isDiag) console.log(`[ENRICH_DEBUG] getChatById starting`);
      
      const chat = await this.client.getChatById(groupId);
      if (isDiag) {
          console.log(`[ENRICH_DEBUG] getChatById success`);
          console.log(`[ENRICH_DEBUG] chat constructor=${chat?.constructor?.name}`);
          console.log(`[ENRICH_DEBUG] isGroup=${chat?.isGroup}`);
          console.log(`[ENRICH_DEBUG] participants direct=${chat?.participants ? chat.participants.length : 'undefined'}`);
          console.log(`[ENRICH_DEBUG] metadata=${!!chat?.groupMetadata}`);
      }

      if (chat && Array.isArray(chat.participants) && chat.participants.length > 0) {
        pCount = chat.participants.length;
        isCommunity = chat.isCommunity || false;
      } else if (chat && chat.groupMetadata && Array.isArray(chat.groupMetadata.participants)) {
        pCount = chat.groupMetadata.participants.length;
        isCommunity = chat.isCommunity || false;
      } else {
        throw new Error('No participants array found on chat object');
      }
    } catch(err) {
      console.log(`\n[PARTICIPANTS_NATIVE_ERROR]`);
      console.log(`name=${err.name}`);
      console.log(`message=${err.message}`);
      console.log(`stack=${err.stack}`);
      
      // Full Fallback
      try {
         if (isDiag) console.log(`[ENRICH_DEBUG] fallback starting`);
         const fallback = await this.client.pupPage.evaluate((gId, diag) => {
             const result = { found: false, count: null, isCommunity: false, diag: {} };
             
             try {
                if (diag) {
                    result.diag.windowStore = !!window.Store;
                    result.diag.windowWWebJS = !!window.WWebJS;
                    result.diag.windowWAWebCollections = !!window.WAWebCollections;
                    result.diag.windowRequire = !!window.require;
                }

                let chatModel = null;
                let metadataModel = null;

                // Attempt 1: window.Store
                if (window.Store) {
                    if (window.Store.Chat) chatModel = window.Store.Chat.get(gId);
                    if (window.Store.GroupMetadata) metadataModel = window.Store.GroupMetadata.get(gId);
                }

                // Attempt 2: WAWebCollections
                if (!chatModel && window.WAWebCollections) {
                    if (window.WAWebCollections.Chat) chatModel = window.WAWebCollections.Chat.get(gId);
                    if (window.WAWebCollections.GroupMetadata) metadataModel = window.WAWebCollections.GroupMetadata.get(gId);
                }

                // Try to extract count
                if (metadataModel && metadataModel.participants) {
                    const arr = metadataModel.participants;
                    result.found = true;
                    result.count = typeof arr.length === 'number' ? arr.length : (arr._models ? arr._models.length : null);
                    result.isCommunity = !!metadataModel.isCommunity;
                } else if (chatModel && chatModel.participants) {
                    const arr = chatModel.participants;
                    result.found = true;
                    result.count = typeof arr.length === 'number' ? arr.length : (arr._models ? arr._models.length : null);
                    result.isCommunity = !!chatModel.isCommunity;
                } else if (chatModel && chatModel.groupMetadata && chatModel.groupMetadata.participants) {
                    const arr = chatModel.groupMetadata.participants;
                    result.found = true;
                    result.count = typeof arr.length === 'number' ? arr.length : (arr._models ? arr._models.length : null);
                    result.isCommunity = !!chatModel.isCommunity;
                }

                if (diag) {
                   result.diag.chatModelExists = !!chatModel;
                   result.diag.metadataModelExists = !!metadataModel;
                   result.diag.extractedCount = result.count;
                }
             } catch(e) {
                if (diag) result.diag.evalError = e.message;
             }
             return result;
         }, groupId, isDiag);
         
         if (isDiag) console.log(`[ENRICH_DEBUG] fallback diag: ${JSON.stringify(fallback.diag)}`);
         
         if (fallback && fallback.found && typeof fallback.count === 'number') {
            pCount = fallback.count;
            isCommunity = fallback.isCommunity;
            if (isDiag) console.log(`[ENRICH_DEBUG] fallback success: count=${pCount}`);
         } else {
            if (isDiag) console.log(`[ENRICH_DEBUG] fallback failed to find count`);
         }
      } catch(e) {
          if (isDiag) {
             console.log(`\n[PARTICIPANTS_FALLBACK_ERROR]`);
             console.log(`strategy=evaluate`);
             console.log(`name=${e.name}`);
             console.log(`message=${e.message}`);
             console.log(`stack=${e.stack}`);
          }
      }
    }

    if (isDiag) console.log(`[ENRICH_DEBUG] participant count=${pCount}`);
    return { pCount, isCommunity };
  }

  async getRealGroupPhoto(groupId, isDiag) {
    try {
      if (isDiag) console.log(`[ENRICH_DEBUG] profilePic starting`);
      const photoUrl = await this.client.getProfilePicUrl(groupId);
      if (isDiag) {
          console.log(`[ENRICH_DEBUG] profilePic result=${photoUrl}`);
      }
      return photoUrl || null;
    } catch(err) {
      console.log(`\n[PHOTO_NATIVE_ERROR]`);
      console.log(`name=${err.name}`);
      console.log(`message=${err.message}`);
      console.log(`stack=${err.stack}`);

      // Fallback
      try {
         if (isDiag) console.log(`[ENRICH_DEBUG] profilePic fallback starting`);
         const fallback = await this.client.pupPage.evaluate(async (gId, diag) => {
             const result = { found: false, url: null, diag: {} };
             try {
                let profilePicModule = null;
                if (window.Store && window.Store.ProfilePic) profilePicModule = window.Store.ProfilePic;
                else if (window.WAWebCollections && window.WAWebCollections.ProfilePic) profilePicModule = window.WAWebCollections.ProfilePic;
                
                if (profilePicModule && typeof profilePicModule.profilePicFind === 'function') {
                    const res = await profilePicModule.profilePicFind(gId);
                    result.found = true;
                    result.url = res ? res.eurl : null;
                } else if (profilePicModule && typeof profilePicModule.requestProfilePicFromServer === 'function') {
                    const res = await profilePicModule.requestProfilePicFromServer(gId);
                    result.found = true;
                    result.url = res ? res.eurl : null;
                } else if (window.WWebJS && typeof window.WWebJS.getProfilePicThumb === 'function') {
                    const res = await window.WWebJS.getProfilePicThumb(gId);
                    result.found = true;
                    result.url = res ? res.img : null;
                }
                if (diag) result.diag.moduleExists = !!profilePicModule;
             } catch(e) {
                 if (diag) result.diag.evalError = e.message;
             }
             return result;
         }, groupId, isDiag);
         
         if (isDiag) console.log(`[ENRICH_DEBUG] profilePic fallback diag: ${JSON.stringify(fallback.diag)}`);
         
         if (fallback && fallback.found) {
            if (isDiag) console.log(`[ENRICH_DEBUG] profilePic fallback result=${fallback.url}`);
            return fallback.url || null;
         }
      } catch(e) {
          if (isDiag) {
             console.log(`\n[PHOTO_FALLBACK_ERROR]`);
             console.log(`strategy=evaluate`);
             console.log(`name=${e.name}`);
             console.log(`message=${e.message}`);
             console.log(`stack=${e.stack}`);
          }
      }

      return undefined; // undefined indicates error fetching, null indicates explicitly no photo
    }
  }

  async _startEnrichment(groups) {
    if (!this.client || this.status !== 'READY') return;
    
    console.log(`\n========================================`);
    console.log(`[GROUP_ENRICH] started: ${groups.length}`);
    console.log(`========================================\n`);

    this.groupCache.clear();
    console.log(`[GROUP_ENRICH] Cache cleared for diagnostic.`);

    try {
      const waDiag = await this.client.pupPage.evaluate(() => {
        return {
          whatsappVersion: window.Debug?.VERSION ?? null,
          hasStore: !!window.Store,
          storeKeys: window.Store ? Object.keys(window.Store).sort() : [],
          hasWWebJS: !!window.WWebJS,
          wwebjsKeys: window.WWebJS ? Object.keys(window.WWebJS).sort() : [],
          hasWAWebCollections: !!window.WAWebCollections,
          waWebCollectionsKeys: window.WAWebCollections ? Object.keys(window.WAWebCollections).sort() : []
        };
      });
      console.log(`========== WA RUNTIME DIAGNOSTIC ==========`);
      console.log(`whatsapp-web.js package version: 1.34.7`);
      console.log(`Requested web version cache: 2.2412.54.html`);
      console.log(`WhatsApp Web version: ${waDiag.whatsappVersion}`);
      console.log(`Store exists: ${waDiag.hasStore}`);
      console.log(`Store keys: ${waDiag.storeKeys.join(', ')}`);
      console.log(`WWebJS exists: ${waDiag.hasWWebJS}`);
      console.log(`WWebJS keys: ${waDiag.wwebjsKeys.join(', ')}`);
      console.log(`WAWebCollections exists: ${waDiag.hasWAWebCollections}`);
      console.log(`WAWebCollections keys: ${waDiag.waWebCollectionsKeys.join(', ')}`);
      console.log(`===========================================`);
    } catch(e) {
      console.log(`Error running WA RUNTIME DIAGNOSTIC: ${e.message}`);
    }

    const diagnosticGroup = groups.find(g => g.id.endsWith('@g.us'));
    if (!diagnosticGroup) {
      console.log(`[GROUP_ENRICH] No @g.us group found to test.`);
      return;
    }

    console.log(`\n========================================`);
    console.log(`TESTING SINGLE GROUP: ${diagnosticGroup.id}`);
    console.log(`========================================\n`);

    try {
      const groupModelDiag = await this.client.pupPage.evaluate((gId) => {
        let model = null;
        let source = 'none';

        if (window.Store && window.Store.Chat) {
          model = window.Store.Chat.get(gId);
          if (model) source = 'Store.Chat';
        }
        if (!model && window.WAWebCollections && window.WAWebCollections.Chat) {
           model = window.WAWebCollections.Chat.get(gId);
           if (model) source = 'WAWebCollections.Chat';
        }
        if (!model && window.WWebJS && typeof window.WWebJS.getChatModel === 'function') {
           model = window.WWebJS.getChatModel(gId);
           if (model) source = 'WWebJS.getChatModel';
        }

        if (!model) {
           return { source, found: false };
        }

        return {
          source,
          found: true,
          id: model.id ? model.id._serialized : undefined,
          constructorName: model.constructor ? model.constructor.name : 'Unknown',
          ownKeys: Object.keys(model).filter(k => !k.startsWith('_')),
          prototypeKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(model) || {}),
          nestedCandidates: {
             participantsType: typeof model.participants,
             groupMetadataType: typeof model.groupMetadata,
             metadataType: typeof model.metadata,
             contactType: typeof model.contact,
             profilePicThumbType: typeof model.profilePicThumb
          }
        };
      }, diagnosticGroup.id);

      console.log(`========== REAL GROUP MODEL ==========`);
      console.log(`SOURCE: ${groupModelDiag.source}`);
      console.log(`ID: ${groupModelDiag.id}`);
      console.log(`CONSTRUCTOR: ${groupModelDiag.constructorName}`);
      console.log(`OWN KEYS: ${groupModelDiag.ownKeys ? groupModelDiag.ownKeys.join(', ') : ''}`);
      console.log(`PROTOTYPE KEYS: ${groupModelDiag.prototypeKeys ? groupModelDiag.prototypeKeys.join(', ') : ''}`);
      if (groupModelDiag.nestedCandidates) {
         console.log(`participants type: ${groupModelDiag.nestedCandidates.participantsType}`);
         console.log(`groupMetadata type: ${groupModelDiag.nestedCandidates.groupMetadataType}`);
         console.log(`metadata type: ${groupModelDiag.nestedCandidates.metadataType}`);
         console.log(`contact type: ${groupModelDiag.nestedCandidates.contactType}`);
         console.log(`profilePicThumb type: ${groupModelDiag.nestedCandidates.profilePicThumbType}`);
      }
      console.log(`======================================`);
    } catch(e) {
      console.log(`Error running REAL GROUP MODEL: ${e.message}`);
    }

    try {
       const moduleDiscovery = await this.client.pupPage.evaluate(() => {
          return Object.keys(window.Store || {}).filter(k => /group|participant|chat|contact|profile|pic|wid/i.test(k));
       });
       console.log(`[WA_MODULE_DISCOVERY] ${moduleDiscovery.join(', ')}`);
    } catch(e) {
       console.log(`Error running WA_MODULE_DISCOVERY: ${e.message}`);
    }

    console.log(`\nStarting single group extraction for: ${diagnosticGroup.id}`);
    
    // Test getRealParticipantCount and getRealGroupPhoto for the FIRST GROUP only for diagnostic!
    const { pCount, isCommunity } = await this.getRealParticipantCount(diagnosticGroup.id, true);
    const photoUrl = await this.getRealGroupPhoto(diagnosticGroup.id, true);

    console.log(`\n========== SINGLE GROUP TEST ==========`);
    console.log(`id=${diagnosticGroup.id}`);
    console.log(`name=${diagnosticGroup.name}`);
    console.log(`participantCount=${pCount}`);
    console.log(`photoUrl=${photoUrl}`);
    console.log(`=======================================`);

    // Emit to dashboard just to update one card
    this.io?.emit('wa:group_enriched', {
       id: diagnosticGroup.id,
       photoUrl: photoUrl || null,
       participantCount: pCount,
       isCommunity,
       participantStatus: typeof pCount === 'number' ? 'success' : 'failed',
       photoStatus: typeof photoUrl === 'string' ? 'success' : (photoUrl === null ? 'no_photo' : 'failed')
    });
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
    
    const groupChats = chats.filter(chat => {
      const id = getSerializedChatId(chat);
      const endsWithGus = id.endsWith('@g.us') || chat?.id?.server === 'g.us';
      
      if (endsWithGus) identifiedByGus++;
      
      return isWhatsAppGroup(chat);
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
    const chat = await this.client.getChatById(groupId);
    
    const isGroup = groupId.endsWith('@g.us') || chat?.id?.server === 'g.us' || chat?.isGroup === true;
    
    if (!chat || !isGroup) {
      throw new Error('Group not found or not a valid group');
    }

    console.log(`[GROUP] Participants: ${chat.participants.length}`);
    const extracted = [];
    let validCount = 0;

    // We fetch contacts iteratively to get name and number securely without making too many concurrent requests that might freeze
    for (const participant of chat.participants) {
      try {
        const contact = await this.client.getContactById(participant.id._serialized);
        
        let number = contact.number;
        if (!number && contact.id && contact.id.user) {
          number = contact.id.user;
        }

        if (number) {
          validCount++;
        }

        extracted.push({
          id: contact.id._serialized || participant.id._serialized,
          number: number || '',
          name: contact.name || '',
          pushname: contact.pushname || '',
          shortName: contact.shortName || ''
        });
      } catch (err) {
         // Fallback if contact fetch fails
         extracted.push({
          id: participant.id._serialized,
          number: participant.id.user || '',
          name: '',
          pushname: '',
          shortName: ''
        });
      }
    }
    console.log(`[CONTACTS] Valid numbers: ${validCount}`);
    return extracted;
  }
}

module.exports = new WhatsAppService();
