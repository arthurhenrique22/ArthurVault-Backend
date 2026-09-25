const whatsappService = require('./whatsappService');
(async () => {
    try {
        console.log("Starting WhatsApp...");
        await whatsappService.initialize();
        console.log("Waiting for ready...");
        while (whatsappService.status !== 'READY') {
            await new Promise(r => setTimeout(r, 1000));
            if (whatsappService.status === 'ERROR') {
                console.error("Error connecting");
                process.exit(1);
            }
        }
        console.log("READY! Getting chats...");
        const chats = await whatsappService.client.getChats();
        const groups = chats.filter(c => c.isGroup);
        console.log(`Found ${groups.length} groups.`);
        if (groups.length > 0) {
            const g = groups[0];
            console.log("=== GROUP DIAGNOSTIC ===");
            console.log("ID:", g.id._serialized);
            console.log("Name:", g.name);
            console.log("Keys in chat:", Object.keys(g).join(', '));
            console.log("Participants type:", typeof g.participants);
            console.log("Participants isArray:", Array.isArray(g.participants));
            if (g.participants) {
                console.log("Participants keys:", Object.keys(g.participants).join(', '));
                if (g.participants.length !== undefined) console.log("length:", g.participants.length);
            }
            if (g.groupMetadata) {
                console.log("GroupMetadata keys:", Object.keys(g.groupMetadata).join(', '));
                if (g.groupMetadata.participants) {
                    console.log("GroupMetadata participants length:", g.groupMetadata.participants.length);
                }
            }
            
            // Try pupPage eval
            const pupEval = await whatsappService.client.pupPage.evaluate((groupId) => {
                const wwebjs = window.WWebJS;
                const result = {
                    hasWWebJS: !!wwebjs,
                    methods: wwebjs ? Object.keys(wwebjs).join(', ') : '',
                };
                try {
                    if (wwebjs && wwebjs.getChatModel) {
                        const chat = wwebjs.getChatModel(groupId);
                        if (chat) {
                            result.chatKeys = Object.keys(chat).join(', ');
                            if (chat.participants) result.chatParticipantsType = typeof chat.participants;
                        }
                    }
                } catch(e) { result.chatError = e.message; }
                
                try {
                    const store = window.Store;
                    if (store) {
                        result.hasStore = true;
                        result.storeKeys = Object.keys(store).filter(k => !k.startsWith('_')).slice(0, 15).join(', ');
                    }
                } catch(e) {}
                
                try {
                    const pic = window.WAWebCollections;
                    if (pic) {
                        result.hasWAWebCollections = true;
                        result.waWebCollectionsKeys = Object.keys(pic).filter(k => !k.startsWith('_')).slice(0, 15).join(', ');
                    }
                } catch(e) {}

                return result;
            }, g.id._serialized);
            
            console.log("Puppeteer Eval:", pupEval);
        }
        process.exit(0);
    } catch (e) {
         console.error(e);
         process.exit(1);
    }
})();
