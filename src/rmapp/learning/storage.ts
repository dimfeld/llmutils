import type { LearningEvent, LearningModel } from './types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface EventStorage {
  saveEvents(events: LearningEvent[]): Promise<void>;
  findById(id: string): Promise<LearningEvent | null>;
  findByActionId(actionId: string): Promise<LearningEvent | null>;
  findByTimeRange(start: Date, end: Date): Promise<LearningEvent[]>;
  updateEvent(event: LearningEvent): Promise<void>;
  getStats(): Promise<StorageStats>;
}

export interface ModelStorage {
  save(model: LearningModel): Promise<void>;
  loadLatest(): Promise<LearningModel | null>;
  loadVersion(version: number): Promise<LearningModel | null>;
  listVersions(): Promise<ModelVersion[]>;
  cleanup(keepVersions: number): Promise<void>;
}

interface StorageStats {
  totalEvents: number;
  eventsByType: Record<string, number>;
  oldestEvent?: Date;
  newestEvent?: Date;
  storageSize: number;
}

interface ModelVersion {
  version: number;
  createdAt: Date;
  size: number;
  path: string;
}

export class FileEventStorage implements EventStorage {
  private indexPath: string;
  private eventsDir: string;
  private index: Map<string, EventIndexEntry> = new Map();
  
  constructor(private basePath: string) {
    this.eventsDir = path.join(basePath, 'events');
    this.indexPath = path.join(basePath, 'events.index.json');
  }
  
  async initialize(): Promise<void> {
    await fs.mkdir(this.eventsDir, { recursive: true });
    await this.loadIndex();
  }
  
  async saveEvents(events: LearningEvent[]): Promise<void> {
    for (const event of events) {
      const filePath = this.getEventPath(event);
      
      // Save event file
      await fs.writeFile(
        filePath,
        JSON.stringify(event, null, 2),
        'utf-8'
      );
      
      // Update index
      this.index.set(event.id, {
        id: event.id,
        actionId: event.action.id,
        type: event.type,
        timestamp: event.timestamp,
        path: filePath
      });
    }
    
    await this.saveIndex();
  }
  
  async findById(id: string): Promise<LearningEvent | null> {
    const entry = this.index.get(id);
    if (!entry) return null;
    
    try {
      const content = await fs.readFile(entry.path, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  
  async findByActionId(actionId: string): Promise<LearningEvent | null> {
    for (const entry of this.index.values()) {
      if (entry.actionId === actionId) {
        return this.findById(entry.id);
      }
    }
    return null;
  }
  
  async findByTimeRange(start: Date, end: Date): Promise<LearningEvent[]> {
    const events: LearningEvent[] = [];
    
    for (const entry of this.index.values()) {
      const timestamp = new Date(entry.timestamp);
      if (timestamp >= start && timestamp <= end) {
        const event = await this.findById(entry.id);
        if (event) {
          events.push(event);
        }
      }
    }
    
    return events.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }
  
  async updateEvent(event: LearningEvent): Promise<void> {
    await this.saveEvents([event]);
  }
  
  async getStats(): Promise<StorageStats> {
    const stats: StorageStats = {
      totalEvents: this.index.size,
      eventsByType: {},
      storageSize: 0
    };
    
    // Count by type
    for (const entry of this.index.values()) {
      stats.eventsByType[entry.type] = (stats.eventsByType[entry.type] || 0) + 1;
    }
    
    // Find date range
    const timestamps = Array.from(this.index.values())
      .map(e => new Date(e.timestamp).getTime());
      
    if (timestamps.length > 0) {
      stats.oldestEvent = new Date(Math.min(...timestamps));
      stats.newestEvent = new Date(Math.max(...timestamps));
    }
    
    // Calculate storage size
    try {
      const files = await fs.readdir(this.eventsDir);
      for (const file of files) {
        const stat = await fs.stat(path.join(this.eventsDir, file));
        stats.storageSize += stat.size;
      }
    } catch {
      // Ignore errors
    }
    
    return stats;
  }
  
  private getEventPath(event: LearningEvent): string {
    const date = new Date(event.timestamp);
    const dateStr = date.toISOString().split('T')[0];
    const fileName = `${dateStr}_${event.id}.json`;
    return path.join(this.eventsDir, fileName);
  }
  
  private async loadIndex(): Promise<void> {
    try {
      const content = await fs.readFile(this.indexPath, 'utf-8');
      const entries: EventIndexEntry[] = JSON.parse(content);
      
      this.index.clear();
      for (const entry of entries) {
        this.index.set(entry.id, entry);
      }
    } catch {
      // Index doesn't exist yet
    }
  }
  
  private async saveIndex(): Promise<void> {
    const entries = Array.from(this.index.values());
    await fs.writeFile(
      this.indexPath,
      JSON.stringify(entries, null, 2),
      'utf-8'
    );
  }
}

interface EventIndexEntry {
  id: string;
  actionId: string;
  type: string;
  timestamp: Date;
  path: string;
}

export class FileModelStorage implements ModelStorage {
  private modelsDir: string;
  
  constructor(private basePath: string) {
    this.modelsDir = path.join(basePath, 'models');
  }
  
  async initialize(): Promise<void> {
    await fs.mkdir(this.modelsDir, { recursive: true });
  }
  
  async save(model: LearningModel): Promise<void> {
    const fileName = `model_v${model.version}.json`;
    const filePath = path.join(this.modelsDir, fileName);
    
    await fs.writeFile(
      filePath,
      JSON.stringify(model, null, 2),
      'utf-8'
    );
    
    // Update latest symlink
    const latestPath = path.join(this.modelsDir, 'latest.json');
    try {
      await fs.unlink(latestPath);
    } catch {
      // Ignore if doesn't exist
    }
    await fs.symlink(fileName, latestPath);
  }
  
  async loadLatest(): Promise<LearningModel | null> {
    try {
      const latestPath = path.join(this.modelsDir, 'latest.json');
      const content = await fs.readFile(latestPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      // Try to find the highest version
      const versions = await this.listVersions();
      if (versions.length === 0) return null;
      
      const latest = versions.sort((a, b) => b.version - a.version)[0];
      return this.loadVersion(latest.version);
    }
  }
  
  async loadVersion(version: number): Promise<LearningModel | null> {
    try {
      const fileName = `model_v${version}.json`;
      const filePath = path.join(this.modelsDir, fileName);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  
  async listVersions(): Promise<ModelVersion[]> {
    const versions: ModelVersion[] = [];
    
    try {
      const files = await fs.readdir(this.modelsDir);
      
      for (const file of files) {
        const match = file.match(/^model_v(\d+)\.json$/);
        if (match) {
          const version = parseInt(match[1], 10);
          const filePath = path.join(this.modelsDir, file);
          const stat = await fs.stat(filePath);
          
          versions.push({
            version,
            createdAt: stat.mtime,
            size: stat.size,
            path: filePath
          });
        }
      }
    } catch {
      // Directory doesn't exist
    }
    
    return versions.sort((a, b) => b.version - a.version);
  }
  
  async cleanup(keepVersions: number): Promise<void> {
    const versions = await this.listVersions();
    
    if (versions.length <= keepVersions) return;
    
    // Keep the newest versions
    const toDelete = versions.slice(keepVersions);
    
    for (const version of toDelete) {
      try {
        await fs.unlink(version.path);
      } catch (error) {
        console.error(`Failed to delete model version ${version.version}:`, error);
      }
    }
  }
}