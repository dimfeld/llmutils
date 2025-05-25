import type {
  Decision,
  DecisionContext,
  EnhancedDecision,
  LearningModel,
  Pattern,
  LearnedBehavior,
  Recommendation,
  Evidence,
  Preferences,
  DecisionOption
} from './types.js';

export class DecisionEnhancer {
  constructor(
    private model: LearningModel
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
    
    // Gather evidence
    const evidence = this.gatherEvidence(relevantPatterns, applicableBehaviors);
    
    return {
      original: decision,
      enhanced: withPreferences,
      recommendations,
      confidence,
      evidence
    };
  }
  
  private findRelevantPatterns(
    decision: Decision,
    context: DecisionContext
  ): Pattern[] {
    const relevant: Pattern[] = [];
    
    for (const pattern of this.model.patterns) {
      // Check if pattern applies to this decision type
      if (this.patternApplies(pattern, decision, context)) {
        relevant.push(pattern);
      }
    }
    
    // Sort by relevance and confidence
    return relevant.sort((a, b) => {
      const scoreA = this.calculatePatternRelevance(a, decision, context) * a.confidence;
      const scoreB = this.calculatePatternRelevance(b, decision, context) * b.confidence;
      return scoreB - scoreA;
    });
  }
  
  private findApplicableBehaviors(
    decision: Decision,
    context: DecisionContext
  ): LearnedBehavior[] {
    const applicable: LearnedBehavior[] = [];
    
    for (const behavior of this.model.behaviors) {
      // Check if behavior trigger matches current context
      if (this.triggerMatches(behavior.trigger, decision, context)) {
        // Check for exceptions
        const hasException = behavior.exceptions.some(exception =>
          this.evaluateCondition(decision, context, exception.condition)
        );
        
        if (!hasException) {
          applicable.push(behavior);
        }
      }
    }
    
    // Sort by confidence
    return applicable.sort((a, b) => b.confidence - a.confidence);
  }
  
  private applyPreferences(
    decision: Decision,
    preferences: Preferences
  ): Decision {
    const enhanced = { ...decision };
    
    // Apply preferences to decision options
    enhanced.options = decision.options.map(option => {
      const enhancedOption = { ...option };
      
      // Adjust scores based on preferences
      if (this.optionMatchesPreferences(option, preferences)) {
        enhancedOption.score *= 1.2; // Boost preferred options
        enhancedOption.pros = [
          ...enhancedOption.pros,
          'Matches team preferences'
        ];
      } else if (this.optionViolatesPreferences(option, preferences)) {
        enhancedOption.score *= 0.8; // Penalize non-preferred options
        enhancedOption.cons = [
          ...enhancedOption.cons,
          'Conflicts with team preferences'
        ];
      }
      
      return enhancedOption;
    });
    
    // Re-sort options by score
    enhanced.options.sort((a, b) => b.score - a.score);
    
    return enhanced;
  }
  
  private generateRecommendations(
    decision: Decision,
    patterns: Pattern[],
    behaviors: LearnedBehavior[]
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];
    
    // Pattern-based recommendations
    for (const pattern of patterns.slice(0, 5)) { // Top 5 patterns
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
    for (const behavior of behaviors.slice(0, 5)) { // Top 5 behaviors
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
    
    // Preference-based recommendations
    const preferenceRecs = this.generatePreferenceRecommendations(
      decision,
      this.model.preferences
    );
    recommendations.push(...preferenceRecs);
    
    // Sort by confidence and deduplicate
    const unique = this.deduplicateRecommendations(recommendations);
    return unique.sort((a, b) => b.confidence - a.confidence);
  }
  
  private calculateConfidence(
    recommendations: Recommendation[],
    context: DecisionContext
  ): number {
    let confidence = 0.5; // Base confidence
    
    // Boost for high-confidence recommendations
    const highConfidenceRecs = recommendations.filter(r => r.confidence > 0.8);
    confidence += highConfidenceRecs.length * 0.1;
    
    // Boost for consistent recommendations
    const consistent = this.areRecommendationsConsistent(recommendations);
    if (consistent) {
      confidence += 0.2;
    }
    
    // Boost for matching context
    if (context.previousAttempts && context.previousAttempts > 0) {
      // We have experience with this type of decision
      confidence += 0.1;
    }
    
    // Adjust for urgency
    if (context.urgency === 'high') {
      // Less time to be confident
      confidence *= 0.9;
    }
    
    return Math.min(confidence, 0.95); // Cap at 95%
  }
  
  private gatherEvidence(
    patterns: Pattern[],
    behaviors: LearnedBehavior[]
  ): Evidence[] {
    const evidence: Evidence[] = [];
    
    // Evidence from patterns
    for (const pattern of patterns.slice(0, 3)) {
      evidence.push({
        type: 'pattern',
        source: pattern.id,
        relevance: pattern.confidence,
        data: {
          type: pattern.type,
          occurrences: pattern.occurrences,
          lastSeen: pattern.lastSeen,
          examples: pattern.examples.length
        }
      });
    }
    
    // Evidence from behaviors
    for (const behavior of behaviors.slice(0, 3)) {
      evidence.push({
        type: 'behavior',
        source: behavior.id,
        relevance: behavior.confidence,
        data: {
          trigger: behavior.trigger.type,
          action: behavior.action.type,
          evidenceCount: behavior.evidence.length,
          lastUpdated: behavior.lastUpdated
        }
      });
    }
    
    // Evidence from statistics
    evidence.push({
      type: 'statistics',
      source: 'model',
      relevance: 0.7,
      data: {
        successRate: this.model.statistics.successRate,
        patternAccuracy: this.model.statistics.patternAccuracy,
        behaviorAccuracy: this.model.statistics.behaviorAccuracy
      }
    });
    
    return evidence;
  }
  
  private patternApplies(
    pattern: Pattern,
    decision: Decision,
    context: DecisionContext
  ): boolean {
    // Check pattern conditions
    if (pattern.signature.conditions) {
      for (const condition of pattern.signature.conditions) {
        if (!this.evaluateCondition(decision, context, condition)) {
          return false;
        }
      }
    }
    
    // Check pattern type relevance
    const relevantTypes = this.getRelevantPatternTypes(decision.type);
    return relevantTypes.includes(pattern.type);
  }
  
  private calculatePatternRelevance(
    pattern: Pattern,
    decision: Decision,
    context: DecisionContext
  ): number {
    let relevance = 0.5;
    
    // Check recency
    const daysSinceLastSeen = 
      (Date.now() - pattern.lastSeen.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLastSeen < 7) {
      relevance += 0.2;
    } else if (daysSinceLastSeen < 30) {
      relevance += 0.1;
    }
    
    // Check occurrences
    if (pattern.occurrences > 10) {
      relevance += 0.2;
    } else if (pattern.occurrences > 5) {
      relevance += 0.1;
    }
    
    // Check context match
    if (this.contextMatches(pattern, context)) {
      relevance += 0.2;
    }
    
    return Math.min(relevance, 1.0);
  }
  
  private triggerMatches(
    trigger: any,
    decision: Decision,
    context: DecisionContext
  ): boolean {
    for (const condition of trigger.conditions) {
      if (!this.evaluateCondition(decision, context, condition)) {
        return false;
      }
    }
    
    return true;
  }
  
  private evaluateCondition(
    decision: Decision,
    context: DecisionContext,
    condition: any
  ): boolean {
    const value = this.getFieldValue(decision, context, condition.field);
    
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
  
  private getFieldValue(
    decision: Decision,
    context: DecisionContext,
    field: string
  ): any {
    // Handle nested field access
    const parts = field.split('.');
    let obj: any = { decision, context };
    
    for (const part of parts) {
      obj = obj?.[part];
      if (obj === undefined) return undefined;
    }
    
    return obj;
  }
  
  private optionMatchesPreferences(
    option: DecisionOption,
    preferences: Preferences
  ): boolean {
    // Check if option aligns with preferences
    const action = option.action;
    
    // Check workflow preferences
    if (preferences.workflow.testFirst && 
        action.type === 'generate_code' &&
        !action.parameters.includeTests) {
      return false;
    }
    
    // Check other preferences...
    
    return true;
  }
  
  private optionViolatesPreferences(
    option: DecisionOption,
    preferences: Preferences
  ): boolean {
    // Check if option conflicts with preferences
    const action = option.action;
    
    // Example: Check commit granularity
    if (preferences.workflow.commitGranularity === 'atomic' &&
        action.type === 'commit' &&
        action.parameters.files?.length > 5) {
      return true;
    }
    
    return false;
  }
  
  private behaviorApplies(
    behavior: LearnedBehavior,
    decision: Decision
  ): boolean {
    // Check if behavior action is compatible with decision options
    return decision.options.some(option =>
      option.action.type === behavior.action.type
    );
  }
  
  private formatBehaviorSuggestion(behavior: LearnedBehavior): string {
    const { action, confidence } = behavior;
    const confidenceText = confidence > 0.8 ? 'Highly recommended' :
                          confidence > 0.6 ? 'Recommended' : 'Suggested';
    
    return `${confidenceText}: ${action.description}`;
  }
  
  private generatePreferenceRecommendations(
    decision: Decision,
    preferences: Preferences
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];
    
    // Code style recommendations
    if (decision.type === 'code_generation') {
      recommendations.push({
        type: 'preference',
        source: 'code_style',
        suggestion: this.formatCodeStyleSuggestion(preferences.codeStyle),
        confidence: 0.9
      });
    }
    
    // Workflow recommendations
    if (preferences.workflow.testFirst) {
      recommendations.push({
        type: 'preference',
        source: 'workflow',
        suggestion: 'Consider writing tests first (TDD approach preferred)',
        confidence: 0.85
      });
    }
    
    // Communication recommendations
    if (decision.type === 'create_pr') {
      recommendations.push({
        type: 'preference',
        source: 'communication',
        suggestion: `Use ${preferences.communication.prDescriptionStyle} PR descriptions`,
        confidence: 0.9
      });
    }
    
    return recommendations;
  }
  
  private formatCodeStyleSuggestion(style: any): string {
    const parts: string[] = [];
    
    parts.push(`Use ${style.indentation} with ${style.indentSize} spaces`);
    parts.push(`Prefer ${style.quotes} quotes`);
    parts.push(style.semicolons ? 'Use semicolons' : 'Omit semicolons');
    parts.push(style.trailingComma ? 'Use trailing commas' : 'No trailing commas');
    
    return parts.join(', ');
  }
  
  private deduplicateRecommendations(
    recommendations: Recommendation[]
  ): Recommendation[] {
    const seen = new Set<string>();
    const unique: Recommendation[] = [];
    
    for (const rec of recommendations) {
      const key = rec.suggestion.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(rec);
      }
    }
    
    return unique;
  }
  
  private areRecommendationsConsistent(
    recommendations: Recommendation[]
  ): boolean {
    // Check if recommendations don't conflict
    const suggestions = recommendations.map(r => r.suggestion.toLowerCase());
    
    // Simple conflict detection
    const hasConflict = suggestions.some((s1, i) =>
      suggestions.some((s2, j) =>
        i !== j && this.conflictingSuggestions(s1, s2)
      )
    );
    
    return !hasConflict;
  }
  
  private conflictingSuggestions(s1: string, s2: string): boolean {
    // Simple conflict detection based on opposites
    const conflicts = [
      ['use semicolons', 'omit semicolons'],
      ['spaces', 'tabs'],
      ['single quotes', 'double quotes'],
      ['test first', 'implement first']
    ];
    
    for (const [a, b] of conflicts) {
      if ((s1.includes(a) && s2.includes(b)) ||
          (s1.includes(b) && s2.includes(a))) {
        return true;
      }
    }
    
    return false;
  }
  
  private getRelevantPatternTypes(decisionType: string): string[] {
    const typeMap: Record<string, string[]> = {
      'code_generation': ['code_style', 'implementation_approach', 'testing_strategy'],
      'error_recovery': ['error_handling'],
      'review_response': ['review_feedback', 'communication'],
      'create_pr': ['communication', 'code_style'],
      'commit': ['code_style', 'communication']
    };
    
    return typeMap[decisionType] || [];
  }
  
  private contextMatches(pattern: Pattern, context: DecisionContext): boolean {
    // Check if pattern's context matches current context
    if (pattern.signature.features.issue && context.issue) {
      return pattern.signature.features.issue === context.issue;
    }
    
    if (pattern.signature.features.pr && context.pr) {
      return pattern.signature.features.pr === context.pr;
    }
    
    // Check file patterns
    if (pattern.signature.features.filePattern && context.files) {
      const filePattern = new RegExp(pattern.signature.features.filePattern);
      return context.files.some(f => filePattern.test(f));
    }
    
    return false;
  }
}