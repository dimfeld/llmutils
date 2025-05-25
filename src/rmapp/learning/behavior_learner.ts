import type {
  LearningEvent,
  LearnedBehavior,
  Pattern,
  Trigger,
  TriggerType,
  RecommendedAction,
  Exception,
  ActionType,
  Condition
} from './types.js';
import { createHash } from 'node:crypto';

export class BehaviorLearner {
  async learnBehaviors(
    events: LearningEvent[],
    patterns: Pattern[]
  ): Promise<LearnedBehavior[]> {
    const behaviors: LearnedBehavior[] = [];
    
    // Learn from successful outcomes
    const successful = this.filterSuccessful(events);
    behaviors.push(...await this.learnFromSuccess(successful, patterns));
    
    // Learn from failures
    const failed = this.filterFailed(events);
    behaviors.push(...await this.learnFromFailures(failed, patterns));
    
    // Learn from feedback
    const withFeedback = this.filterWithFeedback(events);
    behaviors.push(...await this.learnFromFeedback(withFeedback));
    
    // Validate behaviors
    const validated = await this.validateBehaviors(behaviors);
    
    // Merge similar behaviors
    const merged = this.mergeSimilarBehaviors(validated);
    
    return merged;
  }
  
  private filterSuccessful(events: LearningEvent[]): LearningEvent[] {
    return events.filter(e => e.outcome.success);
  }
  
  private filterFailed(events: LearningEvent[]): LearningEvent[] {
    return events.filter(e => !e.outcome.success);
  }
  
  private filterWithFeedback(events: LearningEvent[]): LearningEvent[] {
    return events.filter(e => e.feedback !== undefined);
  }
  
  private async learnFromSuccess(
    events: LearningEvent[],
    patterns: Pattern[]
  ): Promise<LearnedBehavior[]> {
    const behaviors: LearnedBehavior[] = [];
    
    // Group by action type
    const byAction = this.groupByAction(events);
    
    for (const [actionType, actionEvents] of byAction) {
      // Find common triggers
      const triggers = this.extractTriggers(actionEvents);
      
      for (const trigger of triggers) {
        // Find successful actions for this trigger
        const successfulActions = this.findSuccessfulActions(
          actionEvents,
          trigger
        );
        
        if (successfulActions.length >= 3) { // Minimum occurrences
          const behavior: LearnedBehavior = {
            id: this.generateBehaviorId(trigger, actionType),
            trigger,
            action: this.generalizeAction(successfulActions),
            confidence: successfulActions.length / actionEvents.length,
            evidence: successfulActions.map(a => a.id),
            exceptions: this.findExceptions(actionEvents, trigger),
            lastUpdated: new Date()
          };
          
          behaviors.push(behavior);
        }
      }
    }
    
    return behaviors;
  }
  
  private async learnFromFailures(
    events: LearningEvent[],
    patterns: Pattern[]
  ): Promise<LearnedBehavior[]> {
    const behaviors: LearnedBehavior[] = [];
    
    // Group failures by error type
    const byError = this.groupByErrorType(events);
    
    for (const [errorType, errorEvents] of byError) {
      // Find what to avoid
      const commonFactors = this.findCommonFactors(errorEvents);
      
      for (const factor of commonFactors) {
        if (factor.occurrences >= 3) {
          const behavior: LearnedBehavior = {
            id: this.generateBehaviorId(factor.trigger, 'avoid'),
            trigger: factor.trigger,
            action: {
              type: ActionType.FixError,
              parameters: {
                avoid: factor.action,
                reason: `Causes ${errorType} errors`
              },
              description: `Avoid ${factor.description} to prevent ${errorType}`,
              expectedOutcome: {
                success: false,
                duration: 0,
                error: errorType
              }
            },
            confidence: factor.occurrences / errorEvents.length,
            evidence: factor.events,
            exceptions: [],
            lastUpdated: new Date()
          };
          
          behaviors.push(behavior);
        }
      }
    }
    
    return behaviors;
  }
  
  private async learnFromFeedback(
    events: LearningEvent[]
  ): Promise<LearnedBehavior[]> {
    const behaviors: LearnedBehavior[] = [];
    
    // Positive feedback
    const positive = events.filter(e => 
      e.feedback?.sentiment === 'positive'
    );
    
    for (const event of positive) {
      const behavior = this.extractBehaviorFromFeedback(event);
      if (behavior) {
        behaviors.push(behavior);
      }
    }
    
    // Negative feedback - learn what to avoid
    const negative = events.filter(e =>
      e.feedback?.sentiment === 'negative'
    );
    
    for (const event of negative) {
      const avoidBehavior = this.extractAvoidanceBehavior(event);
      if (avoidBehavior) {
        behaviors.push(avoidBehavior);
      }
    }
    
    return behaviors;
  }
  
  private groupByAction(events: LearningEvent[]): Map<ActionType, LearningEvent[]> {
    const grouped = new Map<ActionType, LearningEvent[]>();
    
    for (const event of events) {
      const type = event.action.type;
      const existing = grouped.get(type) || [];
      existing.push(event);
      grouped.set(type, existing);
    }
    
    return grouped;
  }
  
  private groupByErrorType(events: LearningEvent[]): Map<string, LearningEvent[]> {
    const grouped = new Map<string, LearningEvent[]>();
    
    for (const event of events) {
      const errorType = event.outcome.error || 'unknown';
      const existing = grouped.get(errorType) || [];
      existing.push(event);
      grouped.set(errorType, existing);
    }
    
    return grouped;
  }
  
  private extractTriggers(events: LearningEvent[]): Trigger[] {
    const triggers: Map<string, Trigger> = new Map();
    
    for (const event of events) {
      // Extract various trigger types
      const eventTriggers = this.identifyTriggers(event);
      
      for (const trigger of eventTriggers) {
        const key = this.triggerKey(trigger);
        if (!triggers.has(key)) {
          triggers.set(key, trigger);
        }
      }
    }
    
    return Array.from(triggers.values());
  }
  
  private identifyTriggers(event: LearningEvent): Trigger[] {
    const triggers: Trigger[] = [];
    
    // Issue type trigger
    if (event.context.issue) {
      triggers.push({
        type: TriggerType.IssueType,
        conditions: [
          {
            field: 'context.issue',
            operator: 'eq',
            value: event.context.issue
          }
        ]
      });
    }
    
    // Review comment trigger
    if (event.context.review?.comments?.length > 0) {
      const commentTypes = this.classifyComments(event.context.review.comments);
      
      for (const commentType of commentTypes) {
        triggers.push({
          type: TriggerType.ReviewComment,
          conditions: [
            {
              field: 'commentType',
              operator: 'eq',
              value: commentType
            }
          ],
          context: { commentType }
        });
      }
    }
    
    // Error type trigger
    if (event.context.error) {
      triggers.push({
        type: TriggerType.ErrorType,
        conditions: [
          {
            field: 'error.type',
            operator: 'eq',
            value: event.context.error.type
          }
        ]
      });
    }
    
    // File pattern trigger
    if (event.context.fileChanges?.length > 0) {
      const patterns = this.extractFilePatterns(event.context.fileChanges);
      
      for (const pattern of patterns) {
        triggers.push({
          type: TriggerType.FilePattern,
          conditions: [
            {
              field: 'filePattern',
              operator: 'matches',
              value: pattern
            }
          ],
          context: { pattern }
        });
      }
    }
    
    return triggers;
  }
  
  private classifyComments(comments: any[]): string[] {
    const types = new Set<string>();
    
    for (const comment of comments) {
      if (comment.body.toLowerCase().includes('test')) {
        types.add('testing');
      }
      if (comment.body.toLowerCase().includes('style')) {
        types.add('style');
      }
      if (comment.body.toLowerCase().includes('bug')) {
        types.add('bug');
      }
      if (comment.body.toLowerCase().includes('performance')) {
        types.add('performance');
      }
    }
    
    return Array.from(types);
  }
  
  private extractFilePatterns(fileChanges: any[]): string[] {
    const patterns = new Set<string>();
    
    for (const change of fileChanges) {
      // Extract directory pattern
      const dir = change.file.split('/')[0];
      if (dir) {
        patterns.add(`${dir}/*`);
      }
      
      // Extract extension pattern
      const ext = change.file.split('.').pop();
      if (ext) {
        patterns.add(`*.${ext}`);
      }
    }
    
    return Array.from(patterns);
  }
  
  private triggerKey(trigger: Trigger): string {
    return createHash('sha256')
      .update(JSON.stringify(trigger))
      .digest('hex')
      .substring(0, 16);
  }
  
  private findSuccessfulActions(
    events: LearningEvent[],
    trigger: Trigger
  ): LearningEvent[] {
    return events.filter(event => 
      event.outcome.success && this.matchesTrigger(event, trigger)
    );
  }
  
  private matchesTrigger(event: LearningEvent, trigger: Trigger): boolean {
    for (const condition of trigger.conditions) {
      if (!this.evaluateCondition(event, condition)) {
        return false;
      }
    }
    return true;
  }
  
  private evaluateCondition(
    event: LearningEvent,
    condition: Condition
  ): boolean {
    const value = this.getFieldValue(event, condition.field);
    
    switch (condition.operator) {
      case 'eq':
        return value === condition.value;
      case 'neq':
        return value !== condition.value;
      case 'gt':
        return value > condition.value;
      case 'lt':
        return value < condition.value;
      case 'contains':
        return String(value).includes(String(condition.value));
      case 'matches':
        return new RegExp(String(condition.value)).test(String(value));
      default:
        return false;
    }
  }
  
  private getFieldValue(obj: any, field: string): any {
    const parts = field.split('.');
    let value = obj;
    
    for (const part of parts) {
      value = value?.[part];
      if (value === undefined) return undefined;
    }
    
    return value;
  }
  
  private generalizeAction(events: LearningEvent[]): RecommendedAction {
    // Find most common action parameters
    const paramCounts = new Map<string, Map<any, number>>();
    
    for (const event of events) {
      for (const [key, value] of Object.entries(event.action.parameters)) {
        if (!paramCounts.has(key)) {
          paramCounts.set(key, new Map());
        }
        
        const valueCounts = paramCounts.get(key)!;
        const valueStr = JSON.stringify(value);
        valueCounts.set(valueStr, (valueCounts.get(valueStr) || 0) + 1);
      }
    }
    
    // Build generalized parameters
    const generalParams: Record<string, any> = {};
    
    for (const [key, valueCounts] of paramCounts) {
      // Take most common value
      const mostCommon = Array.from(valueCounts.entries())
        .sort((a, b) => b[1] - a[1])[0];
      
      generalParams[key] = JSON.parse(mostCommon[0]);
    }
    
    // Calculate expected outcome
    const avgDuration = events.reduce((sum, e) => 
      sum + e.outcome.duration, 0
    ) / events.length;
    
    return {
      type: events[0].action.type,
      parameters: generalParams,
      description: this.describeAction(events[0].action.type, generalParams),
      expectedOutcome: {
        success: true,
        duration: avgDuration
      }
    };
  }
  
  private describeAction(type: ActionType, params: Record<string, any>): string {
    switch (type) {
      case ActionType.GenerateCode:
        return 'Generate code with established patterns';
      case ActionType.ApplyChange:
        return 'Apply changes following team conventions';
      case ActionType.RespondToReview:
        return 'Respond to review comments promptly';
      case ActionType.CreatePR:
        return 'Create PR with detailed description';
      case ActionType.Commit:
        return 'Commit changes with clear message';
      case ActionType.RunTests:
        return 'Run tests before committing';
      case ActionType.FixError:
        return 'Fix errors using proven strategies';
      default:
        return 'Perform action';
    }
  }
  
  private findExceptions(
    events: LearningEvent[],
    trigger: Trigger
  ): Exception[] {
    const exceptions: Exception[] = [];
    
    // Find failed actions with this trigger
    const failed = events.filter(event =>
      !event.outcome.success && this.matchesTrigger(event, trigger)
    );
    
    if (failed.length === 0) return exceptions;
    
    // Find common factors in failures
    const commonFactors = this.findCommonFactors(failed);
    
    for (const factor of commonFactors) {
      if (factor.occurrences >= 2) {
        exceptions.push({
          condition: factor.condition,
          reason: factor.reason,
          examples: factor.events
        });
      }
    }
    
    return exceptions;
  }
  
  private findCommonFactors(events: LearningEvent[]): any[] {
    const factors: any[] = [];
    
    // Analyze various aspects
    const aspects = [
      { field: 'context.fileChanges.length', threshold: 10, reason: 'Too many files' },
      { field: 'outcome.duration', threshold: 300000, reason: 'Takes too long' },
      { field: 'context.error.recoveryAttempts', threshold: 3, reason: 'Multiple failures' }
    ];
    
    for (const aspect of aspects) {
      const matching = events.filter(e => {
        const value = this.getFieldValue(e, aspect.field);
        return value && value > aspect.threshold;
      });
      
      if (matching.length >= 2) {
        factors.push({
          trigger: {
            type: TriggerType.FilePattern,
            conditions: [{
              field: aspect.field,
              operator: 'gt',
              value: aspect.threshold
            }]
          },
          condition: {
            field: aspect.field,
            operator: 'gt',
            value: aspect.threshold
          },
          action: events[0].action.type,
          description: aspect.reason,
          reason: aspect.reason,
          occurrences: matching.length,
          events: matching.map(e => e.id)
        });
      }
    }
    
    return factors;
  }
  
  private extractBehaviorFromFeedback(event: LearningEvent): LearnedBehavior | null {
    if (!event.feedback) return null;
    
    return {
      id: this.generateBehaviorId(
        { type: TriggerType.UserPreference, conditions: [] },
        event.action.type
      ),
      trigger: {
        type: TriggerType.UserPreference,
        conditions: [],
        context: {
          feedbackId: event.feedback.id,
          sentiment: event.feedback.sentiment
        }
      },
      action: {
        type: event.action.type,
        parameters: event.action.parameters,
        description: `Preferred approach: ${event.feedback.message || 'User approved'}`,
        expectedOutcome: event.outcome
      },
      confidence: 0.9, // High confidence for explicit positive feedback
      evidence: [event.id],
      exceptions: [],
      lastUpdated: new Date()
    };
  }
  
  private extractAvoidanceBehavior(event: LearningEvent): LearnedBehavior | null {
    if (!event.feedback) return null;
    
    return {
      id: this.generateBehaviorId(
        { type: TriggerType.UserPreference, conditions: [] },
        'avoid'
      ),
      trigger: {
        type: TriggerType.UserPreference,
        conditions: [
          {
            field: 'action.type',
            operator: 'eq',
            value: event.action.type
          }
        ]
      },
      action: {
        type: ActionType.FixError,
        parameters: {
          avoid: event.action,
          reason: event.feedback.message || 'User disapproved'
        },
        description: `Avoid: ${event.feedback.message || 'This approach'}`,
        expectedOutcome: {
          success: false,
          duration: 0
        }
      },
      confidence: 0.9, // High confidence for explicit negative feedback
      evidence: [event.id],
      exceptions: [],
      lastUpdated: new Date()
    };
  }
  
  private async validateBehaviors(
    behaviors: LearnedBehavior[]
  ): Promise<LearnedBehavior[]> {
    const validated: LearnedBehavior[] = [];
    
    for (const behavior of behaviors) {
      // Check for minimum evidence
      if (behavior.evidence.length < 2) continue;
      
      // Check for reasonable confidence
      if (behavior.confidence < 0.5) continue;
      
      // Check for conflicts
      const hasConflict = behaviors.some(b =>
        b.id !== behavior.id &&
        this.conflictsWith(behavior, b)
      );
      
      if (!hasConflict) {
        validated.push(behavior);
      }
    }
    
    return validated;
  }
  
  private conflictsWith(b1: LearnedBehavior, b2: LearnedBehavior): boolean {
    // Same trigger but opposite actions
    if (this.sameTrigger(b1.trigger, b2.trigger)) {
      if (b1.action.type === ActionType.FixError && 
          b2.action.type !== ActionType.FixError) {
        return true;
      }
    }
    
    return false;
  }
  
  private sameTrigger(t1: Trigger, t2: Trigger): boolean {
    if (t1.type !== t2.type) return false;
    
    // Compare conditions
    if (t1.conditions.length !== t2.conditions.length) return false;
    
    for (let i = 0; i < t1.conditions.length; i++) {
      const c1 = t1.conditions[i];
      const c2 = t2.conditions[i];
      
      if (c1.field !== c2.field || 
          c1.operator !== c2.operator ||
          c1.value !== c2.value) {
        return false;
      }
    }
    
    return true;
  }
  
  private mergeSimilarBehaviors(behaviors: LearnedBehavior[]): LearnedBehavior[] {
    const merged: LearnedBehavior[] = [];
    const processed = new Set<string>();
    
    for (const behavior of behaviors) {
      if (processed.has(behavior.id)) continue;
      
      const similar = behaviors.filter(b =>
        b.id !== behavior.id &&
        !processed.has(b.id) &&
        this.areSimilar(behavior, b)
      );
      
      if (similar.length > 0) {
        const mergedBehavior = this.mergeBehaviors(behavior, ...similar);
        merged.push(mergedBehavior);
        
        processed.add(behavior.id);
        similar.forEach(b => processed.add(b.id));
      } else {
        merged.push(behavior);
        processed.add(behavior.id);
      }
    }
    
    return merged;
  }
  
  private areSimilar(b1: LearnedBehavior, b2: LearnedBehavior): boolean {
    // Same trigger type and action type
    return b1.trigger.type === b2.trigger.type &&
           b1.action.type === b2.action.type;
  }
  
  private mergeBehaviors(
    first: LearnedBehavior,
    ...rest: LearnedBehavior[]
  ): LearnedBehavior {
    const all = [first, ...rest];
    
    return {
      id: first.id,
      trigger: first.trigger, // Could merge conditions
      action: first.action, // Could merge parameters
      confidence: all.reduce((sum, b) => sum + b.confidence, 0) / all.length,
      evidence: all.flatMap(b => b.evidence),
      exceptions: this.mergeExceptions(all.flatMap(b => b.exceptions)),
      lastUpdated: new Date()
    };
  }
  
  private mergeExceptions(exceptions: Exception[]): Exception[] {
    // Deduplicate exceptions
    const unique: Exception[] = [];
    const seen = new Set<string>();
    
    for (const exception of exceptions) {
      const key = JSON.stringify(exception.condition);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(exception);
      }
    }
    
    return unique;
  }
  
  private generateBehaviorId(trigger: Trigger, actionType: string): string {
    const input = JSON.stringify(trigger) + actionType;
    return createHash('sha256')
      .update(input)
      .digest('hex')
      .substring(0, 16);
  }
}