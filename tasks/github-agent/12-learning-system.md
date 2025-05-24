# Learning System

## Overview
Build a learning system that improves the agent's performance over time by analyzing patterns, feedback, and outcomes.

## Requirements
- Learn from successful and failed operations
- Identify patterns in codebase and workflows
- Adapt to team preferences and conventions
- Improve decision-making over time
- Provide insights and recommendations

## Implementation Steps

### Step 1: Define Learning Model
Create types in `src/rmapp/learning/types.ts`:
```typescript
interface LearningEvent {
  id: string;
  type: EventType;
  timestamp: Date;
  context: EventContext;
  action: Action;
  outcome: Outcome;
  feedback?: Feedback;
}

interface Pattern {
  id: string;
  type: PatternType;
  signature: PatternSignature;
  occurrences: number;
  confidence: number;
  examples: Example[];
  recommendations: string[];
}

interface LearnedBehavior {
  trigger: Trigger;
  action: RecommendedAction;
  confidence: number;
  evidence: Evidence[];
  exceptions: Exception[];
}

interface LearningModel {
  patterns: Pattern[];
  behaviors: LearnedBehavior[];
  preferences: Preferences;
  statistics: Statistics;
  version: number;
}

enum EventType {
  IssueImplementation = 'issue_implementation',
  ReviewResponse = 'review_response',
  CodeGeneration = 'code_generation',
  ErrorRecovery = 'error_recovery',
  UserFeedback = 'user_feedback'
}
```

### Step 2: Build Event Collector
Implement `src/rmapp/learning/collector.ts`:
```typescript
class LearningEventCollector {
  private buffer: LearningEvent[] = [];
  private flushInterval: NodeJS.Timer;
  
  constructor(
    private storage: EventStorage,
    private options: CollectorOptions = {}
  ) {
    this.startFlushTimer();
  }
  
  async collectEvent(event: Partial<LearningEvent>): Promise<void> {
    const fullEvent: LearningEvent = {
      id: this.generateId(),
      timestamp: new Date(),
      ...event
    };
    
    // Validate event
    if (!this.validateEvent(fullEvent)) {
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
        actionType: actionEvent.type
      },
      outcome
    });
    
    // Trigger immediate analysis for important outcomes
    if (this.isImportantOutcome(outcome)) {
      await this.triggerAnalysis(actionEvent, outcome);
    }
  }
  
  private async flush(): Promise<void> {
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
  
  private async processEvents(events: LearningEvent[]): Promise<void> {
    // Group by type for batch processing
    const byType = this.groupByType(events);
    
    for (const [type, typeEvents] of byType) {
      const processor = this.getProcessor(type);
      if (processor) {
        await processor.process(typeEvents);
      }
    }
  }
}
```

### Step 3: Create Pattern Detector
Build `src/rmapp/learning/pattern_detector.ts`:
```typescript
class PatternDetector {
  private detectors: Map<PatternType, Detector> = new Map();
  
  constructor() {
    this.registerDetectors();
  }
  
  async detectPatterns(
    events: LearningEvent[]
  ): Promise<Pattern[]> {
    const patterns: Pattern[] = [];
    
    // Run each detector
    for (const [type, detector] of this.detectors) {
      const detected = await detector.detect(events);
      patterns.push(...detected);
    }
    
    // Merge similar patterns
    const merged = this.mergePatterns(patterns);
    
    // Calculate confidence
    const withConfidence = merged.map(pattern => ({
      ...pattern,
      confidence: this.calculateConfidence(pattern)
    }));
    
    // Filter by minimum confidence
    return withConfidence.filter(p => p.confidence > 0.6);
  }
  
  private registerDetectors(): void {
    this.detectors.set(
      PatternType.CodeStyle,
      new CodeStyleDetector()
    );
    
    this.detectors.set(
      PatternType.ErrorHandling,
      new ErrorHandlingDetector()
    );
    
    this.detectors.set(
      PatternType.ReviewFeedback,
      new ReviewFeedbackDetector()
    );
    
    this.detectors.set(
      PatternType.ImplementationApproach,
      new ImplementationDetector()
    );
  }
  
  private mergePatterns(patterns: Pattern[]): Pattern[] {
    const merged: Pattern[] = [];
    const processed = new Set<string>();
    
    for (const pattern of patterns) {
      if (processed.has(pattern.id)) continue;
      
      // Find similar patterns
      const similar = patterns.filter(p =>
        p.id !== pattern.id &&
        this.areSimilar(pattern, p)
      );
      
      if (similar.length > 0) {
        // Merge into one pattern
        const mergedPattern = this.merge(pattern, ...similar);
        merged.push(mergedPattern);
        
        // Mark all as processed
        processed.add(pattern.id);
        similar.forEach(p => processed.add(p.id));
      } else {
        merged.push(pattern);
        processed.add(pattern.id);
      }
    }
    
    return merged;
  }
}

class CodeStyleDetector implements Detector {
  async detect(events: LearningEvent[]): Promise<Pattern[]> {
    const codeEvents = events.filter(e => 
      e.type === EventType.CodeGeneration
    );
    
    const patterns: Pattern[] = [];
    
    // Detect naming patterns
    const namingPattern = this.detectNamingPattern(codeEvents);
    if (namingPattern) patterns.push(namingPattern);
    
    // Detect structure patterns
    const structurePattern = this.detectStructurePattern(codeEvents);
    if (structurePattern) patterns.push(structurePattern);
    
    // Detect import patterns
    const importPattern = this.detectImportPattern(codeEvents);
    if (importPattern) patterns.push(importPattern);
    
    return patterns;
  }
  
  private detectNamingPattern(events: LearningEvent[]): Pattern | null {
    const names: NameExample[] = [];
    
    for (const event of events) {
      if (event.context.generatedCode) {
        const extracted = this.extractNames(event.context.generatedCode);
        names.push(...extracted);
      }
    }
    
    // Analyze naming conventions
    const conventions = this.analyzeNamingConventions(names);
    
    if (conventions.length === 0) return null;
    
    return {
      id: 'naming-convention',
      type: PatternType.CodeStyle,
      signature: {
        conventions: conventions.map(c => c.pattern)
      },
      occurrences: names.length,
      confidence: 0, // Will be calculated
      examples: names.slice(0, 10),
      recommendations: conventions.map(c => c.recommendation)
    };
  }
}
```

### Step 4: Implement Behavior Learner
Create `src/rmapp/learning/behavior_learner.ts`:
```typescript
class BehaviorLearner {
  async learnBehaviors(
    events: LearningEvent[],
    patterns: Pattern[]
  ): Promise<LearnedBehavior[]> {
    const behaviors: LearnedBehavior[] = [];
    
    // Learn from successful outcomes
    const successful = this.filterSuccessful(events);
    behaviors.push(...this.learnFromSuccess(successful, patterns));
    
    // Learn from failures
    const failed = this.filterFailed(events);
    behaviors.push(...this.learnFromFailures(failed, patterns));
    
    // Learn from feedback
    const withFeedback = this.filterWithFeedback(events);
    behaviors.push(...this.learnFromFeedback(withFeedback));
    
    // Validate behaviors
    const validated = await this.validateBehaviors(behaviors);
    
    return validated;
  }
  
  private learnFromSuccess(
    events: LearningEvent[],
    patterns: Pattern[]
  ): LearnedBehavior[] {
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
          behaviors.push({
            trigger,
            action: this.generalizeAction(successfulActions),
            confidence: successfulActions.length / actionEvents.length,
            evidence: successfulActions.map(a => a.id),
            exceptions: this.findExceptions(actionEvents, trigger)
          });
        }
      }
    }
    
    return behaviors;
  }
  
  private learnFromFeedback(
    events: LearningEvent[]
  ): LearnedBehavior[] {
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
}
```

### Step 5: Build Preference Tracker
Implement `src/rmapp/learning/preference_tracker.ts`:
```typescript
class PreferenceTracker {
  async trackPreferences(
    events: LearningEvent[]
  ): Promise<Preferences> {
    const preferences: Preferences = {
      codeStyle: await this.extractCodeStylePreferences(events),
      communication: await this.extractCommunicationPreferences(events),
      workflow: await this.extractWorkflowPreferences(events),
      tools: await this.extractToolPreferences(events)
    };
    
    return preferences;
  }
  
  private async extractCodeStylePreferences(
    events: LearningEvent[]
  ): Promise<CodeStylePreferences> {
    const preferences: CodeStylePreferences = {
      indentation: 'spaces',
      indentSize: 2,
      quotes: 'single',
      semicolons: false,
      trailingComma: true,
      lineLength: 80,
      namingConventions: {}
    };
    
    // Analyze generated code
    const codeEvents = events.filter(e => e.context.generatedCode);
    
    for (const event of codeEvents) {
      const code = event.context.generatedCode;
      
      // Detect indentation
      const indentInfo = this.detectIndentation(code);
      if (indentInfo) {
        preferences.indentation = indentInfo.type;
        preferences.indentSize = indentInfo.size;
      }
      
      // Detect quote style
      const quoteStyle = this.detectQuoteStyle(code);
      if (quoteStyle) {
        preferences.quotes = quoteStyle;
      }
      
      // Continue for other preferences...
    }
    
    // Apply feedback adjustments
    const feedbackAdjusted = this.applyFeedbackToPreferences(
      preferences,
      events
    );
    
    return feedbackAdjusted;
  }
  
  private extractWorkflowPreferences(
    events: LearningEvent[]
  ): WorkflowPreferences {
    const preferences: WorkflowPreferences = {
      autoCommit: false,
      commitGranularity: 'feature',
      prDescription: 'detailed',
      testFirst: false,
      reviewResponseTime: 'immediate'
    };
    
    // Analyze workflow events
    const workflowEvents = events.filter(e =>
      e.type === EventType.IssueImplementation ||
      e.type === EventType.ReviewResponse
    );
    
    // Detect commit preferences
    const commitEvents = workflowEvents.filter(e =>
      e.action.type === 'commit'
    );
    
    if (commitEvents.length > 0) {
      // Analyze commit frequency
      const avgFilesPerCommit = this.calculateAvgFilesPerCommit(commitEvents);
      
      if (avgFilesPerCommit < 3) {
        preferences.commitGranularity = 'atomic';
      } else if (avgFilesPerCommit > 10) {
        preferences.commitGranularity = 'feature';
      } else {
        preferences.commitGranularity = 'logical';
      }
    }
    
    return preferences;
  }
}
```

### Step 6: Create Model Trainer
Build `src/rmapp/learning/trainer.ts`:
```typescript
class ModelTrainer {
  async trainModel(
    events: LearningEvent[],
    existingModel?: LearningModel
  ): Promise<LearningModel> {
    // Detect patterns
    const patterns = await this.patternDetector.detectPatterns(events);
    
    // Learn behaviors
    const behaviors = await this.behaviorLearner.learnBehaviors(
      events,
      patterns
    );
    
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
        patterns,
        behaviors,
        preferences,
        statistics,
        version: existingModel.version + 1
      });
    } else {
      model = {
        patterns,
        behaviors,
        preferences,
        statistics,
        version: 1
      };
    }
    
    // Validate model
    const validated = await this.validateModel(model);
    
    // Optimize model
    const optimized = this.optimizeModel(validated);
    
    return optimized;
  }
  
  private mergeModels(
    existing: LearningModel,
    new: LearningModel
  ): LearningModel {
    return {
      patterns: this.mergePatterns(existing.patterns, new.patterns),
      behaviors: this.mergeBehaviors(existing.behaviors, new.behaviors),
      preferences: this.mergePreferences(existing.preferences, new.preferences),
      statistics: this.mergeStatistics(existing.statistics, new.statistics),
      version: new.version
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
}
```

### Step 7: Implement Decision Enhancer
Create `src/rmapp/learning/decision_enhancer.ts`:
```typescript
class DecisionEnhancer {
  constructor(
    private model: LearningModel,
    private contextGatherer: ContextGatherer
  ) {}
  
  async enhanceDecision(
    decision: Decision,
    context: DecisionContext
  ): Promise<EnhancedDecision> {
    // Find relevant patterns
    const relevantPatterns = this.findRelevantPatterns(
      decision,
      context
    );
    
    // Find applicable behaviors
    const applicableBehaviors = this.findApplicableBehaviors(
      decision,
      context
    );
    
    // Apply preferences
    const withPreferences = this.applyPreferences(
      decision,
      this.model.preferences
    );
    
    // Generate recommendations
    const recommendations = this.generateRecommendations(
      withPreferences,
      relevantPatterns,
      applicableBehaviors
    );
    
    // Calculate confidence
    const confidence = this.calculateConfidence(
      recommendations,
      context
    );
    
    return {
      original: decision,
      enhanced: withPreferences,
      recommendations,
      confidence,
      evidence: this.gatherEvidence(relevantPatterns, applicableBehaviors)
    };
  }
  
  private generateRecommendations(
    decision: Decision,
    patterns: Pattern[],
    behaviors: LearnedBehavior[]
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];
    
    // Pattern-based recommendations
    for (const pattern of patterns) {
      if (pattern.recommendations.length > 0) {
        recommendations.push({
          type: 'pattern',
          source: pattern.id,
          suggestion: pattern.recommendations[0],
          confidence: pattern.confidence,
          examples: pattern.examples.slice(0, 3)
        });
      }
    }
    
    // Behavior-based recommendations
    for (const behavior of behaviors) {
      if (this.behaviorApplies(behavior, decision)) {
        recommendations.push({
          type: 'behavior',
          source: behavior.id,
          suggestion: this.formatBehaviorSuggestion(behavior),
          confidence: behavior.confidence,
          evidence: behavior.evidence.slice(0, 3)
        });
      }
    }
    
    // Sort by confidence
    recommendations.sort((a, b) => b.confidence - a.confidence);
    
    return recommendations;
  }
}
```

### Step 8: Create Learning Pipeline
Combine in `src/rmapp/learning/pipeline.ts`:
```typescript
class LearningPipeline {
  private model: LearningModel | null = null;
  private updateInterval: NodeJS.Timer;
  
  constructor(
    private collector: LearningEventCollector,
    private trainer: ModelTrainer,
    private storage: ModelStorage,
    private options: PipelineOptions = {}
  ) {
    this.initialize();
  }
  
  private async initialize(): Promise<void> {
    // Load existing model
    this.model = await this.storage.loadLatest();
    
    // Start periodic updates
    this.startUpdateCycle();
    
    // Register event hooks
    this.registerHooks();
  }
  
  async learn(event: LearningEvent): Promise<void> {
    // Collect event
    await this.collector.collectEvent(event);
    
    // Immediate learning for critical events
    if (this.isCritical(event)) {
      await this.immediateLearn(event);
    }
  }
  
  async enhanceDecision(
    decision: Decision,
    context: DecisionContext
  ): Promise<EnhancedDecision> {
    if (!this.model) {
      return { original: decision, enhanced: decision, recommendations: [] };
    }
    
    const enhancer = new DecisionEnhancer(this.model, this.contextGatherer);
    return enhancer.enhanceDecision(decision, context);
  }
  
  private async updateModel(): Promise<void> {
    // Get recent events
    const recentEvents = await this.collector.getRecentEvents(
      this.options.updateWindow || 24 * 60 * 60 * 1000 // 24 hours
    );
    
    if (recentEvents.length < this.options.minEventsForUpdate || 10) {
      return; // Not enough data
    }
    
    // Train new model
    const newModel = await this.trainer.trainModel(
      recentEvents,
      this.model
    );
    
    // Validate improvement
    if (this.model && !this.isImprovement(this.model, newModel)) {
      console.log('New model does not show improvement, skipping update');
      return;
    }
    
    // Save and update
    await this.storage.save(newModel);
    this.model = newModel;
    
    // Notify listeners
    this.emit('modelUpdated', newModel);
  }
  
  private isImprovement(
    oldModel: LearningModel,
    newModel: LearningModel
  ): boolean {
    // Compare key metrics
    const oldMetrics = this.calculateModelMetrics(oldModel);
    const newMetrics = this.calculateModelMetrics(newModel);
    
    return (
      newMetrics.patternConfidence > oldMetrics.patternConfidence ||
      newMetrics.behaviorAccuracy > oldMetrics.behaviorAccuracy ||
      newMetrics.coverageScore > oldMetrics.coverageScore
    );
  }
  
  getInsights(): LearningInsights {
    if (!this.model) {
      return { insights: [], recommendations: [] };
    }
    
    const insights: Insight[] = [];
    
    // Pattern insights
    const strongPatterns = this.model.patterns.filter(p => p.confidence > 0.8);
    if (strongPatterns.length > 0) {
      insights.push({
        type: 'pattern',
        title: 'Strong Patterns Detected',
        description: `Found ${strongPatterns.length} high-confidence patterns`,
        data: strongPatterns
      });
    }
    
    // Behavior insights
    const consistentBehaviors = this.model.behaviors.filter(b => 
      b.confidence > 0.9 && b.exceptions.length === 0
    );
    if (consistentBehaviors.length > 0) {
      insights.push({
        type: 'behavior',
        title: 'Consistent Behaviors',
        description: 'These actions always produce good results',
        data: consistentBehaviors
      });
    }
    
    // Improvement recommendations
    const recommendations = this.generateImprovementRecommendations();
    
    return { insights, recommendations };
  }
}
```

## Testing Strategy
1. Test event collection accuracy
2. Test pattern detection algorithms
3. Test behavior learning logic
4. Test preference tracking
5. Test model training and updates
6. Test decision enhancement

## Success Criteria
- [ ] Accurately identifies patterns
- [ ] Learns from feedback effectively
- [ ] Improves decisions over time
- [ ] Adapts to team preferences
- [ ] Provides actionable insights