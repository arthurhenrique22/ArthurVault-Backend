const fs = require('fs');

const path = 'whatsappService.js';
let content = fs.readFileSync(path, 'utf8');

// Fix _getChatsFallback
content = content.replace(
    /let participantCount = 0;/g,
    `let participantCount = null;`
);

// We need to replace resolveGroupMetadata entirely with resolveParticipantsCount and resolveGroupPhoto.
const resolveMethods = `
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
                
                if (chatModel && Array.isArray(chatModel.participants)) {
                    return { count: chatModel.participants.length, source: 'Chat.participants.array' };
                }
                
                let metadata = null;
                if (window.Store?.GroupMetadata) metadata = window.Store.GroupMetadata.get(gId);
                if (!metadata && window.WAWebCollections?.GroupMetadata) metadata = window.WAWebCollections.GroupMetadata.get(gId);
                
                if (metadata && Array.isArray(metadata.participants)) {
                    return { count: metadata.participants.length, source: 'GroupMetadata.participants.array' };
                }

                // If exists but no participants, try to hydrate
                const col = window.WAWebCollections?.GroupMetadata || window.Store?.GroupMetadata;
                if (col && typeof col.update === 'function') {
                    try {
                        await col.update(gId);
                        let updated = col.get(gId);
                        if (updated && Array.isArray(updated.participants)) {
                            return { count: updated.participants.length, source: 'GroupMetadata.update.array' };
                        }
                    } catch(e) {}
                }

                if (window.WWebJS?.getChatModel) {
                    try {
                        const wwebChat = window.WWebJS.getChatModel(gId);
                        if (wwebChat && Array.isArray(wwebChat.participants)) {
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
`;

// Inject methods after normalizeGroupId
content = content.replace(
    /normalizeGroupId\(value\) {[\s\S]*?return String\(value\);\s*}/,
    match => match + '\n' + resolveMethods
);

// Update _processParticipantItem
content = content.replace(
    /const fetchPromise = this\.resolveGroupMetadata\(item\.id, false, false\);/g,
    `const fetchPromise = this.resolveParticipantsCount(item.id);`
);

content = content.replace(
    /if \(result && Number\.isInteger\(result\.participantsCount\) && result\.participantsCount >= 0\) {/g,
    `if (result && result.status === 'success' && Number.isInteger(result.count) && result.count >= 0) {`
);

content = content.replace(
    /cached\.participantsCount = result\.participantsCount;/g,
    `cached.participantsCount = result.count;`
);

content = content.replace(
    /count=\$\{result\.participantsCount\}/g,
    `count=\$\{result.count\}`
);

content = content.replace(
    /source=\$\{result\.participantsSource\}/g,
    `source=\$\{result.source\}`
);

// Update _processPhotoItem
content = content.replace(
    /const fetchPromise = this\.resolveGroupMetadata\(item\.id, false, true\);/g,
    `const fetchPromise = this.resolveGroupPhoto(item.id);`
);

content = content.replace(
    /if \(result && typeof result\.photoUrl === 'string'\) {/g,
    `if (result && result.status === 'success' && typeof result.url === 'string') {`
);

content = content.replace(
    /cached\.originalPhotoUrl = result\.photoUrl;/g,
    `cached.originalPhotoUrl = result.url;`
);

content = content.replace(
    /\} else if \(result && result\.photoUrl === null && result\.photoSource !== 'none' && result\.photoSource !== 'evaluate\.failed'\) {/g,
    `} else if (result && result.status === 'no_photo') {`
);

// Adjust concurrency
content = content.replace(
    /const PHOTO_CONCURRENCY = 2;/g,
    `const PHOTO_CONCURRENCY = 3;`
);

content = content.replace(
    /const CONCURRENCY = 2;/g,
    `const CONCURRENCY = 5;`
);

fs.writeFileSync(path, content);
