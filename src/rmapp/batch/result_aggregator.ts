import type { 
  BatchItem, 
  BatchResults, 
  SuccessfulItem, 
  FailedItem, 
  SkippedItem,
  TypeSummary,
  ResourceUsage
} from './types.js';

export class BatchResultAggregator {
  aggregate(items: BatchItem[], resourceUsage?: ResourceUsage): BatchResults {
    const results: BatchResults = {
      successful: [],
      failed: [],
      skipped: [],
      summary: {
        totalItems: items.length,
        successCount: 0,
        failureCount: 0,
        skippedCount: 0,
        duration: 0,
        byType: new Map(),
        resourceUsage
      }
    };
    
    // Find earliest start and latest end times
    let earliestStart = Infinity;
    let latestEnd = 0;
    
    // Categorize results
    for (const item of items) {
      // Track times
      if (item.startTime) {
        earliestStart = Math.min(earliestStart, item.startTime);
      }
      if (item.endTime) {
        latestEnd = Math.max(latestEnd, item.endTime);
      }
      
      // Categorize by status
      switch (item.status) {
        case 'completed':
          results.successful.push({
            item,
            result: item.result!,
            duration: (item.endTime || Date.now()) - (item.startTime || Date.now())
          });
          results.summary.successCount++;
          break;
          
        case 'failed':
          results.failed.push({
            item,
            error: item.result?.error || 'Unknown error',
            canRetry: this.canRetry(item),
            failureReason: this.getFailureReason(item)
          });
          results.summary.failureCount++;
          break;
          
        case 'skipped':
          results.skipped.push({
            item,
            reason: item.result?.error || 'Dependency failed'
          });
          results.summary.skippedCount++;
          break;
      }
      
      // Update type summary
      this.updateTypeSummary(results.summary.byType, item);
    }
    
    // Calculate total duration
    if (earliestStart !== Infinity && latestEnd > 0) {
      results.summary.duration = latestEnd - earliestStart;
    }
    
    // Calculate average durations by type
    for (const [_, typeSummary] of results.summary.byType) {
      if (typeSummary.success > 0 && typeSummary.avgDuration) {
        typeSummary.avgDuration = typeSummary.avgDuration / typeSummary.success;
      }
    }
    
    return results;
  }
  
  private updateTypeSummary(
    byType: Map<string, TypeSummary>, 
    item: BatchItem
  ): void {
    const type = item.type;
    const summary = byType.get(type) || {
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      avgDuration: 0
    };
    
    summary.total++;
    
    switch (item.status) {
      case 'completed':
        summary.success++;
        if (item.startTime && item.endTime) {
          summary.avgDuration = (summary.avgDuration || 0) + (item.endTime - item.startTime);
        }
        break;
      case 'failed':
        summary.failed++;
        break;
      case 'skipped':
        summary.skipped++;
        break;
    }
    
    byType.set(type, summary);
  }
  
  private canRetry(item: BatchItem): boolean {
    // Don't retry if explicitly marked as non-retryable
    if (item.result?.error?.includes('non-retryable')) {
      return false;
    }
    
    // Check failure reasons that are retryable
    const retryableErrors = [
      'timeout',
      'rate limit',
      'network error',
      'temporary',
      'workspace locked'
    ];
    
    const error = item.result?.error?.toLowerCase() || '';
    return retryableErrors.some(re => error.includes(re));
  }
  
  private getFailureReason(item: BatchItem): FailedItem['failureReason'] {
    const error = item.result?.error?.toLowerCase() || '';
    
    if (error.includes('timeout')) return 'timeout';
    if (error.includes('dependency')) return 'dependency_failed';
    if (error.includes('rate limit') || error.includes('resource')) return 'resource_limit';
    
    return 'error';
  }
  
  generateReport(results: BatchResults): string {
    const report: string[] = ['# Batch Operation Report\n'];
    
    // Summary section
    report.push('## Summary');
    report.push(`- Total items: ${results.summary.totalItems}`);
    report.push(`- Successful: ${results.summary.successCount} (${this.percentage(results.summary.successCount, results.summary.totalItems)}%)`);
    report.push(`- Failed: ${results.summary.failureCount} (${this.percentage(results.summary.failureCount, results.summary.totalItems)}%)`);
    report.push(`- Skipped: ${results.summary.skippedCount} (${this.percentage(results.summary.skippedCount, results.summary.totalItems)}%)`);
    report.push(`- Duration: ${this.formatDuration(results.summary.duration)}`);
    report.push('');
    
    // Resource usage
    if (results.summary.resourceUsage) {
      report.push('## Resource Usage');
      report.push(`- API calls: ${results.summary.resourceUsage.apiCalls}`);
      report.push(`- Peak memory: ${this.formatMemory(results.summary.resourceUsage.peakMemory)}`);
      report.push(`- Workspaces used: ${results.summary.resourceUsage.workspacesUsed}`);
      report.push('');
    }
    
    // By type breakdown
    if (results.summary.byType.size > 0) {
      report.push('## Breakdown by Type');
      for (const [type, summary] of results.summary.byType) {
        report.push(`\n### ${this.formatType(type)}`);
        report.push(`- Total: ${summary.total}`);
        report.push(`- Success: ${summary.success} (${this.percentage(summary.success, summary.total)}%)`);
        report.push(`- Failed: ${summary.failed}`);
        report.push(`- Skipped: ${summary.skipped}`);
        if (summary.avgDuration) {
          report.push(`- Average duration: ${this.formatDuration(summary.avgDuration)}`);
        }
      }
      report.push('');
    }
    
    // Successful items
    if (results.successful.length > 0) {
      report.push('## Successful Items');
      report.push('');
      
      for (const success of results.successful) {
        report.push(`### ${this.formatItemReference(success.item)}`);
        report.push(`- Summary: ${success.result.summary}`);
        report.push(`- Duration: ${this.formatDuration(success.duration)}`);
        
        if (success.result.artifacts && success.result.artifacts.length > 0) {
          report.push('- Artifacts:');
          for (const artifact of success.result.artifacts) {
            const link = artifact.url ? `[${artifact.reference}](${artifact.url})` : artifact.reference;
            report.push(`  - ${artifact.type}: ${link} - ${artifact.description || ''}`);
          }
        }
        
        report.push('');
      }
    }
    
    // Failed items
    if (results.failed.length > 0) {
      report.push('## Failed Items');
      report.push('');
      
      for (const failure of results.failed) {
        report.push(`### ${this.formatItemReference(failure.item)}`);
        report.push(`- Error: ${failure.error}`);
        report.push(`- Reason: ${failure.failureReason || 'Unknown'}`);
        report.push(`- Retryable: ${failure.canRetry ? 'Yes' : 'No'}`);
        report.push('');
      }
    }
    
    // Skipped items
    if (results.skipped.length > 0) {
      report.push('## Skipped Items');
      report.push('');
      
      for (const skipped of results.skipped) {
        report.push(`- ${this.formatItemReference(skipped.item)}: ${skipped.reason}`);
      }
      report.push('');
    }
    
    return report.join('\n');
  }
  
  generateSummaryTable(results: BatchResults): string {
    const table: string[] = [];
    
    table.push('| Status | Count | Percentage |');
    table.push('|--------|-------|------------|');
    table.push(`| ✅ Success | ${results.summary.successCount} | ${this.percentage(results.summary.successCount, results.summary.totalItems)}% |`);
    table.push(`| ❌ Failed | ${results.summary.failureCount} | ${this.percentage(results.summary.failureCount, results.summary.totalItems)}% |`);
    table.push(`| ⏭️ Skipped | ${results.summary.skippedCount} | ${this.percentage(results.summary.skippedCount, results.summary.totalItems)}% |`);
    table.push(`| **Total** | **${results.summary.totalItems}** | **100%** |`);
    
    return table.join('\n');
  }
  
  getRetryableItems(results: BatchResults): BatchItem[] {
    return results.failed
      .filter(f => f.canRetry)
      .map(f => f.item);
  }
  
  private formatItemReference(item: BatchItem): string {
    const prefix = {
      issue: '#',
      pr: 'PR #',
      review: 'Review '
    }[item.type] || '';
    
    return `${prefix}${item.reference} (${item.id})`;
  }
  
  private formatType(type: string): string {
    return type.charAt(0).toUpperCase() + type.slice(1) + 's';
  }
  
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
  
  private formatMemory(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
  }
  
  private percentage(value: number, total: number): number {
    if (total === 0) return 0;
    return Math.round((value / total) * 100);
  }
}