const fs = require('fs');
const content = fs.readFileSync('whatsappService.js', 'utf8');
const lines = content.split('\n');
const startIdx = lines.findIndex(l => l.includes('async _startEnrichment(groups) {'));
const endIdx = lines.findIndex(l => l.includes('onDemandPhotoLocks = new Map()'));

const newContent = `  async _startEnrichment(groups) {
    if (!this.client || this.status !== 'READY') return;

    const photoGroups = groups.filter(
        group => typeof group.id === 'string' && group.id.endsWith('@g.us')
    );
    
    console.log(\`\\n[GROUP_PHOTO_QUEUE]\`);
    console.log(\`totalGroups=\${photoGroups.length}\`);
    console.log(\`invalidIds=\${groups.length - photoGroups.length}\`);
    console.log(\`participantPhotoRequests=0\`);

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
          
          console.log(\`[GROUP_PHOTO_PROGRESS] syncId=\${this.photoSync.syncId} processed=\${this.photoSync.processed}/\${this.photoSync.total} success=\${this.photoSync.success} noPhoto=\${this.photoSync.noPhoto} failed=\${this.photoSync.failed} percentage=\${this.photoSync.percentage} queue=\${this.photoRetryQueue.length}\`);
      }
  }

  async _processPhotoQueue(syncId) {
    const PHOTO_CONCURRENCY = 2;
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
        console.log(\`\\n[GROUP_PHOTO_SYNC_COMPLETE]\`);
        console.log(\`total=\${this.photoSync.total}\`);
        console.log(\`success=\${this.photoSync.success}\`);
        console.log(\`noPhoto=\${this.photoSync.noPhoto}\`);
        console.log(\`failed=\${this.photoSync.failed}\`);
    }
  }

  async _processPhotoItem(item, syncId) {
    if (this.photoSyncId !== syncId) return;
    
    item.attempts++;
    item.status = 'loading';
    console.log(\`\\n[GROUP_PHOTO]\`);
    console.log(\`id=\${item.id}\`);
    console.log(\`attempt=\${item.attempts}\`);
    console.log(\`status=loading\`);
    
    const startMs = Date.now();
    let result = null;
    let errMessage = null;

    try {
        const fetchPromise = this.resolveGroupMetadata(item.id, false, true);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT:resolveGroupMetadata')), 12000));
        result = await Promise.race([fetchPromise, timeoutPromise]);
    } catch(err) {
        errMessage = err.message;
    }

    if (this.photoSyncId !== syncId) return;

    const RETRY_DELAYS = [0, 3000, 7000, 15000];
    const maxAttempts = RETRY_DELAYS.length;
    
    if (result && typeof result.photoUrl === 'string') {
        const proxyPhotoUrl = \`\${process.env.PUBLIC_URL || 'https://arthurvault-backend-production.up.railway.app'}/api/group-photo/\${encodeURIComponent(item.id)}?v=\${Date.now()}\`;
        const cached = this.groupCache.get(item.id) || {};
        cached.photoUrl = proxyPhotoUrl;
        cached.originalPhotoUrl = result.photoUrl;
        cached.photoStatus = 'success';
        this.groupCache.set(item.id, cached);
        
        this.photoSync.success++;
        
        console.log(\`[GROUP_PHOTO]\`);
        console.log(\`id=\${item.id}\`);
        console.log(\`attempt=\${item.attempts}\`);
        console.log(\`status=success\`);
        console.log(\`durationMs=\${Date.now() - startMs}\`);

        this.io?.emit('wa:group_enriched', cached);
    } else if (result && result.photoUrl === null && result.photoSource !== 'none' && result.photoSource !== 'evaluate.failed') {
        const cached = this.groupCache.get(item.id) || {};
        cached.photoStatus = 'no_photo';
        this.groupCache.set(item.id, cached);

        this.photoSync.noPhoto++;
        
        console.log(\`[GROUP_PHOTO]\`);
        console.log(\`id=\${item.id}\`);
        console.log(\`status=no_photo\`);

        this.io?.emit('wa:group_enriched', cached);
    } else {
        if (item.attempts < maxAttempts) {
            item.status = 'retrying';
            item.nextTry = Date.now() + RETRY_DELAYS[item.attempts];
            this.photoRetryQueue.push(item);
            
            console.log(\`[GROUP_PHOTO]\`);
            console.log(\`id=\${item.id}\`);
            console.log(\`attempt=\${item.attempts}\`);
            console.log(\`status=retrying\`);
            console.log(\`reason=\${errMessage || 'no_url_found'}\`);
            return;
        } else {
            const cached = this.groupCache.get(item.id) || {};
            cached.photoStatus = 'failed';
            this.groupCache.set(item.id, cached);

            this.photoSync.failed++;
            
            console.log(\`[GROUP_PHOTO]\`);
            console.log(\`id=\${item.id}\`);
            console.log(\`attempt=\${item.attempts}\`);
            console.log(\`status=failed_final\`);
            
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
`;

lines.splice(startIdx, endIdx - startIdx, newContent);
fs.writeFileSync('whatsappService.js', lines.join('\n'));
console.log('Patched whatsappService.js');
