const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');

async function run() {
    const puppeteerOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--mute-audio',
        '--disable-extensions'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
    };

    const client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: puppeteerOptions,
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
      }
    });

    client.on('ready', async () => {
        console.log('[DIAG] READY');
        try {
            console.log('[DIAG] Fetching chats...');
            const chats = await client.getChats();
            console.log(`[DIAG] Found ${chats.length} chats`);
            
            const groups = chats.filter(c => c.isGroup);
            console.log(`[DIAG] Found ${groups.length} groups`);
            
            for (let i = 0; i < Math.min(3, groups.length); i++) {
                const chat = groups[i];
                console.log(`\n--- GROUP ${i + 1} (getChats) ---`);
                console.log(`chat.id._serialized: ${chat.id._serialized}`);
                console.log(`chat.name: ${chat.name}`);
                console.log(`chat.isGroup: ${chat.isGroup}`);
                console.log(`Array.isArray(chat.participants): ${Array.isArray(chat.participants)}`);
                console.log(`chat.participants?.length: ${chat.participants?.length}`);
                console.log(`typeof chat.getProfilePicUrl: ${typeof chat.getProfilePicUrl}`);

                try {
                    const groupById = await client.getChatById(chat.id._serialized);
                    console.log(`\n--- GROUP ${i + 1} (getChatById) ---`);
                    console.log(`group.constructor?.name: ${groupById.constructor?.name}`);
                    console.log(`group.isGroup: ${groupById.isGroup}`);
                    console.log(`Array.isArray(group.participants): ${Array.isArray(groupById.participants)}`);
                    console.log(`group.participants?.length: ${groupById.participants?.length}`);
                } catch(e) {
                    console.log(`[DIAG] getChatById ERROR: ${e.name} ${e.message}`);
                }
                
                try {
                    const pic = await client.getProfilePicUrl(chat.id._serialized);
                    console.log(`\n--- GROUP ${i + 1} (getProfilePicUrl) ---`);
                    console.log(`pic url: ${typeof pic === 'string' ? pic.substring(0, 30) + '...' : pic}`);
                } catch(e) {
                    console.log(`[DIAG] getProfilePicUrl ERROR: ${e.name} ${e.message}`);
                }
            }
            
            process.exit(0);
        } catch (e) {
            console.error('[DIAG] Error:', e);
            process.exit(1);
        }
    });

    console.log('[DIAG] Initializing...');
    client.initialize();
}

run();
