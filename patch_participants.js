const fs = require('fs');

const path = 'whatsappService.js';
let content = fs.readFileSync(path, 'utf8');

// Replace participantsCount logic in resolveGroupMetadata
content = content.replace(
    /if \(typeof participantsCount === 'number' && participantsCount <= 0\) {\s*participantsCount = null;\s*}/,
    `if (typeof participantsCount === 'number' && participantsCount < 0) {
        participantsCount = null;
    }`
);
content = content.replace(
    /if \(typeof participantsCount !== 'number' \|\| participantsCount <= 0\) {/,
    `if (!Number.isInteger(participantsCount) || participantsCount < 0) {`
);

// Add _startParticipantEnrichment
const participantEnrichmentCode = `
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
    const CONCURRENCY = 2;
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
        console.log(\`[PARTICIPANT_SYNC_SUMMARY] total=\${this.participantSync.total} success=\${this.participantSync.success} failed=\${this.participantSync.failed} pending=\${this.participantSync.pending}\`);
    }
  }

  async _processParticipantItem(item, syncId) {
    if (this.participantSyncId !== syncId) return;
    
    item.attempts++;
    item.status = 'loading';
    
    let result = null;
    let errMessage = null;

    try {
        const fetchPromise = this.resolveGroupMetadata(item.id, false, false);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT:resolveGroupMetadata')), 12000));
        result = await Promise.race([fetchPromise, timeoutPromise]);
    } catch(err) {
        errMessage = err.message;
    }

    if (this.participantSyncId !== syncId) return;

    const RETRY_DELAYS = [0, 3000, 7000, 15000];
    const maxAttempts = RETRY_DELAYS.length;
    
    if (result && Number.isInteger(result.participantsCount) && result.participantsCount >= 0) {
        const cached = this.groupCache.get(item.id) || {};
        cached.participantsCount = result.participantsCount;
        cached.participantStatus = 'success';
        this.groupCache.set(item.id, cached);
        
        this.participantSync.success++;
        
        console.log(\`[PARTICIPANT_SYNC] groupId=\${item.id} count=\${result.participantsCount} status=success source=\${result.participantsSource}\`);
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
            
            console.log(\`[PARTICIPANT_SYNC] groupId=\${item.id} count=null status=failed source=none\`);
            this.io?.emit('wa:group_enriched', cached);
        }
    }

    this.participantSync.processed = this.participantSync.success + this.participantSync.failed;
    this.participantSync.pending = this.participantSync.total - this.participantSync.processed;
    this.participantSync.percentage = Math.floor((this.participantSync.processed / (this.participantSync.total || 1)) * 100);
    this._emitParticipantSyncProgress();
  }
`;

// Insert the code before `async _startEnrichment(groups) {`
content = content.replace(
    '  async _startEnrichment(groups) {',
    participantEnrichmentCode + '\n  async _startEnrichment(groups) {'
);

// Call `this._startParticipantEnrichment(groups)` inside `getGroups`
content = content.replace(
    /this\._startEnrichment\(groups\)\.catch\(e => console\.error\('\[GROUPS_DETAILS\] Enrichment background error:', e\)\);/,
    `this._startEnrichment(groups).catch(e => console.error('[GROUPS_DETAILS] Photo Enrichment error:', e));
      this._startParticipantEnrichment(groups).catch(e => console.error('[GROUPS_DETAILS] Participant Enrichment error:', e));`
);

fs.writeFileSync(path, content);
