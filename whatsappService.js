const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');

class WhatsAppService {
  constructor() {
    this.client = null;
    this.status = 'IDLE'; // IDLE, INITIALIZING, WAITING_QR, AUTHENTICATING, READY, ERROR, DISCONNECTED
    this.qrCode = null;
    this.io = null;
    this.errorDetails = null;
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
    if (this.status === 'INITIALIZING' || this.status === 'WAITING_QR' || this.status === 'AUTHENTICATING' || this.status === 'READY') {
      console.log('[WA] Initialization skipped. Current status is already:', this.status);
      this.emitStatus();
      return;
    }

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

    const browserPath = puppeteerOptions.executablePath || 'Default (Auto-detect)';
    console.log('[WA] Checking browser executable...');
    console.log(`[WA] Executable Path: ${browserPath}`);

    if (puppeteerOptions.executablePath) {
      if (fs.existsSync(puppeteerOptions.executablePath)) {
        console.log('[WA] Browser exists: true');
      } else {
        console.log('[WA] Browser exists: false');
        console.error('[WA] Cannot start WhatsApp Client. Browser executable not found!');
        this.status = 'ERROR';
        this.errorDetails = { code: 'INIT_FAILED', message: 'Não foi possível iniciar o serviço de conexão.' };
        this.emitStatus();
        return;
      }
    }

    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: puppeteerOptions
    });

    console.log('[WA] Registering event listeners...');

    this.client.on('qr', (qr) => {
      console.log('[WA] QR received');
      this.status = 'WAITING_QR';
      this.qrCode = qr;
      this.emitStatus();
    });

    this.client.on('authenticated', () => {
      console.log('[WA] Authenticated');
      this.status = 'AUTHENTICATING';
      this.qrCode = null;
      this.emitStatus();
    });

    this.client.on('auth_failure', msg => {
      console.error('[WA] Auth failure:', msg);
      this.status = 'ERROR';
      this.errorDetails = { code: 'AUTH_FAILURE', message: 'Falha na autenticação da sessão.' };
      this.emitStatus();
    });

    this.client.on('ready', () => {
      console.log('[WA] Ready');
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
      console.error("[WA] CLIENT INITIALIZATION FAILED");
      if (error instanceof Error) {
          console.error("[WA] name:", error.name);
          console.error("[WA] message:", error.message);
          console.error("[WA] stack:", error.stack);
      } else {
          console.error("[WA] raw error:", error);
      }
      this.status = 'ERROR';
      this.errorDetails = { code: 'INIT_FAILED', message: 'Não foi possível iniciar o serviço de conexão.' };
      this.emitStatus();
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
}

module.exports = new WhatsAppService();
