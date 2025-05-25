import type {
  LearningEvent,
  LearningModel,
  Pattern,
  LearnedBehavior,
  Preferences,
  Statistics
} from './types.js';
import { PatternDetector } from './pattern_detector.js';
import { BehaviorLearner } from './behavior_learner.js';
import { PreferenceTracker } from './preference_tracker.js';
import { createHash } from 'node:crypto';

export class ModelTrainer {
  private patternDetector: PatternDetector;
  private behaviorLearner: BehaviorLearner;
  private preferenceTracker: PreferenceTracker;
  
  constructor() {
    this.patternDetector = new PatternDetector();
    this.behaviorLearner = new BehaviorLearner();
    this.preferenceTracker = new PreferenceTracker();
  }
  
  async trainModel(
    events: LearningEvent[],
    existingModel?: LearningModel
  ): Promise<LearningModel> {
    console.log(`Training model with ${events.length} events`);
    
    // Detect patterns
    const patterns = await this.patternDetector.detectPatterns(events);
    console.log(`Detected ${patterns.length} patterns`);
    
    // Learn behaviors
    const behaviors = await this.behaviorLearner.learnBehaviors(
      events,
      patterns
    );
    console.log(`Learned ${behaviors.length} behaviors`);
    
    // Track preferences
    const preferences = await this.preferenceTracker.trackPreferences(
      events
    );
    
    // Calculate statistics
    const statistics = this.calculateStatistics(events);
    
    // Merge with existing model if provided
    let model: LearningModel;
    
    if (existingModel) {
      model = this.mergeModels(existingModel, {
        id: this.generateModelId(),
        patterns,
        behaviors,
        preferences,
        statistics,
        version: existingModel.version + 1,
        createdAt: existingModel.createdAt,
        updatedAt: new Date()
      });
    } else {
      model = {
        id: this.generateModelId(),
        patterns,
        behaviors,
        preferences,
        statistics,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    }
    
    // Validate model
    const validated = await this.validateModel(model);
    
    // Optimize model
    const optimized = this.optimizeModel(validated);
    
    return optimized;
  }
  
  private calculateStatistics(events: LearningEvent[]): Statistics {
    const successfulEvents = events.filter(e => e.outcome.success);
    const feedbackEvents = events.filter(e => e.feedback);
    const positiveFeedback = feedbackEvents.filter(e => 
      e.feedback?.sentiment === 'positive'
    );
    
    // Calculate response times
    const responseTimes = events
      .filter(e => e.outcome.duration)
      .map(e => e.outcome.duration);
    
    const avgResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 0;
    
    // Calculate improvement rate (simplified)
    const recentEvents = events.slice(-100);
    const olderEvents = events.slice(0, -100);
    
    const recentSuccessRate = recentEvents.length > 0
      ? recentEvents.filter(e => e.outcome.success).length / recentEvents.length
      : 0;
    
    const olderSuccessRate = olderEvents.length > 0
      ? olderEvents.filter(e => e.outcome.success).length / olderEvents.length
      : 0;
    
    const improvementRate = recentSuccessRate - olderSuccessRate;
    
    return {
      totalEvents: events.length,
      successRate: successfulEvents.length / events.length,
      averageResponseTime: avgResponseTime,
      patternAccuracy: 0.85, // Placeholder - would calculate from pattern validation
      behaviorAccuracy: 0.80, // Placeholder - would calculate from behavior outcomes
      feedbackScore: positiveFeedback.length / Math.max(feedbackEvents.length, 1),
      improvementRate,
      lastUpdated: new Date()
    };
  }
  
  private mergeModels(
    existing: LearningModel,
    newModel: LearningModel
  ): LearningModel {
    return {
      id: newModel.id,
      patterns: this.mergePatterns(existing.patterns, newModel.patterns),
      behaviors: this.mergeBehaviors(existing.behaviors, newModel.behaviors),
      preferences: this.mergePreferences(existing.preferences, newModel.preferences),
      statistics: this.mergeStatistics(existing.statistics, newModel.statistics),
      version: newModel.version,
      createdAt: existing.createdAt,
      updatedAt: newModel.updatedAt
    };
  }
  
  private mergePatterns(
    existing: Pattern[],
    newPatterns: Pattern[]
  ): Pattern[] {
    const merged = new Map<string, Pattern>();
    
    // Add existing patterns
    for (const pattern of existing) {
      merged.set(pattern.id, pattern);
    }
    
    // Merge or add new patterns
    for (const pattern of newPatterns) {
      const existingPattern = merged.get(pattern.id);
      
      if (existingPattern) {
        // Update existing pattern
        merged.set(pattern.id, {
          ...existingPattern,
          occurrences: existingPattern.occurrences + pattern.occurrences,
          confidence: (existingPattern.confidence + pattern.confidence) / 2,
          examples: this.mergeExamples(
            existingPattern.examples,
            pattern.examples
          ),
          recommendations: this.mergeRecommendations(
            existingPattern.recommendations,
            pattern.recommendations
          ),
          lastSeen: pattern.lastSeen
        });
      } else {
        merged.set(pattern.id, pattern);
      }
    }
    
    return Array.from(merged.values());
  }
  
  private mergeBehaviors(
    existing: LearnedBehavior[],
    newBehaviors: LearnedBehavior[]
  ): LearnedBehavior[] {
    const merged = new Map<string, LearnedBehavior>();
    
    // Add existing behaviors
    for (const behavior of existing) {
      merged.set(behavior.id, behavior);
    }
    
    // Merge or add new behaviors
    for (const behavior of newBehaviors) {
      const existingBehavior = merged.get(behavior.id);
      
      if (existingBehavior) {
        // Update existing behavior
        merged.set(behavior.id, {
          ...existingBehavior,
          confidence: (existingBehavior.confidence * 0.7 + behavior.confidence * 0.3),
          evidence: [...new Set([...existingBehavior.evidence, ...behavior.evidence])],
          exceptions: this.mergeExceptions(
            existingBehavior.exceptions,
            behavior.exceptions
          ),
          lastUpdated: behavior.lastUpdated
        });
      } else {
        merged.set(behavior.id, behavior);
      }
    }
    
    return Array.from(merged.values());
  }
  
  private mergePreferences(
    existing: Preferences,
    newPrefs: Preferences
  ): Preferences {
    // For preferences, newer observations should have more weight
    return {
      codeStyle: {
        ...existing.codeStyle,
        ...newPrefs.codeStyle
      },
      communication: {
        ...existing.communication,
        ...newPrefs.communication
      },
      workflow: {
        ...existing.workflow,
        ...newPrefs.workflow
      },
      tools: {
        ...existing.tools,
        ...newPrefs.tools,
        customTools: {
          ...existing.tools.customTools,
          ...newPrefs.tools.customTools
        }
      }
    };
  }
  
  private mergeStatistics(
    existing: Statistics,
    newStats: Statistics
  ): Statistics {
    // Weighted average favoring recent data
    const oldWeight = 0.3;
    const newWeight = 0.7;
    
    return {
      totalEvents: existing.totalEvents + newStats.totalEvents,
      successRate: existing.successRate * oldWeight + newStats.successRate * newWeight,
      averageResponseTime: existing.averageResponseTime * oldWeight + 
                          newStats.averageResponseTime * newWeight,
      patternAccuracy: existing.patternAccuracy * oldWeight + 
                      newStats.patternAccuracy * newWeight,
      behaviorAccuracy: existing.behaviorAccuracy * oldWeight + 
                       newStats.behaviorAccuracy * newWeight,
      feedbackScore: existing.feedbackScore * oldWeight + 
                    newStats.feedbackScore * newWeight,
      improvementRate: newStats.improvementRate, // Use latest
      lastUpdated: newStats.lastUpdated
    };
  }
  
  private mergeExamples(existing: any[], newExamples: any[]): any[] {
    const seen = new Set(existing.map(e => e.id));
    const merged = [...existing];
    
    for (const example of newExamples) {
      if (!seen.has(example.id)) {
        merged.push(example);
      }
    }
    
    // Keep most recent examples
    return merged.slice(-10);
  }
  
  private mergeRecommendations(existing: string[], newRecs: string[]): string[] {
    return Array.from(new Set([...existing, ...newRecs]));
  }
  
  private mergeExceptions(existing: any[], newExceptions: any[]): any[] {
    const merged = [...existing];
    const seen = new Set(existing.map(e => JSON.stringify(e.condition)));
    
    for (const exception of newExceptions) {
      const key = JSON.stringify(exception.condition);
      if (!seen.has(key)) {
        merged.push(exception);
        seen.add(key);
      }
    }
    
    return merged;
  }
  
  private async validateModel(model: LearningModel): Promise<LearningModel> {
    // Validate patterns
    const validPatterns = model.patterns.filter(p => {
      // Must have minimum confidence
      if (p.confidence < 0.5) return false;
      
      // Must have recent activity
      const daysSinceLastSeen = 
        (Date.now() - p.lastSeen.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceLastSeen > 90) return false;
      
      // Must have examples
      if (p.examples.length === 0) return false;
      
      return true;
    });
    
    // Validate behaviors
    const validBehaviors = model.behaviors.filter(b => {
      // Must have minimum confidence
      if (b.confidence < 0.5) return false;
      
      // Must have evidence
      if (b.evidence.length < 2) return false;
      
      // Check for too many exceptions
      if (b.exceptions.length > b.evidence.length * 0.5) return false;
      
      return true;
    });
    
    return {
      ...model,
      patterns: validPatterns,
      behaviors: validBehaviors
    };
  }
  
  private optimizeModel(model: LearningModel): LearningModel {
    // Remove low-confidence patterns
    const patterns = model.patterns.filter(p => p.confidence > 0.6);
    
    // Remove conflicting behaviors
    const behaviors = this.resolveConflicts(model.behaviors);
    
    // Consolidate similar items
    const consolidated = {
      ...model,
      patterns: this.consolidatePatterns(patterns),
      behaviors: this.consolidateBehaviors(behaviors)
    };
    
    return consolidated;
  }
  
  private resolveConflicts(behaviors: LearnedBehavior[]): LearnedBehavior[] {
    const resolved: LearnedBehavior[] = [];
    const conflictGroups = new Map<string, LearnedBehavior[]>();
    
    // Group potentially conflicting behaviors
    for (const behavior of behaviors) {
      const key = this.behaviorConflictKey(behavior);
      const group = conflictGroups.get(key) || [];
      group.push(behavior);
      conflictGroups.set(key, group);
    }
    
    // Resolve conflicts within each group
    for (const group of conflictGroups.values()) {
      if (group.length === 1) {
        resolved.push(group[0]);
      } else {
        // Keep the behavior with highest confidence
        const best = group.reduce((a, b) => 
          a.confidence > b.confidence ? a : b
        );
        resolved.push(best);
      }
    }
    
    return resolved;
  }
  
  private behaviorConflictKey(behavior: LearnedBehavior): string {
    // Behaviors with same trigger type and target are potential conflicts
    return `${behavior.trigger.type}:${behavior.action.type}`;
  }
  
  private consolidatePatterns(patterns: Pattern[]): Pattern[] {
    // Group similar patterns
    const groups = new Map<string, Pattern[]>();
    
    for (const pattern of patterns) {
      const key = `${pattern.type}:${pattern.signature.key}`;
      const group = groups.get(key) || [];
      group.push(pattern);
      groups.set(key, group);
    }
    
    // Merge groups
    const consolidated: Pattern[] = [];
    
    for (const group of groups.values()) {
      if (group.length === 1) {
        consolidated.push(group[0]);
      } else {
        // Merge similar patterns
        const merged = this.mergePatternGroup(group);
        consolidated.push(merged);
      }
    }
    
    return consolidated;
  }
  
  private mergePatternGroup(patterns: Pattern[]): Pattern {
    // Take the pattern with highest confidence as base
    const base = patterns.reduce((a, b) => 
      a.confidence > b.confidence ? a : b
    );
    
    // Merge data from all patterns
    return {
      ...base,
      occurrences: patterns.reduce((sum, p) => sum + p.occurrences, 0),
      confidence: patterns.reduce((sum, p) => sum + p.confidence, 0) / patterns.length,
      examples: this.mergeExamples(
        [],
        patterns.flatMap(p => p.examples)
      ),
      recommendations: this.mergeRecommendations(
        [],
        patterns.flatMap(p => p.recommendations)
      ),
      lastSeen: new Date(
        Math.max(...patterns.map(p => p.lastSeen.getTime()))
      )
    };
  }
  
  private consolidateBehaviors(behaviors: LearnedBehavior[]): LearnedBehavior[] {
    // Similar to pattern consolidation
    const groups = new Map<string, LearnedBehavior[]>();
    
    for (const behavior of behaviors) {
      const key = this.behaviorGroupKey(behavior);
      const group = groups.get(key) || [];
      group.push(behavior);
      groups.set(key, group);
    }
    
    const consolidated: LearnedBehavior[] = [];
    
    for (const group of groups.values()) {
      if (group.length === 1) {
        consolidated.push(group[0]);
      } else {
        const merged = this.mergeBehaviorGroup(group);
        consolidated.push(merged);
      }
    }
    
    return consolidated;
  }
  
  private behaviorGroupKey(behavior: LearnedBehavior): string {
    // Group by trigger type and action type
    return `${behavior.trigger.type}:${behavior.action.type}`;
  }
  
  private mergeBehaviorGroup(behaviors: LearnedBehavior[]): LearnedBehavior {
    const base = behaviors.reduce((a, b) => 
      a.confidence > b.confidence ? a : b
    );
    
    return {
      ...base,
      confidence: behaviors.reduce((sum, b) => sum + b.confidence, 0) / behaviors.length,
      evidence: Array.from(new Set(behaviors.flatMap(b => b.evidence))),
      exceptions: this.mergeExceptions([], behaviors.flatMap(b => b.exceptions)),
      lastUpdated: new Date(
        Math.max(...behaviors.map(b => b.lastUpdated.getTime()))
      )
    };
  }
  
  private generateModelId(): string {
    return createHash('sha256')
      .update(Date.now().toString())
      .digest('hex')
      .substring(0, 16);
  }
}