import type {
  LearningEvent,
  LearningModel,
  Decision,
  DecisionContext,
  EnhancedDecision,
  LearningInsights,
  Insight,
  ImprovementRecommendation
} from './types.js';
import { EventEmitter } from 'node:events';
import { LearningEventCollector } from './collector.js';
import { ModelTrainer } from './trainer.js';
import { DecisionEnhancer } from './decision_enhancer.js';
import { FileEventStorage, FileModelStorage } from './storage.js';

export interface PipelineOptions {
  storagePath?: string;
  updateInterval?: number;
  updateWindow?: number;
  minEventsForUpdate?: number;
  bufferSize?: number;
  flushInterval?: number;
}

interface ModelMetrics {
  patternConfidence: number;
  behaviorAccuracy: number;
  coverageScore: number;
}

export class LearningPipeline extends EventEmitter {
  private model: LearningModel | null = null;
  private updateTimer?: NodeJS.Timeout;
  private collector: LearningEventCollector;
  private trainer: ModelTrainer;
  private eventStorage: FileEventStorage;
  private modelStorage: FileModelStorage;
  private isUpdating: boolean = false;
  
  constructor(
    private options: PipelineOptions = {}
  ) {
    super();
    
    const storagePath = options.storagePath || '.learning';
    
    // Initialize storage
    this.eventStorage = new FileEventStorage(storagePath);
    this.modelStorage = new FileModelStorage(storagePath);
    
    // Initialize components
    this.collector = new LearningEventCollector(this.eventStorage, {
      bufferSize: options.bufferSize,
      flushInterval: options.flushInterval
    });
    
    this.trainer = new ModelTrainer();
    
    // Start initialization
    this.initialize().catch(error => {
      console.error('Failed to initialize learning pipeline:', error);
      this.emit('error', error);
    });
  }
  
  private async initialize(): Promise<void> {
    try {
      // Initialize storage
      await this.eventStorage.initialize();
      await this.modelStorage.initialize();
      
      // Load existing model
      this.model = await this.modelStorage.loadLatest();
      
      if (this.model) {
        console.log(`Loaded learning model v${this.model.version}`);
        this.emit('modelLoaded', this.model);
      } else {
        console.log('No existing learning model found');
      }
      
      // Start periodic updates
      this.startUpdateCycle();
      
      // Register event processors
      this.registerEventProcessors();
      
      this.emit('initialized');
    } catch (error) {
      console.error('Initialization error:', error);
      throw error;
    }
  }
  
  async learn(event: LearningEvent): Promise<void> {
    try {
      // Collect event
      await this.collector.collectEvent(event);
      
      // Immediate learning for critical events
      if (this.isCritical(event)) {
        await this.immediateLearn(event);
      }
      
      this.emit('eventLearned', event);
    } catch (error) {
      console.error('Failed to learn from event:', error);
      this.emit('error', error);
    }
  }
  
  async recordOutcome(actionId: string, outcome: any): Promise<void> {
    try {
      await this.collector.collectOutcome(actionId, outcome);
      this.emit('outcomeRecorded', { actionId, outcome });
    } catch (error) {
      console.error('Failed to record outcome:', error);
      this.emit('error', error);
    }
  }
  
  async recordFeedback(
    eventId: string,
    feedback: {
      userId: string;
      sentiment: 'positive' | 'negative' | 'neutral';
      message?: string;
      suggestions?: string[];
    }
  ): Promise<void> {
    try {
      await this.collector.collectFeedback(eventId, feedback);
      this.emit('feedbackRecorded', { eventId, feedback });
      
      // Trigger immediate update for feedback
      await this.updateModel();
    } catch (error) {
      console.error('Failed to record feedback:', error);
      this.emit('error', error);
    }
  }
  
  async enhanceDecision(
    decision: Decision,
    context: DecisionContext
  ): Promise<EnhancedDecision> {
    if (!this.model) {
      // No model yet, return original decision
      return {
        original: decision,
        enhanced: decision,
        recommendations: [],
        confidence: 0.5
      };
    }
    
    try {
      const enhancer = new DecisionEnhancer(this.model);
      const enhanced = await enhancer.enhanceDecision(decision, context);
      
      this.emit('decisionEnhanced', { decision, enhanced });
      
      return enhanced;
    } catch (error) {
      console.error('Failed to enhance decision:', error);
      this.emit('error', error);
      
      // Return original decision on error
      return {
        original: decision,
        enhanced: decision,
        recommendations: [],
        confidence: 0.5
      };
    }
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
        description: `Found ${strongPatterns.length} high-confidence patterns in your workflow`,
        importance: 0.9,
        data: strongPatterns.map(p => ({
          type: p.type,
          confidence: p.confidence,
          occurrences: p.occurrences,
          recommendations: p.recommendations
        }))
      });
    }
    
    // Behavior insights
    const consistentBehaviors = this.model.behaviors.filter(b => 
      b.confidence > 0.9 && b.exceptions.length === 0
    );
    if (consistentBehaviors.length > 0) {
      insights.push({
        type: 'behavior',
        title: 'Consistent Successful Behaviors',
        description: 'These actions consistently produce good results',
        importance: 0.85,
        data: consistentBehaviors.map(b => ({
          trigger: b.trigger.type,
          action: b.action.description,
          confidence: b.confidence,
          evidence: b.evidence.length
        }))
      });
    }
    
    // Performance insights
    const stats = this.model.statistics;
    insights.push({
      type: 'performance',
      title: 'Learning System Performance',
      description: 'Current model accuracy and improvement metrics',
      importance: 0.7,
      data: {
        successRate: `${(stats.successRate * 100).toFixed(1)}%`,
        patternAccuracy: `${(stats.patternAccuracy * 100).toFixed(1)}%`,
        behaviorAccuracy: `${(stats.behaviorAccuracy * 100).toFixed(1)}%`,
        improvementRate: stats.improvementRate > 0 ? 
          `+${(stats.improvementRate * 100).toFixed(1)}%` : 
          `${(stats.improvementRate * 100).toFixed(1)}%`
      }
    });
    
    // Preference insights
    const prefs = this.model.preferences;
    insights.push({
      type: 'preferences',
      title: 'Detected Preferences',
      description: 'Your team\'s coding and workflow preferences',
      importance: 0.8,
      data: {
        codeStyle: {
          indentation: `${prefs.codeStyle.indentation} (${prefs.codeStyle.indentSize})`,
          quotes: prefs.codeStyle.quotes,
          semicolons: prefs.codeStyle.semicolons
        },
        workflow: {
          commitStyle: prefs.workflow.commitGranularity,
          testFirst: prefs.workflow.testFirst,
          autoCommit: prefs.workflow.autoCommit
        }
      }
    });
    
    // Generate improvement recommendations
    const recommendations = this.generateImprovementRecommendations();
    
    return { insights, recommendations };
  }
  
  async getStats(): Promise<any> {
    const eventStats = await this.eventStorage.getStats();
    const modelVersions = await this.modelStorage.listVersions();
    
    return {
      events: eventStats,
      model: this.model ? {
        version: this.model.version,
        patterns: this.model.patterns.length,
        behaviors: this.model.behaviors.length,
        lastUpdated: this.model.updatedAt
      } : null,
      versions: modelVersions.length,
      pipeline: {
        isUpdating: this.isUpdating,
        updateInterval: this.options.updateInterval,
        minEventsForUpdate: this.options.minEventsForUpdate
      }
    };
  }
  
  async close(): Promise<void> {
    // Stop update timer
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
    
    // Close collector
    await this.collector.close();
    
    // Final model save if needed
    if (this.model) {
      await this.modelStorage.save(this.model);
    }
    
    this.emit('closed');
  }
  
  private startUpdateCycle(): void {
    const interval = this.options.updateInterval || 3600000; // 1 hour default
    
    this.updateTimer = setInterval(async () => {
      await this.updateModel();
    }, interval);
  }
  
  private async updateModel(): Promise<void> {
    if (this.isUpdating) {
      console.log('Update already in progress, skipping');
      return;
    }
    
    this.isUpdating = true;
    this.emit('updateStarted');
    
    try {
      // Get recent events
      const recentEvents = await this.collector.getRecentEvents(
        this.options.updateWindow || 24 * 60 * 60 * 1000 // 24 hours
      );
      
      if (recentEvents.length < (this.options.minEventsForUpdate || 10)) {
        console.log(`Not enough events for update (${recentEvents.length})`);
        return;
      }
      
      console.log(`Updating model with ${recentEvents.length} recent events`);
      
      // Train new model
      const newModel = await this.trainer.trainModel(
        recentEvents,
        this.model || undefined
      );
      
      // Validate improvement
      if (this.model && !this.isImprovement(this.model, newModel)) {
        console.log('New model does not show improvement, skipping update');
        this.emit('updateSkipped', { reason: 'no_improvement' });
        return;
      }
      
      // Save and update
      await this.modelStorage.save(newModel);
      this.model = newModel;
      
      console.log(`Model updated to v${newModel.version}`);
      
      // Cleanup old versions
      await this.modelStorage.cleanup(5); // Keep last 5 versions
      
      // Notify listeners
      this.emit('modelUpdated', newModel);
    } catch (error) {
      console.error('Failed to update model:', error);
      this.emit('updateFailed', error);
    } finally {
      this.isUpdating = false;
      this.emit('updateCompleted');
    }
  }
  
  private async immediateLearn(event: LearningEvent): Promise<void> {
    // For critical events, update patterns/behaviors immediately
    console.log('Immediate learning triggered for:', event.type);
    
    // Small batch update with just this event and recent related events
    const relatedEvents = await this.findRelatedEvents(event);
    const events = [event, ...relatedEvents];
    
    if (events.length >= 3) {
      await this.updateModel();
    }
  }
  
  private async findRelatedEvents(event: LearningEvent): Promise<LearningEvent[]> {
    // Find events with similar context
    const window = 7 * 24 * 60 * 60 * 1000; // 7 days
    const allEvents = await this.collector.getRecentEvents(window);
    
    return allEvents.filter(e => 
      e.id !== event.id &&
      e.type === event.type &&
      this.haveSimilarContext(e, event)
    ).slice(0, 10);
  }
  
  private haveSimilarContext(e1: LearningEvent, e2: LearningEvent): boolean {
    // Simple context similarity check
    if (e1.action.type !== e2.action.type) return false;
    
    // Check for same issue/PR
    if (e1.context.issue && e1.context.issue === e2.context.issue) return true;
    if (e1.context.pr && e1.context.pr === e2.context.pr) return true;
    
    // Check for similar files
    if (e1.context.fileChanges && e2.context.fileChanges) {
      const files1 = new Set(e1.context.fileChanges.map((f: any) => f.file));
      const files2 = new Set(e2.context.fileChanges.map((f: any) => f.file));
      
      const overlap = Array.from(files1).filter(f => files2.has(f));
      return overlap.length > 0;
    }
    
    return false;
  }
  
  private isCritical(event: LearningEvent): boolean {
    // User feedback is always critical
    if (event.type === 'user_feedback') return true;
    
    // Failed outcomes are critical
    if (!event.outcome.success) return true;
    
    // Large changes are critical
    if (event.outcome.metrics?.linesChanged && 
        event.outcome.metrics.linesChanged > 500) {
      return true;
    }
    
    return false;
  }
  
  private isImprovement(
    oldModel: LearningModel,
    newModel: LearningModel
  ): boolean {
    // Compare key metrics
    const oldMetrics = this.calculateModelMetrics(oldModel);
    const newMetrics = this.calculateModelMetrics(newModel);
    
    // Require improvement in at least one metric
    return (
      newMetrics.patternConfidence > oldMetrics.patternConfidence ||
      newMetrics.behaviorAccuracy > oldMetrics.behaviorAccuracy ||
      newMetrics.coverageScore > oldMetrics.coverageScore
    );
  }
  
  private calculateModelMetrics(model: LearningModel): ModelMetrics {
    // Average pattern confidence
    const patternConfidence = model.patterns.length > 0
      ? model.patterns.reduce((sum, p) => sum + p.confidence, 0) / model.patterns.length
      : 0;
    
    // Behavior accuracy from statistics
    const behaviorAccuracy = model.statistics.behaviorAccuracy;
    
    // Coverage score based on pattern and behavior count
    const coverageScore = Math.min(
      (model.patterns.length + model.behaviors.length) / 50,
      1.0
    );
    
    return {
      patternConfidence,
      behaviorAccuracy,
      coverageScore
    };
  }
  
  private generateImprovementRecommendations(): ImprovementRecommendation[] {
    const recommendations: ImprovementRecommendation[] = [];
    
    if (!this.model) {
      recommendations.push({
        area: 'data_collection',
        suggestion: 'Continue working to collect more learning data',
        expectedImpact: 0.9,
        effort: 'low'
      });
      return recommendations;
    }
    
    // Check for low pattern coverage
    if (this.model.patterns.length < 10) {
      recommendations.push({
        area: 'pattern_diversity',
        suggestion: 'Try different types of tasks to discover more patterns',
        expectedImpact: 0.8,
        effort: 'medium'
      });
    }
    
    // Check for low confidence patterns
    const lowConfidencePatterns = this.model.patterns.filter(p => p.confidence < 0.7);
    if (lowConfidencePatterns.length > this.model.patterns.length * 0.3) {
      recommendations.push({
        area: 'pattern_quality',
        suggestion: 'Focus on consistent approaches to strengthen pattern confidence',
        expectedImpact: 0.7,
        effort: 'low'
      });
    }
    
    // Check for many exceptions in behaviors
    const highExceptionBehaviors = this.model.behaviors.filter(b => 
      b.exceptions.length > 2
    );
    if (highExceptionBehaviors.length > 0) {
      recommendations.push({
        area: 'behavior_consistency',
        suggestion: 'Review behaviors with many exceptions and refine approaches',
        expectedImpact: 0.6,
        effort: 'medium'
      });
    }
    
    // Check success rate
    if (this.model.statistics.successRate < 0.8) {
      recommendations.push({
        area: 'success_rate',
        suggestion: 'Analyze failed attempts to identify improvement opportunities',
        expectedImpact: 0.9,
        effort: 'high'
      });
    }
    
    // Check for stale model
    const daysSinceUpdate = 
      (Date.now() - this.model.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUpdate > 30) {
      recommendations.push({
        area: 'model_freshness',
        suggestion: 'Continue regular work to keep the model updated',
        expectedImpact: 0.5,
        effort: 'low'
      });
    }
    
    return recommendations.sort((a, b) => b.expectedImpact - a.expectedImpact);
  }
  
  private registerEventProcessors(): void {
    // Register processors for different event types
    // These would handle immediate processing of specific events
    
    this.collector.registerProcessor('user_feedback', {
      process: async (events) => {
        // Immediate processing of feedback
        console.log(`Processing ${events.length} feedback events`);
      }
    });
    
    this.collector.registerProcessor('error_recovery', {
      process: async (events) => {
        // Analyze error patterns
        console.log(`Processing ${events.length} error recovery events`);
      }
    });
  }
}