# PR Creator

## Overview
Build a system that creates high-quality pull requests with comprehensive descriptions, linking back to issues and including all relevant context.

## Requirements
- Generate detailed PR descriptions from implementation
- Link to source issue and plan
- Include change summary and testing notes
- Follow project PR conventions
- Add appropriate labels and reviewers

## Implementation Steps

### Step 1: Create PR Template Engine
Define templates in `src/rmapp/pr/templates.ts`:
```typescript
interface PRTemplate {
  name: string;
  sections: TemplateSection[];
  metadata: TemplateMetadata;
}

interface TemplateSection {
  title: string;
  required: boolean;
  generator: (context: PRContext) => Promise<string>;
}

const DEFAULT_TEMPLATE: PRTemplate = {
  name: 'default',
  sections: [
    {
      title: 'Summary',
      required: true,
      generator: async (ctx) => generateSummary(ctx)
    },
    {
      title: 'Changes',
      required: true,
      generator: async (ctx) => generateChangeList(ctx)
    },
    {
      title: 'Testing',
      required: true,
      generator: async (ctx) => generateTestingNotes(ctx)
    },
    {
      title: 'Related Issues',
      required: true,
      generator: async (ctx) => generateIssueLinks(ctx)
    }
  ]
};
```

### Step 2: Implement Change Analyzer
Create `src/rmapp/pr/change_analyzer.ts`:
```typescript
class ChangeAnalyzer {
  async analyzeChanges(
    workspace: string,
    baseBranch: string
  ): Promise<ChangeAnalysis> {
    // Get diff
    const diff = await this.getDiff(workspace, baseBranch);
    
    // Categorize changes
    const categorized = this.categorizeChanges(diff);
    
    // Extract key changes
    const keyChanges = this.extractKeyChanges(categorized);
    
    // Analyze impact
    const impact = this.analyzeImpact(categorized);
    
    return {
      diff,
      categories: categorized,
      keyChanges,
      impact,
      stats: this.calculateStats(diff)
    };
  }
  
  private categorizeChanges(diff: Diff): CategorizedChanges {
    return {
      features: this.findNewFeatures(diff),
      fixes: this.findBugFixes(diff),
      refactors: this.findRefactors(diff),
      tests: this.findTestChanges(diff),
      docs: this.findDocChanges(diff)
    };
  }
}
```

### Step 3: Build Description Generator
Create `src/rmapp/pr/description_generator.ts`:
```typescript
class DescriptionGenerator {
  async generateSummary(context: PRContext): Promise<string> {
    // Create executive summary
    const summary = [];
    
    // What was implemented
    summary.push(this.summarizeImplementation(context));
    
    // Why it was needed
    summary.push(this.explainMotivation(context));
    
    // How it works
    summary.push(this.explainApproach(context));
    
    return summary.join('\n\n');
  }
  
  async generateChangeList(context: PRContext): Promise<string> {
    // Group by category
    const changes = context.analysis.categories;
    
    let description = '';
    
    if (changes.features.length > 0) {
      description += '### ✨ New Features\n';
      description += this.formatFeatures(changes.features);
    }
    
    if (changes.fixes.length > 0) {
      description += '\n### 🐛 Bug Fixes\n';
      description += this.formatFixes(changes.fixes);
    }
    
    // Continue for other categories...
    
    return description;
  }
  
  private formatFeatures(features: Feature[]): string {
    return features.map(f => 
      `- ${f.description} ${this.formatLocation(f.location)}`
    ).join('\n');
  }
}
```

### Step 4: Create Test Summary Generator
Implement `src/rmapp/pr/test_summary.ts`:
```typescript
class TestSummaryGenerator {
  async generateTestingNotes(context: PRContext): Promise<string> {
    const notes = [];
    
    // Tests added
    const newTests = await this.findNewTests(context);
    if (newTests.length > 0) {
      notes.push(this.formatNewTests(newTests));
    }
    
    // Tests modified
    const modifiedTests = await this.findModifiedTests(context);
    if (modifiedTests.length > 0) {
      notes.push(this.formatModifiedTests(modifiedTests));
    }
    
    // Test results
    const results = await this.runTests(context);
    notes.push(this.formatTestResults(results));
    
    // Manual testing notes
    notes.push(this.generateManualTestingGuide(context));
    
    return notes.join('\n\n');
  }
  
  private generateManualTestingGuide(context: PRContext): string {
    // Based on changes, suggest manual testing steps
    const guide = ['### Manual Testing'];
    
    // API changes need curl examples
    if (context.analysis.hasApiChanges) {
      guide.push(this.generateApiTestExamples(context));
    }
    
    // UI changes need interaction steps
    if (context.analysis.hasUiChanges) {
      guide.push(this.generateUiTestSteps(context));
    }
    
    return guide.join('\n');
  }
}
```

### Step 5: Implement Metadata Manager
Create `src/rmapp/pr/metadata.ts`:
```typescript
class PRMetadataManager {
  async generateMetadata(context: PRContext): Promise<PRMetadata> {
    return {
      title: await this.generateTitle(context),
      labels: await this.determineLabels(context),
      reviewers: await this.suggestReviewers(context),
      assignees: await this.determineAssignees(context),
      milestone: await this.selectMilestone(context),
      projects: await this.selectProjects(context)
    };
  }
  
  private async generateTitle(context: PRContext): Promise<string> {
    // Use issue title as base
    let title = context.issue.title;
    
    // Add prefix if needed
    if (context.analysis.isBugFix) {
      title = `fix: ${title}`;
    } else if (context.analysis.isFeature) {
      title = `feat: ${title}`;
    }
    
    // Add issue reference
    title += ` (#${context.issue.number})`;
    
    return title;
  }
  
  private async suggestReviewers(context: PRContext): Promise<string[]> {
    // Based on changed files
    const codeOwners = await this.getCodeOwners(context.changedFiles);
    
    // Based on expertise
    const experts = await this.findExperts(context.analysis);
    
    // Combine and rank
    return this.rankReviewers([...codeOwners, ...experts]);
  }
}
```

### Step 6: Create PR Submission Handler
Build `src/rmapp/pr/submission.ts`:
```typescript
class PRSubmissionHandler {
  async createPR(context: PRContext): Promise<PullRequest> {
    // Generate all content
    const description = await this.generateDescription(context);
    const metadata = await this.generateMetadata(context);
    
    // Create PR
    const pr = await this.github.createPullRequest({
      owner: context.repo.owner,
      repo: context.repo.name,
      title: metadata.title,
      body: description,
      head: context.branch,
      base: context.baseBranch,
      draft: context.options.draft ?? false
    });
    
    // Add metadata
    await this.applyMetadata(pr, metadata);
    
    // Link to issue
    await this.linkToIssue(pr, context.issue);
    
    // Post creation comment
    await this.postCreationComment(pr, context);
    
    return pr;
  }
  
  private async postCreationComment(
    pr: PullRequest,
    context: PRContext
  ): Promise<void> {
    const comment = `
🤖 **Automated Implementation Complete**

This PR implements #${context.issue.number} following the [execution plan](${context.planUrl}).

**Execution Summary:**
- Steps completed: ${context.completedSteps}/${context.totalSteps}
- Tests added: ${context.stats.testsAdded}
- Files changed: ${context.stats.filesChanged}
- Execution time: ${context.executionTime}

Please review the changes and let me know if any adjustments are needed.
    `;
    
    await this.github.createComment(pr.number, comment);
  }
}
```

### Step 7: Add PR Validator
Create `src/rmapp/pr/validator.ts`:
```typescript
class PRValidator {
  async validate(pr: DraftPR): Promise<ValidationResult> {
    const checks = [
      this.checkDescription(pr),
      this.checkTitle(pr),
      this.checkLabels(pr),
      this.checkSize(pr),
      this.checkTests(pr)
    ];
    
    const results = await Promise.all(checks);
    
    return {
      valid: results.every(r => r.valid),
      warnings: results.flatMap(r => r.warnings),
      errors: results.flatMap(r => r.errors)
    };
  }
  
  private async checkTests(pr: DraftPR): Promise<CheckResult> {
    // Ensure tests were added for new code
    // Check test coverage if available
    // Verify tests pass
  }
}
```

### Step 8: Create PR Pipeline
Combine in `src/rmapp/pr/pipeline.ts`:
```typescript
class PRCreationPipeline {
  async createFromImplementation(
    workflow: IssueWorkflow
  ): Promise<PullRequest> {
    // Analyze changes
    const analysis = await this.analyzer.analyze(
      workflow.workspace,
      workflow.baseBranch
    );
    
    // Build context
    const context: PRContext = {
      issue: workflow.issue,
      analysis,
      plan: workflow.plan,
      workflow,
      options: workflow.prOptions
    };
    
    // Generate content
    const description = await this.generator.generate(context);
    const metadata = await this.metadataManager.generate(context);
    
    // Validate
    const validation = await this.validator.validate({
      ...description,
      ...metadata
    });
    
    if (!validation.valid) {
      throw new PRCreationError(validation);
    }
    
    // Submit
    return await this.submitter.create(context);
  }
}
```

## Testing Strategy
1. Test template generation
2. Test change analysis accuracy
3. Test description quality
4. Test metadata generation
5. Integration test PR creation

## Success Criteria
- [ ] PRs have comprehensive descriptions
- [ ] All changes are documented
- [ ] Testing notes are helpful
- [ ] Correct labels and reviewers assigned
- [ ] PRs link back to issues properly