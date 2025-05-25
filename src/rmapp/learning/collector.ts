import type {
  LearningEvent,
  EventType,
  Outcome,
  EventContext,
  Action
} from './types.js';
import { EventStorage } from './storage.js';
import { createHash } from 'node:crypto';

export interface CollectorOptions {
  bufferSize?: number;
  flushInterval?: number;
  validateEvents?: boolean;
}

interface EventProcessor {
  process(events: LearningEvent[]): Promise<void>;
}

export class LearningEventCollector {
  private buffer: LearningEvent[] = [];
  private flushInterval?: NodeJS.Timeout;
  private processors: Map<EventType, EventProcessor> = new Map();
  
  constructor(
    private storage: EventStorage,
    private options: CollectorOptions = {}
  ) {
    this.startFlushTimer();
  }
  
  async collectEvent(event: Partial<LearningEvent>): Promise<void> {
    const fullEvent: LearningEvent = {
      id: event.id || this.generateId(),
      timestamp: event.timestamp || new Date(),
      type: event.type!,
      context: event.context || {},
      action: event.action!,
      outcome: event.outcome!,
      feedback: event.feedback
    };
    
    // Validate event
    if (this.options.validateEvents !== false && !this.validateEvent(fullEvent)) {
      console.warn('Invalid learning event:', fullEvent);
      return;
    }
    
    // Add to buffer
    this.buffer.push(fullEvent);
    
    // Flush if buffer is full
    if (this.buffer.length >= (this.options.bufferSize || 100)) {
      await this.flush();
    }
  }
  
  async collectOutcome(
    actionId: string,
    outcome: Outcome
  ): Promise<void> {
    // Find related action event
    const actionEvent = await this.storage.findByActionId(actionId);
    
    if (!actionEvent) {
      console.warn('No action event found for outcome:', actionId);
      return;
    }
    
    // Create outcome event
    await this.collectEvent({
      type: EventType.Outcome,
      context: {
        actionId,
        actionType: actionEvent.type,
        originalContext: actionEvent.context
      },
      action: actionEvent.action,
      outcome
    });
    
    // Trigger immediate analysis for important outcomes
    if (this.isImportantOutcome(outcome)) {
      await this.triggerAnalysis(actionEvent, outcome);
    }
  }
  
  async collectFeedback(
    eventId: string,
    feedback: {
      userId: string;
      sentiment: 'positive' | 'negative' | 'neutral';
      message?: string;
      suggestions?: string[];
    }
  ): Promise<void> {
    const event = await this.storage.findById(eventId);
    
    if (!event) {
      console.warn('No event found for feedback:', eventId);
      return;
    }
    
    // Update the original event with feedback
    const updatedEvent: LearningEvent = {
      ...event,
      feedback: {
        id: this.generateId(),
        eventId,
        timestamp: new Date(),
        ...feedback
      }
    };
    
    await this.storage.updateEvent(updatedEvent);
    
    // Create feedback event
    await this.collectEvent({
      type: EventType.UserFeedback,
      context: {
        originalEventId: eventId,
        originalEventType: event.type,
        sentiment: feedback.sentiment
      },
      action: event.action,
      outcome: event.outcome,
      feedback: updatedEvent.feedback
    });
  }
  
  async getRecentEvents(window: number): Promise<LearningEvent[]> {
    const since = new Date(Date.now() - window);
    return this.storage.findByTimeRange(since, new Date());
  }
  
  registerProcessor(type: EventType, processor: EventProcessor): void {
    this.processors.set(type, processor);
  }
  
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    
    const events = [...this.buffer];
    this.buffer = [];
    
    try {
      await this.storage.saveEvents(events);
      
      // Process events for immediate learning
      await this.processEvents(events);
      
    } catch (error) {
      console.error('Failed to flush events:', error);
      // Re-add to buffer for retry
      this.buffer.unshift(...events);
    }
  }
  
  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flush();
  }
  
  private startFlushTimer(): void {
    const interval = this.options.flushInterval || 60000; // 1 minute default
    
    this.flushInterval = setInterval(async () => {
      await this.flush();
    }, interval);
  }
  
  private async processEvents(events: LearningEvent[]): Promise<void> {
    // Group by type for batch processing
    const byType = this.groupByType(events);
    
    for (const [type, typeEvents] of byType) {
      const processor = this.processors.get(type);
      if (processor) {
        try {
          await processor.process(typeEvents);
        } catch (error) {
          console.error(`Failed to process ${type} events:`, error);
        }
      }
    }
  }
  
  private groupByType(events: LearningEvent[]): Map<EventType, LearningEvent[]> {
    const grouped = new Map<EventType, LearningEvent[]>();
    
    for (const event of events) {
      const existing = grouped.get(event.type) || [];
      existing.push(event);
      grouped.set(event.type, existing);
    }
    
    return grouped;
  }
  
  private validateEvent(event: LearningEvent): boolean {
    // Basic validation
    if (!event.id || !event.type || !event.timestamp) {
      return false;
    }
    
    if (!event.action || !event.action.type || !event.action.target) {
      return false;
    }
    
    if (!event.outcome || typeof event.outcome.success !== 'boolean') {
      return false;
    }
    
    // Type-specific validation
    switch (event.type) {
      case EventType.CodeGeneration:
        return !!event.context.generatedCode;
        
      case EventType.ReviewResponse:
        return !!event.context.review;
        
      case EventType.ErrorRecovery:
        return !!event.context.error;
        
      case EventType.UserFeedback:
        return !!event.feedback;
        
      default:
        return true;
    }
  }
  
  private isImportantOutcome(outcome: Outcome): boolean {
    // Failed outcomes are always important
    if (!outcome.success) return true;
    
    // Large changes are important
    if (outcome.metrics?.linesChanged && outcome.metrics.linesChanged > 500) {
      return true;
    }
    
    // Test failures are important
    if (outcome.metrics?.testsPassed === 0) {
      return true;
    }
    
    // Build failures are important
    if (outcome.metrics?.buildStatus === 'failure') {
      return true;
    }
    
    return false;
  }
  
  private async triggerAnalysis(
    event: LearningEvent,
    outcome: Outcome
  ): Promise<void> {
    // Emit event for immediate analysis
    // This would typically trigger pattern detection, behavior learning, etc.
    console.log('Triggering immediate analysis for:', event.id, outcome);
    
    // Process single event immediately
    const processor = this.processors.get(event.type);
    if (processor) {
      await processor.process([event]);
    }
  }
  
  private generateId(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2, 9);
    return createHash('sha256')
      .update(timestamp + random)
      .digest('hex')
      .substring(0, 16);
  }
}