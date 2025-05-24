import type { PlanStep, PlanContext } from './types.js';
import type { EnrichedAnalysis, Pattern, Convention } from '../analysis/types.js';

export class InstructionGenerator {
  generateStepInstructions(
    step: PlanStep,
    context: PlanContext,
    analysis: EnrichedAnalysis
  ): string {
    const parts: string[] = [];
    
    // Core instruction
    parts.push(this.generateCore(step));
    
    // Add pattern guidance
    if (analysis.patterns && analysis.patterns.length > 0) {
      parts.push(this.addPatterns(analysis.patterns));
    }
    
    // Add constraints
    parts.push(this.addConstraints(step, analysis));
    
    // Add examples
    if (context.examples.length > 0) {
      parts.push(this.addExamples(context.examples));
    }
    
    // Add conventions
    if (analysis.conventions.length > 0) {
      parts.push(this.addConventions(analysis.conventions));
    }
    
    return parts.filter(Boolean).join('\n\n');
  }

  generateGlobalInstructions(
    analysis: EnrichedAnalysis
  ): string {
    const sections: string[] = [];
    
    // Project context
    sections.push(this.generateProjectContext(analysis));
    
    // Architecture guidelines
    if (analysis.codebaseContext.architectureStyle) {
      sections.push(this.generateArchitectureGuidelines(analysis.codebaseContext));
    }
    
    // Quality requirements
    sections.push(this.generateQualityRequirements(analysis));
    
    // Security considerations
    sections.push(this.generateSecurityConsiderations(analysis));
    
    // Testing requirements
    sections.push(this.generateTestingRequirements(analysis));
    
    return sections.filter(Boolean).join('\n\n');
  }

  private generateCore(step: PlanStep): string {
    const lines: string[] = [];
    
    lines.push(`## ${step.title}`);
    lines.push('');
    lines.push(step.description);
    
    if (step.technical_notes) {
      lines.push('');
      lines.push(`**Technical Notes:** ${step.technical_notes}`);
    }
    
    lines.push('');
    lines.push('### Acceptance Criteria');
    step.acceptance_criteria.forEach(criterion => {
      lines.push(`- [ ] ${criterion}`);
    });
    
    return lines.join('\n');
  }

  private addPatterns(patterns: Pattern[]): string {
    if (patterns.length === 0) return '';
    
    const lines: string[] = ['### Patterns to Follow'];
    
    patterns.slice(0, 3).forEach(pattern => {
      lines.push(`- **${pattern.type}**: ${pattern.description}`);
      if (pattern.examples.length > 0) {
        lines.push(`  Examples: ${pattern.examples.slice(0, 2).join(', ')}`);
      }
    });
    
    return lines.join('\n');
  }

  private addConstraints(step: PlanStep, analysis: EnrichedAnalysis): string {
    const constraints: string[] = [];
    
    // Complexity constraints
    if (step.estimated_complexity === 'high') {
      constraints.push('This is a complex task - consider breaking it down if needed');
    }
    
    // Dependency constraints
    if (step.dependencies && step.dependencies.length > 0) {
      constraints.push(`Must be completed after: ${step.dependencies.join(', ')}`);
    }
    
    // Performance constraints
    if (analysis.requirements.some(r => 
      r.description.toLowerCase().includes('performance') ||
      r.description.toLowerCase().includes('optimize')
    )) {
      constraints.push('Pay attention to performance implications');
    }
    
    // Backward compatibility
    if (analysis.type === 'refactor' || analysis.type === 'feature') {
      constraints.push('Maintain backward compatibility unless explicitly stated otherwise');
    }
    
    if (constraints.length === 0) return '';
    
    return '### Constraints\n' + constraints.map(c => `- ${c}`).join('\n');
  }

  private addExamples(examples: Array<{ file: string; description: string; code?: string }>): string {
    if (examples.length === 0) return '';
    
    const lines: string[] = ['### Examples to Reference'];
    
    examples.slice(0, 3).forEach(example => {
      lines.push(`- ${example.description} (${example.file})`);
      if (example.code) {
        lines.push('  ```');
        lines.push(`  ${example.code.split('\n').slice(0, 5).join('\n  ')}`);
        lines.push('  ```');
      }
    });
    
    return lines.join('\n');
  }

  private addConventions(conventions: Convention[]): string {
    if (conventions.length === 0) return '';
    
    const lines: string[] = ['### Project Conventions'];
    
    conventions.forEach(convention => {
      lines.push(`- **${convention.type}**: ${convention.description}`);
    });
    
    return lines.join('\n');
  }

  private generateProjectContext(analysis: EnrichedAnalysis): string {
    const lines: string[] = ['# Project Context'];
    
    lines.push(`- **Primary Languages**: ${analysis.codebaseContext.primaryLanguages.join(', ')}`);
    lines.push(`- **Frameworks**: ${analysis.codebaseContext.frameworks.join(', ')}`);
    lines.push(`- **Issue Type**: ${analysis.type}`);
    lines.push(`- **Confidence**: ${Math.round(analysis.confidence * 100)}%`);
    
    return lines.join('\n');
  }

  private generateArchitectureGuidelines(codebaseContext: EnrichedAnalysis['codebaseContext']): string {
    const lines: string[] = ['# Architecture Guidelines'];
    
    lines.push(`- **Style**: ${codebaseContext.architectureStyle}`);
    
    switch (codebaseContext.architectureStyle) {
      case 'MVC':
        lines.push('- Keep models, views, and controllers separated');
        lines.push('- Business logic belongs in models or services');
        break;
      case 'Domain-Driven Design':
        lines.push('- Respect bounded contexts');
        lines.push('- Keep domain logic pure');
        break;
      case 'Microservices':
        lines.push('- Maintain service boundaries');
        lines.push('- Use appropriate communication patterns');
        break;
      case 'Component-based':
        lines.push('- Keep components self-contained');
        lines.push('- Use props/events for communication');
        break;
    }
    
    return lines.join('\n');
  }

  private generateQualityRequirements(analysis: EnrichedAnalysis): string {
    const lines: string[] = ['# Quality Requirements'];
    
    lines.push('- All code must pass type checking');
    lines.push('- Follow existing code style and formatting');
    lines.push('- Add appropriate error handling');
    lines.push('- Include meaningful variable and function names');
    
    if (analysis.type === 'feature' || analysis.type === 'refactor') {
      lines.push('- Document complex logic with comments');
      lines.push('- Consider edge cases and error scenarios');
    }
    
    return lines.join('\n');
  }

  private generateSecurityConsiderations(analysis: EnrichedAnalysis): string {
    const lines: string[] = ['# Security Considerations'];
    
    // Check for security-related keywords
    const hasSecurityConcerns = analysis.requirements.some(r => {
      const desc = r.description.toLowerCase();
      return desc.includes('auth') || 
             desc.includes('password') || 
             desc.includes('token') ||
             desc.includes('api') ||
             desc.includes('user input') ||
             desc.includes('file') ||
             desc.includes('database');
    });
    
    if (hasSecurityConcerns) {
      lines.push('- Validate all user inputs');
      lines.push('- Use parameterized queries for database operations');
      lines.push('- Never log sensitive information');
      lines.push('- Follow OWASP guidelines where applicable');
      lines.push('- Use secure defaults');
    } else {
      lines.push('- Follow general security best practices');
      lines.push('- Be mindful of potential security implications');
    }
    
    return lines.join('\n');
  }

  private generateTestingRequirements(analysis: EnrichedAnalysis): string {
    const lines: string[] = ['# Testing Requirements'];
    
    lines.push(`- **Testing Approach**: ${analysis.codebaseContext.testingApproach}`);
    
    switch (analysis.type) {
      case 'bug':
        lines.push('- Add regression test that fails without the fix');
        lines.push('- Ensure fix doesn\'t break existing tests');
        break;
      case 'feature':
        lines.push('- Add unit tests for all new functions');
        lines.push('- Add integration tests for feature workflows');
        lines.push('- Aim for >80% code coverage');
        break;
      case 'refactor':
        lines.push('- Ensure all existing tests still pass');
        lines.push('- Add tests if coverage is insufficient');
        break;
      case 'test':
        lines.push('- Focus on uncovered code paths');
        lines.push('- Test edge cases and error conditions');
        break;
    }
    
    return lines.join('\n');
  }
}