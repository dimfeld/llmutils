import type { Context, ContextFilter } from './types.js';

export interface ContextProvider {
  type: string;
  
  // Initialize the provider
  initialize(): Promise<void>;
  
  // Check if provider is available
  isAvailable(): Promise<boolean>;
  
  // Gather contexts based on options
  gather(options: {
    query?: string;
    filters?: ContextFilter[];
    limit?: number;
  }): Promise<Context[]>;
  
  // List all available contexts
  list(): Promise<Context[]>;
  
  // Get a specific context by ID
  get(id: string): Promise<Context | undefined>;
  
  // Refresh/update contexts
  refresh?(): Promise<void>;
}

export abstract class BaseContextProvider implements ContextProvider {
  abstract type: string;
  
  async initialize(): Promise<void> {
    // Default implementation - override if needed
  }
  
  async isAvailable(): Promise<boolean> {
    // Default implementation - override if needed
    return true;
  }
  
  abstract gather(options: {
    query?: string;
    filters?: ContextFilter[];
    limit?: number;
  }): Promise<Context[]>;
  
  abstract list(): Promise<Context[]>;
  
  async get(id: string): Promise<Context | undefined> {
    const contexts = await this.list();
    return contexts.find(c => c.id === id);
  }
  
  async refresh(): Promise<void> {
    // Default implementation - override if needed
  }
}