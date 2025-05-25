import { existsSync } from 'fs';
import { readFile, writeFile, readdir, unlink, mkdir } from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import type { 
  BatchOperation, 
  BatchItem, 
  BatchOptions,
  ItemStatus 
} from './types.js';
import { readTrackingData, type WorkspaceInfo as TrackedWorkspaceInfo } from '../../rmplan/workspace/workspace_tracker.js';

interface BatchState {
  operation: BatchOperation;
  savedAt: Date;
  checkpoint: {
    completedItems: string[];
    failedItems: string[];
    workspaceStates: Map<string, WorkspaceState>;
  };
}

interface WorkspaceState {
  id: string;
  path: string;
  branch: string;
  hasUncommittedChanges: boolean;
  lastCommit?: string;
}

export class BatchRecoveryHandler {
  private stateDir: string;
  
  constructor(
    stateDir: string = path.join(process.env.HOME!, '.rmfilter/batch-states')
  ) {
    this.stateDir = stateDir;
  }
  
  async saveBatchState(batch: BatchOperation): Promise<void> {
    const statePath = this.getStatePath(batch.id);
    
    // Collect workspace states
    const workspaceStates = new Map<string, WorkspaceState>();
    
    for (const item of batch.items) {
      if (item.workspaceId && item.status === 'running') {
        const state = await this.captureWorkspaceState(item.workspaceId);
        if (state) {
          workspaceStates.set(item.workspaceId, state);
        }
      }
    }
    
    const state: BatchState = {
      operation: batch,
      savedAt: new Date(),
      checkpoint: {
        completedItems: batch.items
          .filter(i => i.status === 'completed')
          .map(i => i.id),
        failedItems: batch.items
          .filter(i => i.status === 'failed')
          .map(i => i.id),
        workspaceStates
      }
    };
    
    // Ensure directory exists
    const dir = path.dirname(statePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    
    // Save state
    await writeFile(statePath, JSON.stringify(state, null, 2));
  }
  
  async loadBatchState(batchId: string): Promise<BatchState | null> {
    const statePath = this.getStatePath(batchId);
    
    if (!existsSync(statePath)) {
      return null;
    }
    
    try {
      const content = await readFile(statePath, 'utf-8');
      const state = JSON.parse(content) as BatchState;
      
      // Convert dates
      state.savedAt = new Date(state.savedAt);
      state.operation.progress.startTime = new Date(state.operation.progress.startTime);
      if (state.operation.progress.estimatedCompletion) {
        state.operation.progress.estimatedCompletion = new Date(state.operation.progress.estimatedCompletion);
      }
      
      // Reconstruct Map
      if (state.checkpoint.workspaceStates && !(state.checkpoint.workspaceStates instanceof Map)) {
        state.checkpoint.workspaceStates = new Map(Object.entries(state.checkpoint.workspaceStates as any));
      }
      
      return state;
    } catch (error) {
      console.error(`Failed to load batch state for ${batchId}:`, error);
      return null;
    }
  }
  
  async recoverBatch(batchId: string): Promise<BatchOperation | null> {
    const state = await this.loadBatchState(batchId);
    if (!state) {
      return null;
    }
    
    const { operation, checkpoint } = state;
    
    // Identify items that need recovery
    const itemsToRecover: BatchItem[] = [];
    const completedSet = new Set(checkpoint.completedItems);
    const failedSet = new Set(checkpoint.failedItems);
    
    for (const item of operation.items) {
      if (completedSet.has(item.id)) {
        // Already completed
        item.status = 'completed';
      } else if (failedSet.has(item.id)) {
        // Previously failed - include in recovery if retryable
        item.status = 'pending';
        itemsToRecover.push(item);
      } else if (item.status === 'running') {
        // Was running - check if can resume
        const canResume = await this.checkWorkspaceRecoverable(
          item,
          checkpoint.workspaceStates.get(item.workspaceId || '')
        );
        
        if (canResume) {
          // Can continue from where it left off
          item.status = 'running';
        } else {
          // Need to restart
          item.status = 'pending';
          item.workspaceId = undefined;
        }
        itemsToRecover.push(item);
      } else if (item.status === 'pending') {
        // Not started yet
        itemsToRecover.push(item);
      }
    }
    
    // Create recovery batch
    const recoveryBatch: BatchOperation = {
      id: `${batchId}-recovery-${Date.now()}`,
      type: operation.type,
      items: itemsToRecover,
      options: {
        ...operation.options,
        isRecovery: true
      },
      status: 'pending',
      progress: {
        total: itemsToRecover.length,
        completed: 0,
        failed: 0,
        running: 0,
        skipped: 0,
        startTime: new Date()
      },
      results: {
        successful: [],
        failed: [],
        skipped: [],
        summary: {
          totalItems: itemsToRecover.length,
          successCount: 0,
          failureCount: 0,
          skippedCount: 0,
          duration: 0,
          byType: new Map()
        }
      }
    };
    
    return recoveryBatch;
  }
  
  private async captureWorkspaceState(workspaceId: string): Promise<WorkspaceState | null> {
    try {
      // For batch workspaces, we use a simpler approach
      // The workspace path is stored in the item's workspaceId
      const workspacePath = workspaceId; // In our implementation, workspaceId is the path
      
      if (!existsSync(workspacePath)) return null;
      
      const status = await this.getGitStatus(workspacePath);
      const branch = execSync('git branch --show-current', {
        cwd: workspacePath,
        encoding: 'utf-8'
      }).trim();
      
      return {
        id: workspaceId,
        path: workspacePath,
        branch: branch || 'main',
        hasUncommittedChanges: !status.isClean,
        lastCommit: status.lastCommit
      };
    } catch (error) {
      console.error(`Failed to capture workspace state for ${workspaceId}:`, error);
      return null;
    }
  }
  
  private async checkWorkspaceRecoverable(
    item: BatchItem,
    workspaceState?: WorkspaceState
  ): Promise<boolean> {
    if (!item.workspaceId || !workspaceState) {
      return false;
    }
    
    try {
      // Check if workspace still exists
      if (!existsSync(workspaceState.path)) {
        return false;
      }
      
      // Check git status
      const currentStatus = await this.getGitStatus(workspaceState.path);
      
      // Can recover if:
      // 1. No uncommitted changes, OR
      // 2. Has uncommitted changes but they match what we expect
      if (currentStatus.isClean) {
        return true;
      }
      
      // If we had uncommitted changes before and still do, might be recoverable
      if (workspaceState.hasUncommittedChanges && !currentStatus.isClean) {
        // Check if it's the same work in progress
        return currentStatus.lastCommit === workspaceState.lastCommit;
      }
      
      return false;
    } catch (error) {
      console.error(`Failed to check workspace ${item.workspaceId}:`, error);
      return false;
    }
  }
  
  private async getGitStatus(workspacePath: string): Promise<{ 
    isClean: boolean; 
    lastCommit?: string;
  }> {
    try {
      const status = execSync('git status --porcelain', {
        cwd: workspacePath,
        encoding: 'utf-8'
      });
      
      const lastCommit = execSync('git rev-parse HEAD', {
        cwd: workspacePath,
        encoding: 'utf-8'
      }).trim();
      
      return {
        isClean: status.trim().length === 0,
        lastCommit
      };
    } catch (error) {
      return { isClean: false };
    }
  }
  
  private getStatePath(batchId: string): string {
    return path.join(this.stateDir, `${batchId}.json`);
  }
  
  async listRecoverableBatches(): Promise<Array<{
    batchId: string;
    savedAt: Date;
    totalItems: number;
    status: string;
  }>> {
    if (!existsSync(this.stateDir)) {
      return [];
    }
    
    const files = await readdir(this.stateDir);
    const batches = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const batchId = path.basename(file, '.json');
        const state = await this.loadBatchState(batchId);
        
        if (state) {
          batches.push({
            batchId,
            savedAt: state.savedAt,
            totalItems: state.operation.items.length,
            status: state.operation.status
          });
        }
      }
    }
    
    return batches.sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
  }
  
  async cleanupOldStates(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<void> {
    const batches = await this.listRecoverableBatches();
    const cutoff = Date.now() - maxAge;
    
    for (const batch of batches) {
      if (batch.savedAt.getTime() < cutoff) {
        const statePath = this.getStatePath(batch.batchId);
        try {
          await unlink(statePath);
        } catch (error) {
          console.error(`Failed to cleanup state ${batch.batchId}:`, error);
        }
      }
    }
  }
}