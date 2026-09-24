require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');

async function testGroup() {
    console.log('[QR_FLOW] starting client to test ONE GROUP');

    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: './whatsapp-auth' }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        }
    });

    client.on('qr', () => {
        console.log('Needs QR scan.');
        process.exit(1);
    });

    client.on('ready', async () => {
        console.log('[QR_FLOW] ready');
        
        try {
            const versionInfo = await client.pupPage.evaluate(() => {
                return {
                    requested: '2.2412.54',
                    loaded: window.Debug?.VERSION || 'unknown'
                };
            });
            console.log('[WA_VERSION_DIAGNOSTIC]');
            console.log(`configured=2.2412.54`);
            console.log(`cacheType=remote`);
            console.log(`remoteURL=https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html`);
            console.log(`effectiveVersion=${versionInfo.loaded}`);
        } catch(e) {}

        const groupId = '120363359964959175@g.us';

        try {
            const rawDiag = await client.pupPage.evaluate(async (gId) => {
                let chat = null;
                if (window.WAWebCollections && window.WAWebCollections.Chat) chat = window.WAWebCollections.Chat.get(gId);
                
                let metadataExists = false;
                let participantsExists = false;
                let participantsType = 'none';
                let count = 0;
                let source = 'none';

                if (chat) {
                    if (chat.participants) {
                        metadataExists = true;
                        participantsExists = true;
                        if (Array.isArray(chat.participants)) {
                            participantsType = 'array';
                            count = chat.participants.length;
                            source = 'chat.participants.length';
                        } else if (typeof chat.participants.getModelsArray === 'function') {
                            participantsType = 'collection.getModelsArray()';
                            count = chat.participants.getModelsArray().length;
                            source = 'chat.participants.getModelsArray().length';
                        } else if (Array.isArray(chat.participants._models)) {
                            participantsType = 'collection._models';
                            count = chat.participants._models.length;
                            source = 'chat.participants._models.length';
                        }
                    } else if (chat.groupMetadata && chat.groupMetadata.participants) {
                        metadataExists = true;
                        participantsExists = true;
                        const p = chat.groupMetadata.participants;
                        if (Array.isArray(p)) {
                            participantsType = 'array';
                            count = p.length;
                            source = 'chat.groupMetadata.participants.length';
                        } else if (typeof p.getModelsArray === 'function') {
                            participantsType = 'collection.getModelsArray()';
                            count = p.getModelsArray().length;
                            source = 'chat.groupMetadata.participants.getModelsArray().length';
                        } else if (Array.isArray(p._models)) {
                            participantsType = 'collection._models';
                            count = p._models.length;
                            source = 'chat.groupMetadata.participants._models.length';
                        }
                    }
                }

                if (count === 0) {
                    if (window.Store && window.Store.GroupMetadata) {
                        try { await window.Store.GroupMetadata.update(gId); } catch(e){}
                        const meta = window.Store.GroupMetadata.get(gId);
                        if (meta && meta.participants) {
                            metadataExists = true;
                            participantsExists = true;
                            const p = meta.participants;
                            if (Array.isArray(p)) {
                                participantsType = 'array';
                                count = p.length;
                                source = 'Store.GroupMetadata.participants.length';
                            } else if (typeof p.getModelsArray === 'function') {
                                participantsType = 'collection.getModelsArray()';
                                count = p.getModelsArray().length;
                                source = 'Store.GroupMetadata.participants.getModelsArray().length';
                            } else if (Array.isArray(p._models)) {
                                participantsType = 'collection._models';
                                count = p._models.length;
                                source = 'Store.GroupMetadata.participants._models.length';
                            }
                        }
                    }
                }

                return {
                    groupId: gId,
                    exists: !!chat,
                    keys: chat ? Object.keys(chat).filter(k => !k.startsWith('_')).slice(0, 5) : [],
                    isGroup: chat ? !!chat.isGroup : false,
                    metadataExists,
                    participantsExists,
                    participantsType,
                    count,
                    source
                };

            }, groupId);
            
            console.log('\n[PARTICIPANTS_RUNTIME]');
            console.log(`groupId=${rawDiag.groupId}`);
            console.log(`metadataExists=${rawDiag.metadataExists}`);
            console.log(`participantsExists=${rawDiag.participantsExists}`);
            console.log(`participantsType=${rawDiag.participantsType}`);
            console.log(`count=${rawDiag.count}`);
            console.log(`source=${rawDiag.source}`);

        } catch (e) {
            console.log('Error during participants diag:', e.message);
        }

        try {
            const photoDiag = await client.pupPage.evaluate(async (gId) => {
                const availableModules = [];
                let selectedModule = 'none';
                let selectedMethod = 'none';
                let url = null;
                let success = false;
                let errorStr = null;

                if (window.Store && window.Store.ProfilePic) availableModules.push('Store.ProfilePic');
                if (window.Store && window.Store.ProfilePicThumb) availableModules.push('Store.ProfilePicThumb');
                if (window.WAWebCollections && window.WAWebCollections.ProfilePic) availableModules.push('WAWebCollections.ProfilePic');

                const thumbModule = (window.Store && window.Store.ProfilePicThumb) || (window.WAWebCollections && window.WAWebCollections.ProfilePicThumb);
                if (thumbModule) {
                    selectedModule = 'ProfilePicThumb';
                    try {
                        let t = thumbModule.get(gId);
                        if (!t && typeof thumbModule.find === 'function') {
                            selectedMethod = 'find()';
                            t = await thumbModule.find(gId);
                        } else {
                            selectedMethod = 'get()';
                        }
                        
                        if (t && t.img) { url = t.img; success = true; }
                        else if (t && t.eurl) { url = t.eurl; success = true; }
                    } catch(e) {
                        errorStr = e.message;
                    }
                }

                return { availableModules, selectedModule, selectedMethod, success, url, source: selectedModule + '.' + selectedMethod, error: errorStr };
            }, groupId);

            console.log('\n[PHOTO_MODULE_RUNTIME]');
            console.log(`availableModules=[${photoDiag.availableModules.join(', ')}]`);
            console.log(`selectedModule=${photoDiag.selectedModule}`);
            console.log(`selectedMethod=${photoDiag.selectedMethod}`);
            
            console.log('\n[PHOTO_RUNTIME]');
            console.log(`groupId=${groupId}`);
            console.log(`success=${photoDiag.success}`);
            console.log(`url=${photoDiag.url}`);
            console.log(`source=${photoDiag.source}`);
            console.log(`error=${photoDiag.error}`);

            if (photoDiag.url) {
                const fetch = (await import('node-fetch')).default;
                const r = await fetch(photoDiag.url);
                console.log(`\nHTTP STATUS: ${r.status}`);
                console.log(`Content-Type: ${r.headers.get('content-type')}`);
            }

        } catch (e) {
            console.log('Error during photo diag:', e.message);
        }

        console.log('\nTest finished.');
        process.exit(0);
    });

    client.initialize();
}

testGroup();
