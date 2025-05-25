import type { ParsedReview, ChangeType } from '../reviews/types.js';
import type { 
  ReviewResponse, 
  AppliedChange, 
  BatchResponse, 
  CommitInfo, 
  BatchSummary,
  AnalyzedChange
} from './types.js';
import { ChangeApplier } from './change_applier.js';
import { ResponseGenerator } from './response_generator.js';
import { CommitManager } from './commit_manager.js';

export class BatchProcessor {
  private applier: ChangeApplier;
  private generator: ResponseGenerator;
  private commitManager: CommitManager;
  
  constructor(rmplanConfig = { defaultExecutor: 'claude-code' }) {
    this.applier = new ChangeApplier(rmplanConfig);
    this.generator = new ResponseGenerator();
    this.commitManager = new CommitManager();
  }
  
  async processBatch(
    reviews: ParsedReview[],
    workspace: string
  ): Promise<BatchResponse> {
    const responses: ReviewResponse[] = [];
    const allChanges: AppliedChange[] = [];
    
    // Group by file to minimize conflicts
    const byFile = this.groupByFile(reviews);
    
    // Process each file's changes
    for (const [file, fileReviews] of byFile) {
      const fileResult = await this.processFileReviews(
        file,
        fileReviews,
        workspace
      );
      
      // Collect all changes
      allChanges.push(...fileResult.changes);
      
      // Generate responses for each review
      for (const review of fileReviews) {
        const relevantChanges = fileResult.changes.filter(c => 
          this.isChangeForReview(c, review)
        );
        
        const response = this.generator.createReviewResponse(
          review.comment,
          { type: 'change' },
          {
            status: relevantChanges.length > 0 ? 'success' : 'failed',
            changes: relevantChanges,
            details: fileResult.details,
            changeType: (review.changeRequests[0]?.changeType || 'other') as ChangeType
          }
        );
        
        responses.push(response);
      }
    }
    
    // Create commit if changes were made
    let commit: CommitInfo | undefined;
    if (allChanges.length > 0) {
      commit = await this.commitManager.createReviewCommit(allChanges, reviews);
    }
    
    return {
      responses,
      commit,
      summary: this.generateSummary(responses, allChanges)
    };
  }
  
  private groupByFile(reviews: ParsedReview[]): Map<string, ParsedReview[]> {
    const byFile = new Map<string, ParsedReview[]>();
    
    for (const review of reviews) {
      // Get primary file from locations or change requests
      const file = review.locations[0]?.file || 
                   review.changeRequests[0]?.location?.file ||
                   review.comment.path;
                   
      if (file) {
        const existing = byFile.get(file) || [];
        existing.push(review);
        byFile.set(file, existing);
      }
    }
    
    return byFile;
  }
  
  private async processFileReviews(
    file: string,
    reviews: ParsedReview[],
    workspace: string
  ): Promise<{ changes: AppliedChange[], details: any }> {
    // Sort reviews by line number (bottom to top)
    const sorted = this.sortReviewsByLocation(reviews);
    
    // Convert to analyzed changes
    const analyzedChanges: AnalyzedChange[] = [];
    
    for (const review of sorted) {
      for (const changeRequest of review.changeRequests) {
        analyzedChanges.push({
          ...changeRequest,
          originalComment: review.comment.body,
          confidence: review.confidence ?? 0.8
        });
      }
    }
    
    // Apply changes
    const result = await this.applier.applyMultipleChanges(analyzedChanges, workspace);
    
    return {
      changes: result.changes,
      details: result.details
    };
  }
  
  private sortReviewsByLocation(reviews: ParsedReview[]): ParsedReview[] {
    return [...reviews].sort((a, b) => {
      const aLine = a.locations[0]?.startLine || a.comment.line || 0;
      const bLine = b.locations[0]?.startLine || b.comment.line || 0;
      
      // Sort by line number in reverse order (bottom to top)
      return bLine - aLine;
    });
  }
  
  private isChangeForReview(change: AppliedChange, review: ParsedReview): boolean {
    // Check if the change matches the review's location
    if (review.locations.length > 0) {
      return review.locations.some(loc => 
        loc.file === change.file &&
        this.isLocationOverlap(loc, change.location)
      );
    }
    
    // Check if file matches
    return change.file === review.comment.path;
  }
  
  private isLocationOverlap(loc1: any, loc2: any): boolean {
    if (!loc1 || !loc2) return false;
    
    const start1 = loc1.startLine;
    const end1 = loc1.endLine || loc1.startLine;
    const start2 = loc2.startLine;
    const end2 = loc2.endLine || loc2.startLine;
    
    // Check if ranges overlap
    return start1 <= end2 && start2 <= end1;
  }
  
  private generateSummary(
    responses: ReviewResponse[],
    changes: AppliedChange[]
  ): BatchSummary {
    const changesByType = new Map<ChangeType, number>();
    const filesModified = new Set<string>();
    
    // Count changes by type
    for (const change of changes) {
      changesByType.set(change.type, (changesByType.get(change.type) || 0) + 1);
      filesModified.add(change.file);
    }
    
    return {
      total: responses.length,
      successful: responses.filter(r => r.status === 'success').length,
      partial: responses.filter(r => r.status === 'partial').length,
      failed: responses.filter(r => r.status === 'failed').length,
      clarifications: responses.filter(r => r.action.type === 'clarification').length,
      filesModified: Array.from(filesModified),
      changesByType
    };
  }
  
  async processInBatches(
    reviews: ParsedReview[],
    workspace: string,
    batchSize: number = 10
  ): Promise<{ responses: ReviewResponse[], commits: CommitInfo[] }> {
    const allResponses: ReviewResponse[] = [];
    const commits: CommitInfo[] = [];
    
    // Process in batches
    for (let i = 0; i < reviews.length; i += batchSize) {
      const batch = reviews.slice(i, i + batchSize);
      const batchResult = await this.processBatch(batch, workspace);
      
      allResponses.push(...batchResult.responses);
      
      if (batchResult.commit) {
        commits.push(batchResult.commit);
      }
    }
    
    return { responses: allResponses, commits };
  }
}