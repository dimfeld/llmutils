import type {
  PRTemplate,
  PRTemplateContext,
  ChangeAnalysis,
  ReviewChecklistItem,
  PRMetadata,
} from './types';

export class PRTemplateGenerator {
  generateTemplate(context: PRTemplateContext, changes: ChangeAnalysis): PRTemplate {
    const title = this.generateTitle(context);
    const body = this.generateBody(context, changes);
    const labels = this.generateLabels(context, changes);

    return {
      title,
      body,
      labels,
      draft: this.shouldBeDraft(changes),
    };
  }

  private generateTitle(context: PRTemplateContext): string {
    // Extract key action from issue title
    const issueTitle = context.issueTitle.toLowerCase();
    let prefix = 'feat';

    if (issueTitle.includes('fix') || issueTitle.includes('bug')) {
      prefix = 'fix';
    } else if (issueTitle.includes('docs') || issueTitle.includes('documentation')) {
      prefix = 'docs';
    } else if (issueTitle.includes('refactor')) {
      prefix = 'refactor';
    } else if (issueTitle.includes('test')) {
      prefix = 'test';
    } else if (issueTitle.includes('chore') || issueTitle.includes('update')) {
      prefix = 'chore';
    }

    // Clean up the title
    const cleanTitle = context.issueTitle
      .replace(/^(\[.*?\]\s*)+/, '') // Remove brackets
      .replace(/^(feat|fix|docs|refactor|test|chore):\s*/i, '') // Remove existing prefix
      .trim();

    return `${prefix}: ${cleanTitle} (#${context.issueNumber})`;
  }

  private generateBody(context: PRTemplateContext, changes: ChangeAnalysis): string {
    const sections: string[] = [];

    // Summary
    sections.push('## Summary');
    sections.push(this.generateSummary(context));
    sections.push('');

    // Related Issue
    sections.push('## Related Issue');
    sections.push(`Closes #${context.issueNumber}`);
    sections.push('');

    // Changes Made
    sections.push('## Changes Made');
    sections.push(this.generateChangesList(context, changes));
    sections.push('');

    // Testing
    sections.push('## Testing');
    sections.push(this.generateTestingSection(changes));
    sections.push('');

    // Review Checklist
    sections.push('## Review Checklist');
    sections.push(this.generateChecklist(context, changes));
    sections.push('');

    // Metadata
    sections.push(this.generateMetadata(context));

    return sections.join('\n');
  }

  private generateSummary(context: PRTemplateContext): string {
    if (context.analysis?.summary) {
      return context.analysis.summary;
    }

    // Fallback to extracting from plan
    const goal = context.plan.goal || context.plan.details;
    return goal || `Implementation of issue #${context.issueNumber}: ${context.issueTitle}`;
  }

  private generateChangesList(context: PRTemplateContext, changes: ChangeAnalysis): string {
    const items: string[] = [];

    // Extract key changes from plan tasks
    if (context.plan.tasks) {
      for (const task of context.plan.tasks) {
        items.push(`- **${task.title}**: ${task.description}`);
        if (task.steps) {
          for (const step of task.steps) {
            if (step.done) {
              items.push(`  - ✅ ${step.prompt.substring(0, 80)}...`);
            }
          }
        }
      }
    }

    // Add file statistics
    items.push('');
    items.push(`### File Changes`);
    items.push(`- Files changed: ${changes.filesChanged}`);
    items.push(`- Lines added: ${changes.insertions}`);
    items.push(`- Lines removed: ${changes.deletions}`);

    return items.join('\n');
  }

  private generateTestingSection(changes: ChangeAnalysis): string {
    const items: string[] = [];

    if (changes.testsCoverage.hasTests) {
      items.push('✅ Tests have been added/updated:');
      for (const testFile of changes.testsCoverage.testFiles) {
        items.push(`- ${testFile}`);
      }
    } else {
      items.push('⚠️ No tests were added in this PR');
      items.push('');
      items.push('Please review if tests are needed for these changes.');
    }

    return items.join('\n');
  }

  private generateChecklist(context: PRTemplateContext, changes: ChangeAnalysis): string {
    const checklist = this.buildChecklist(context, changes);
    const items: string[] = [];

    const categories = {
      testing: '🧪 Testing',
      documentation: '📚 Documentation',
      'code-quality': '✨ Code Quality',
      security: '🔒 Security',
      performance: '⚡ Performance',
    };

    for (const [category, label] of Object.entries(categories)) {
      const categoryItems = checklist.filter((item) => item.category === category);
      if (categoryItems.length > 0) {
        items.push(`### ${label}`);
        for (const item of categoryItems) {
          const checkbox = item.checked ? '[x]' : '[ ]';
          items.push(`- ${checkbox} ${item.description}`);
        }
        items.push('');
      }
    }

    return items.join('\n').trim();
  }

  private buildChecklist(
    context: PRTemplateContext,
    changes: ChangeAnalysis
  ): ReviewChecklistItem[] {
    const checklist: ReviewChecklistItem[] = [];

    // Testing items
    checklist.push({
      checked: changes.testsCoverage.hasTests,
      description: 'Tests have been added or updated',
      category: 'testing',
    });

    checklist.push({
      checked: false,
      description: 'All tests are passing',
      category: 'testing',
    });

    // Documentation items
    checklist.push({
      checked: false,
      description: 'Code is well-commented',
      category: 'documentation',
    });

    // Code quality items
    checklist.push({
      checked: true,
      description: 'Code follows project style guidelines',
      category: 'code-quality',
    });

    checklist.push({
      checked: !changes.breaking,
      description: 'No breaking changes introduced',
      category: 'code-quality',
    });

    // Security items (if high risk)
    if (changes.riskLevel === 'high') {
      checklist.push({
        checked: false,
        description: 'Security implications have been considered',
        category: 'security',
      });
    }

    return checklist;
  }

  private generateLabels(context: PRTemplateContext, changes: ChangeAnalysis): string[] {
    const labels: string[] = [];

    // Type label based on prefix
    const title = context.issueTitle.toLowerCase();
    if (title.includes('fix') || title.includes('bug')) {
      labels.push('bug');
    } else if (title.includes('feat')) {
      labels.push('enhancement');
    } else if (title.includes('docs')) {
      labels.push('documentation');
    }

    // Risk level
    if (changes.riskLevel === 'high') {
      labels.push('needs-careful-review');
    }

    // Breaking changes
    if (changes.breaking) {
      labels.push('breaking-change');
    }

    // Auto-generated
    labels.push('rmapp-generated');

    return labels;
  }

  private shouldBeDraft(changes: ChangeAnalysis): boolean {
    // Make it a draft if high risk or no tests
    return changes.riskLevel === 'high' || !changes.testsCoverage.hasTests;
  }

  private generateMetadata(context: PRTemplateContext): string {
    const metadata: PRMetadata = {
      issueNumber: context.issueNumber,
      workflowId: 'unknown', // TODO: pass from context
      planPath: 'unknown', // TODO: pass from context
      completedSteps: context.plan.tasks
        ?.flatMap((t: any) => t.steps || [])
        .filter((s: any) => s.done === true)
        .map((s: any) => s.prompt.substring(0, 50)) || [],
      generatedBy: 'rmapp',
      version: '1.0.0',
    };

    return `<!-- rmapp:metadata\n${JSON.stringify(metadata, null, 2)}\n-->`;
  }
}