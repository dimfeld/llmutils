import type {
  LearningEvent,
  Preferences,
  CodeStylePreferences,
  CommunicationPreferences,
  WorkflowPreferences,
  ToolPreferences,
  EventType,
  ActionType
} from './types.js';

export class PreferenceTracker {
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
    const codeEvents = events.filter(e => 
      e.type === EventType.CodeGeneration && e.context.generatedCode
    );
    
    if (codeEvents.length === 0) {
      return preferences;
    }
    
    // Track occurrences
    const indentTypes = { spaces: 0, tabs: 0 };
    const indentSizes = new Map<number, number>();
    const quoteTypes = { single: 0, double: 0 };
    const semicolonUsage = { with: 0, without: 0 };
    const trailingCommaUsage = { with: 0, without: 0 };
    const lineLengths: number[] = [];
    
    for (const event of codeEvents) {
      const code = event.context.generatedCode;
      
      // Detect indentation
      const indentInfo = this.detectIndentation(code);
      if (indentInfo) {
        indentTypes[indentInfo.type]++;
        indentSizes.set(
          indentInfo.size,
          (indentSizes.get(indentInfo.size) || 0) + 1
        );
      }
      
      // Detect quote style
      const quoteStyle = this.detectQuoteStyle(code);
      if (quoteStyle) {
        quoteTypes[quoteStyle]++;
      }
      
      // Detect semicolon usage
      const hasSemicolons = this.detectSemicolons(code);
      if (hasSemicolons !== null) {
        semicolonUsage[hasSemicolons ? 'with' : 'without']++;
      }
      
      // Detect trailing comma
      const hasTrailingComma = this.detectTrailingComma(code);
      if (hasTrailingComma !== null) {
        trailingCommaUsage[hasTrailingComma ? 'with' : 'without']++;
      }
      
      // Measure line lengths
      const lengths = this.measureLineLengths(code);
      lineLengths.push(...lengths);
    }
    
    // Set preferences based on majority
    if (indentTypes.spaces > indentTypes.tabs) {
      preferences.indentation = 'spaces';
    } else if (indentTypes.tabs > indentTypes.spaces) {
      preferences.indentation = 'tabs';
    }
    
    // Most common indent size
    if (indentSizes.size > 0) {
      const mostCommon = Array.from(indentSizes.entries())
        .sort((a, b) => b[1] - a[1])[0];
      preferences.indentSize = mostCommon[0];
    }
    
    // Quote preference
    preferences.quotes = quoteTypes.single > quoteTypes.double ? 'single' : 'double';
    
    // Semicolon preference
    preferences.semicolons = semicolonUsage.with > semicolonUsage.without;
    
    // Trailing comma preference
    preferences.trailingComma = trailingCommaUsage.with > trailingCommaUsage.without;
    
    // Line length (90th percentile)
    if (lineLengths.length > 0) {
      lineLengths.sort((a, b) => a - b);
      const percentile90 = Math.floor(lineLengths.length * 0.9);
      preferences.lineLength = lineLengths[percentile90] || 80;
    }
    
    // Apply feedback adjustments
    const feedbackAdjusted = this.applyFeedbackToCodePreferences(
      preferences,
      events
    );
    
    return feedbackAdjusted;
  }
  
  private async extractCommunicationPreferences(
    events: LearningEvent[]
  ): Promise<CommunicationPreferences> {
    const preferences: CommunicationPreferences = {
      prDescriptionStyle: 'detailed',
      commitMessageStyle: 'conventional',
      reviewResponseStyle: 'immediate',
      mentionStyle: 'minimal'
    };
    
    // Analyze PR creation events
    const prEvents = events.filter(e => e.action.type === ActionType.CreatePR);
    if (prEvents.length > 0) {
      preferences.prDescriptionStyle = this.analyzePRStyle(prEvents);
    }
    
    // Analyze commit events
    const commitEvents = events.filter(e => e.action.type === ActionType.Commit);
    if (commitEvents.length > 0) {
      preferences.commitMessageStyle = this.analyzeCommitStyle(commitEvents);
    }
    
    // Analyze review responses
    const reviewEvents = events.filter(e => 
      e.type === EventType.ReviewResponse
    );
    if (reviewEvents.length > 0) {
      preferences.reviewResponseStyle = this.analyzeReviewStyle(reviewEvents);
    }
    
    return preferences;
  }
  
  private async extractWorkflowPreferences(
    events: LearningEvent[]
  ): Promise<WorkflowPreferences> {
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
    
    if (workflowEvents.length === 0) {
      return preferences;
    }
    
    // Detect commit preferences
    const commitEvents = workflowEvents.filter(e =>
      e.action.type === ActionType.Commit
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
      
      // Check for auto-commit pattern
      const autoCommitRatio = this.detectAutoCommitPattern(commitEvents);
      preferences.autoCommit = autoCommitRatio > 0.7;
    }
    
    // Detect test-first development
    const testPattern = this.detectTestFirstPattern(events);
    preferences.testFirst = testPattern;
    
    // Analyze review response time
    const reviewTimes = this.analyzeReviewResponseTimes(events);
    if (reviewTimes.median < 300000) { // 5 minutes
      preferences.reviewResponseTime = 'immediate';
    } else if (reviewTimes.median < 3600000) { // 1 hour
      preferences.reviewResponseTime = 'batched';
    } else {
      preferences.reviewResponseTime = 'end-of-day';
    }
    
    return preferences;
  }
  
  private async extractToolPreferences(
    events: LearningEvent[]
  ): Promise<ToolPreferences> {
    const preferences: ToolPreferences = {
      customTools: {}
    };
    
    // Extract tool usage from events
    const toolUsage = new Map<string, number>();
    
    for (const event of events) {
      // Look for tool references in context
      if (event.context.tool) {
        const tool = event.context.tool;
        toolUsage.set(tool, (toolUsage.get(tool) || 0) + 1);
      }
      
      // Extract from action parameters
      if (event.action.parameters.tool) {
        const tool = event.action.parameters.tool;
        toolUsage.set(tool, (toolUsage.get(tool) || 0) + 1);
      }
    }
    
    // Set preferences based on usage
    for (const [tool, count] of toolUsage) {
      if (count >= 3) {
        // Categorize tools
        if (tool.includes('test') || tool.includes('jest') || tool.includes('mocha')) {
          preferences.preferredTestRunner = tool;
        } else if (tool.includes('lint') || tool.includes('eslint')) {
          preferences.preferredLinter = tool;
        } else if (tool.includes('format') || tool.includes('prettier')) {
          preferences.preferredFormatter = tool;
        } else {
          preferences.customTools![tool] = `Used ${count} times`;
        }
      }
    }
    
    return preferences;
  }
  
  // Helper methods
  private detectIndentation(code: string): { type: 'spaces' | 'tabs'; size: number } | null {
    const lines = code.split('\n');
    
    for (const line of lines) {
      if (line.length === 0) continue;
      
      // Check for tabs
      if (line.startsWith('\t')) {
        return { type: 'tabs', size: 1 };
      }
      
      // Check for spaces
      const spaceMatch = line.match(/^( +)/);
      if (spaceMatch) {
        const spaces = spaceMatch[1].length;
        // Common sizes: 2, 4, 8
        if (spaces % 2 === 0) {
          return { type: 'spaces', size: spaces === 8 ? 8 : spaces === 4 ? 4 : 2 };
        }
      }
    }
    
    return null;
  }
  
  private detectQuoteStyle(code: string): 'single' | 'double' | null {
    // Count string literals
    const singleQuotes = (code.match(/'/g) || []).length;
    const doubleQuotes = (code.match(/"/g) || []).length;
    
    if (singleQuotes === 0 && doubleQuotes === 0) return null;
    
    return singleQuotes > doubleQuotes ? 'single' : 'double';
  }
  
  private detectSemicolons(code: string): boolean | null {
    // Check JavaScript/TypeScript code
    if (!code.match(/\.(js|ts|jsx|tsx)/)) return null;
    
    const lines = code.split('\n');
    let withSemicolon = 0;
    let withoutSemicolon = 0;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip empty lines, comments, and certain statements
      if (!trimmed || 
          trimmed.startsWith('//') || 
          trimmed.startsWith('*') ||
          trimmed.startsWith('{') ||
          trimmed.startsWith('}')) {
        continue;
      }
      
      // Check if line should have semicolon
      if (this.shouldHaveSemicolon(trimmed)) {
        if (trimmed.endsWith(';')) {
          withSemicolon++;
        } else {
          withoutSemicolon++;
        }
      }
    }
    
    if (withSemicolon + withoutSemicolon === 0) return null;
    
    return withSemicolon > withoutSemicolon;
  }
  
  private shouldHaveSemicolon(line: string): boolean {
    // Simple heuristic for statements that typically need semicolons
    return line.match(/^(const|let|var|return|import|export)\s/) !== null ||
           line.match(/\)\s*$/) !== null ||
           line.match(/[\w\]\)]\s*$/) !== null;
  }
  
  private detectTrailingComma(code: string): boolean | null {
    // Look for object/array literals
    const multilineObjects = code.matchAll(/{\s*\n(.*?)\n\s*}/gs);
    const multilineArrays = code.matchAll(/\[\s*\n(.*?)\n\s*\]/gs);
    
    let withComma = 0;
    let withoutComma = 0;
    
    for (const match of [...multilineObjects, ...multilineArrays]) {
      const content = match[1];
      const lines = content.trim().split('\n');
      
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1].trim();
        if (lastLine.endsWith(',')) {
          withComma++;
        } else if (lastLine.match(/[^,]\s*$/)) {
          withoutComma++;
        }
      }
    }
    
    if (withComma + withoutComma === 0) return null;
    
    return withComma > withoutComma;
  }
  
  private measureLineLengths(code: string): number[] {
    return code.split('\n').map(line => line.length);
  }
  
  private applyFeedbackToCodePreferences(
    preferences: CodeStylePreferences,
    events: LearningEvent[]
  ): CodeStylePreferences {
    // Look for style-related feedback
    const styleFeedback = events.filter(e =>
      e.feedback &&
      (e.feedback.message?.toLowerCase().includes('style') ||
       e.feedback.message?.toLowerCase().includes('format'))
    );
    
    // Apply suggestions from feedback
    for (const event of styleFeedback) {
      if (event.feedback?.suggestions) {
        for (const suggestion of event.feedback.suggestions) {
          // Parse suggestions for style preferences
          if (suggestion.includes('spaces')) {
            preferences.indentation = 'spaces';
          } else if (suggestion.includes('tabs')) {
            preferences.indentation = 'tabs';
          }
          
          // Extract indent size
          const sizeMatch = suggestion.match(/(\d+)\s*spaces?/);
          if (sizeMatch) {
            preferences.indentSize = parseInt(sizeMatch[1], 10);
          }
        }
      }
    }
    
    return preferences;
  }
  
  private analyzePRStyle(events: LearningEvent[]): 'detailed' | 'concise' | 'bullet-points' {
    // Analyze PR descriptions
    let totalLength = 0;
    let bulletPointCount = 0;
    
    for (const event of events) {
      const description = event.action.parameters.description || '';
      totalLength += description.length;
      
      if (description.includes('- ') || description.includes('* ')) {
        bulletPointCount++;
      }
    }
    
    const avgLength = totalLength / events.length;
    const bulletRatio = bulletPointCount / events.length;
    
    if (bulletRatio > 0.7) return 'bullet-points';
    if (avgLength > 500) return 'detailed';
    return 'concise';
  }
  
  private analyzeCommitStyle(events: LearningEvent[]): 'conventional' | 'descriptive' | 'brief' {
    let conventional = 0;
    let totalLength = 0;
    
    for (const event of events) {
      const message = event.action.parameters.message || '';
      totalLength += message.length;
      
      // Check for conventional commit format
      if (message.match(/^(feat|fix|docs|style|refactor|test|chore)(\(.+\))?:/)) {
        conventional++;
      }
    }
    
    const conventionalRatio = conventional / events.length;
    const avgLength = totalLength / events.length;
    
    if (conventionalRatio > 0.7) return 'conventional';
    if (avgLength > 100) return 'descriptive';
    return 'brief';
  }
  
  private analyzeReviewStyle(events: LearningEvent[]): 'immediate' | 'batched' | 'detailed' {
    const responseTimes: number[] = [];
    let detailedResponses = 0;
    
    for (const event of events) {
      if (event.outcome.duration) {
        responseTimes.push(event.outcome.duration);
      }
      
      // Check for detailed responses
      const responseLength = event.action.parameters.response?.length || 0;
      if (responseLength > 200) {
        detailedResponses++;
      }
    }
    
    const detailRatio = detailedResponses / events.length;
    
    if (detailRatio > 0.6) return 'detailed';
    
    // Check response times
    if (responseTimes.length > 0) {
      const avgTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
      if (avgTime < 300000) return 'immediate'; // 5 minutes
    }
    
    return 'batched';
  }
  
  private calculateAvgFilesPerCommit(events: LearningEvent[]): number {
    let totalFiles = 0;
    let commitCount = 0;
    
    for (const event of events) {
      if (event.context.fileChanges) {
        totalFiles += event.context.fileChanges.length;
        commitCount++;
      }
    }
    
    return commitCount > 0 ? totalFiles / commitCount : 0;
  }
  
  private detectAutoCommitPattern(events: LearningEvent[]): number {
    // Check if commits happen automatically after changes
    let autoCommits = 0;
    
    for (const event of events) {
      if (event.action.parameters.auto || 
          event.action.parameters.message?.includes('auto')) {
        autoCommits++;
      }
    }
    
    return autoCommits / events.length;
  }
  
  private detectTestFirstPattern(events: LearningEvent[]): boolean {
    // Look for pattern of test files being created before implementation
    const testFiles = new Set<string>();
    const implFiles = new Set<string>();
    
    for (const event of events) {
      if (event.context.fileChanges) {
        for (const change of event.context.fileChanges) {
          if (change.file.includes('.test.') || change.file.includes('.spec.')) {
            testFiles.add(change.file);
          } else {
            implFiles.add(change.file);
          }
        }
      }
    }
    
    // Simple heuristic: if we have tests and they were created early
    return testFiles.size > 0 && testFiles.size >= implFiles.size * 0.5;
  }
  
  private analyzeReviewResponseTimes(events: LearningEvent[]): { median: number; average: number } {
    const times = events
      .filter(e => e.type === EventType.ReviewResponse && e.outcome.duration)
      .map(e => e.outcome.duration);
    
    if (times.length === 0) {
      return { median: 0, average: 0 };
    }
    
    // Calculate median
    times.sort((a, b) => a - b);
    const median = times.length % 2 === 0
      ? (times[times.length / 2 - 1] + times[times.length / 2]) / 2
      : times[Math.floor(times.length / 2)];
    
    // Calculate average
    const average = times.reduce((a, b) => a + b, 0) / times.length;
    
    return { median, average };
  }
}