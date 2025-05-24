import type { Requirement, Pattern, IssueAnalysis, ImplementationSuggestion, RepoContext } from './types.js';
import { spawnAndLogOutput } from '../../rmfilter/utils.js';
import { log } from '../../logging.js';

export class PatternMatcher {
  async findSimilarImplementations(
    requirements: Requirement[],
    context: RepoContext
  ): Promise<Pattern[]> {
    const patterns: Pattern[] = [];
    
    // Extract key terms from requirements
    const keyTerms = this.extractKeyTerms(requirements);
    
    // Search commit history for similar changes
    const commitPatterns = await this.searchCommitHistory(keyTerms, context);
    patterns.push(...commitPatterns);
    
    // Search for similar code patterns
    const codePatterns = await this.searchCodePatterns(keyTerms, context);
    patterns.push(...codePatterns);
    
    // Sort by relevance
    return patterns.sort((a, b) => b.relevance - a.relevance);
  }

  async suggestImplementationApproach(
    analysis: IssueAnalysis
  ): Promise<ImplementationSuggestion> {
    const patterns = await this.findSimilarImplementations(
      analysis.requirements,
      { owner: '', repo: '', defaultBranch: 'main', workDir: '.' }
    );
    
    // Analyze the issue type and requirements
    const complexity = this.estimateComplexity(analysis);
    const approach = this.generateApproach(analysis, patterns);
    const steps = this.generateSteps(analysis, patterns);
    const challenges = this.identifyPotentialChallenges(analysis, patterns);
    
    return {
      approach,
      steps,
      patterns: patterns.slice(0, 5), // Top 5 most relevant patterns
      potentialChallenges: challenges,
      estimatedComplexity: complexity,
    };
  }

  private extractKeyTerms(requirements: Requirement[]): string[] {
    const terms = new Set<string>();
    
    for (const req of requirements) {
      // Extract nouns and important terms from descriptions
      const words = req.description.toLowerCase().split(/\s+/);
      for (const word of words) {
        // Skip common words
        if (word.length > 3 && !this.isCommonWord(word)) {
          terms.add(word);
        }
      }
    }
    
    return Array.from(terms);
  }

  private async searchCommitHistory(
    keyTerms: string[],
    context: RepoContext
  ): Promise<Pattern[]> {
    const patterns: Pattern[] = [];
    
    try {
      // Search commit messages for key terms
      const searchQuery = keyTerms.slice(0, 5).join('|');
      const result = await spawnAndLogOutput(
        ['git', 'log', '--grep', searchQuery, '-i', '--oneline', '-n', '20'],
        { cwd: context.workDir }
      );
      
      if (result.exitCode === 0 && result.stdout) {
        const commits = result.stdout.split('\n').filter(Boolean);
        
        for (const commit of commits) {
          const [hash, ...messageParts] = commit.split(' ');
          const message = messageParts.join(' ');
          
          // Get files changed in this commit
          const filesResult = await spawnAndLogOutput(
            ['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', hash],
            { cwd: context.workDir }
          );
          
          if (filesResult.exitCode === 0) {
            patterns.push({
              type: 'implementation',
              description: `Similar change: ${message}`,
              examples: filesResult.stdout.split('\n').filter(Boolean),
              relevance: this.calculateRelevance(message, keyTerms),
            });
          }
        }
      }
    } catch (error) {
      log('Error searching commit history:', error);
    }
    
    return patterns;
  }

  private async searchCodePatterns(
    keyTerms: string[],
    context: RepoContext
  ): Promise<Pattern[]> {
    const patterns: Pattern[] = [];
    
    try {
      // Use ripgrep to search for patterns
      for (const term of keyTerms.slice(0, 3)) {
        const result = await spawnAndLogOutput(
          ['rg', '-l', '-i', term, '--type', 'ts', '--type', 'js'],
          { cwd: context.workDir }
        );
        
        if (result.exitCode === 0 && result.stdout) {
          const files = result.stdout.split('\n').filter(Boolean).slice(0, 5);
          
          if (files.length > 0) {
            patterns.push({
              type: 'architecture',
              description: `Files containing similar terminology: ${term}`,
              examples: files,
              relevance: 0.7,
            });
          }
        }
      }
    } catch (error) {
      log('Error searching code patterns:', error);
    }
    
    return patterns;
  }

  private calculateRelevance(text: string, keyTerms: string[]): number {
    const lowerText = text.toLowerCase();
    let matches = 0;
    
    for (const term of keyTerms) {
      if (lowerText.includes(term.toLowerCase())) {
        matches++;
      }
    }
    
    return Math.min(matches / keyTerms.length, 1);
  }

  private estimateComplexity(analysis: IssueAnalysis): 'low' | 'medium' | 'high' {
    let score = 0;
    
    // Factor in number of requirements
    score += Math.min(analysis.requirements.length * 0.2, 1);
    
    // Factor in number of affected files
    score += Math.min(analysis.technicalScope.affectedFiles.length * 0.1, 1);
    
    // Factor in type of change
    if (analysis.type === 'bug') {
      score += 0.3;
    } else if (analysis.type === 'feature') {
      score += 0.7;
    } else if (analysis.type === 'refactor') {
      score += 0.5;
    }
    
    // Factor in dependencies
    score += Math.min(analysis.technicalScope.dependencies.length * 0.15, 0.5);
    
    if (score < 1) return 'low';
    if (score < 2) return 'medium';
    return 'high';
  }

  private generateApproach(analysis: IssueAnalysis, patterns: Pattern[]): string {
    const approaches = [];
    
    // Base approach on issue type
    switch (analysis.type) {
      case 'bug':
        approaches.push('Identify root cause through debugging and testing');
        approaches.push('Create minimal reproduction case');
        approaches.push('Implement fix with regression tests');
        break;
      case 'feature':
        approaches.push('Design API/interface following existing patterns');
        approaches.push('Implement core functionality incrementally');
        approaches.push('Add comprehensive tests and documentation');
        break;
      case 'refactor':
        approaches.push('Analyze current implementation and identify issues');
        approaches.push('Plan incremental refactoring steps');
        approaches.push('Ensure behavior remains unchanged with tests');
        break;
      case 'documentation':
        approaches.push('Survey existing documentation structure');
        approaches.push('Write clear, example-driven documentation');
        approaches.push('Ensure consistency with codebase');
        break;
      case 'test':
        approaches.push('Identify test gaps and edge cases');
        approaches.push('Write comprehensive test suite');
        approaches.push('Ensure good coverage metrics');
        break;
    }
    
    // Add pattern-based suggestions
    if (patterns.length > 0) {
      approaches.push(`Follow patterns from: ${patterns[0].description}`);
    }
    
    return approaches.join('. ');
  }

  private generateSteps(analysis: IssueAnalysis, patterns: Pattern[]): string[] {
    const steps: string[] = [];
    
    // Initial investigation
    steps.push('Analyze the issue and understand requirements fully');
    
    // Pattern-based steps
    if (patterns.length > 0) {
      steps.push(`Review similar implementations in: ${patterns[0].examples.slice(0, 3).join(', ')}`);
    }
    
    // Type-specific steps
    switch (analysis.type) {
      case 'bug':
        steps.push('Create test case that reproduces the issue');
        steps.push('Debug and identify root cause');
        steps.push('Implement fix');
        steps.push('Verify fix resolves issue and doesn\'t break existing functionality');
        break;
      case 'feature':
        steps.push('Design the feature interface/API');
        steps.push('Implement core functionality');
        steps.push('Add unit and integration tests');
        steps.push('Update documentation');
        break;
      case 'refactor':
        steps.push('Identify code to be refactored');
        steps.push('Ensure existing tests cover the code');
        steps.push('Refactor incrementally');
        steps.push('Verify all tests still pass');
        break;
    }
    
    // Final steps
    steps.push('Run all tests and linting');
    steps.push('Update CHANGELOG if needed');
    steps.push('Create pull request with clear description');
    
    return steps;
  }

  private identifyPotentialChallenges(
    analysis: IssueAnalysis, 
    patterns: Pattern[]
  ): string[] {
    const challenges: string[] = [];
    
    // Complexity-based challenges
    if (analysis.technicalScope.affectedFiles.length > 10) {
      challenges.push('Large number of files affected - ensure thorough testing');
    }
    
    if (analysis.technicalScope.dependencies.length > 0) {
      challenges.push('External dependencies may require version compatibility checks');
    }
    
    // Type-specific challenges
    switch (analysis.type) {
      case 'bug':
        challenges.push('Ensuring fix doesn\'t introduce regression');
        challenges.push('Root cause might be in unexpected location');
        break;
      case 'feature':
        challenges.push('Maintaining backward compatibility');
        challenges.push('Performance impact of new functionality');
        break;
      case 'refactor':
        challenges.push('Avoiding scope creep during refactoring');
        challenges.push('Maintaining existing behavior exactly');
        break;
    }
    
    // Pattern-based challenges
    if (patterns.length === 0) {
      challenges.push('No similar implementations found - may need novel approach');
    }
    
    return challenges;
  }

  private isCommonWord(word: string): boolean {
    const commonWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'up', 'about', 'into', 'through', 'during',
      'including', 'until', 'against', 'among', 'throughout', 'despite', 'towards',
      'upon', 'concerning', 'of', 'to', 'in', 'for', 'on', 'with', 'at', 'by',
      'from', 'about', 'as', 'into', 'like', 'through', 'after', 'over', 'between',
      'out', 'against', 'during', 'without', 'before', 'under', 'around', 'among',
      'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
      'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might',
      'must', 'can', 'need', 'want', 'use', 'this', 'that', 'these', 'those',
      'when', 'where', 'how', 'what', 'which', 'who', 'whom', 'whose', 'why',
    ]);
    
    return commonWords.has(word.toLowerCase());
  }
}