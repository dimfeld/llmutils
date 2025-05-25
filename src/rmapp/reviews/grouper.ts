import {
  ReviewIntent,
  type ParsedReview,
  type GroupedReviews,
  type PrioritizedGroups,
  type ChangeType,
} from './types';

export class ReviewGrouper {
  groupReviews(reviews: ParsedReview[]): GroupedReviews {
    const groups: GroupedReviews = {
      byFile: new Map<string, ParsedReview[]>(),
      byType: new Map<ChangeType, ParsedReview[]>(),
      byPriority: new Map<string, ParsedReview[]>(),
      byAuthor: new Map<string, ParsedReview[]>(),
    };

    for (const review of reviews) {
      // Group by file
      for (const location of review.locations) {
        if (!groups.byFile.has(location.file)) {
          groups.byFile.set(location.file, []);
        }
        groups.byFile.get(location.file)!.push(review);
      }

      // If no specific locations, group under other
      if (review.locations.length === 0) {
        if (!groups.byFile.has('_other')) {
          groups.byFile.set('_other', []);
        }
        groups.byFile.get('_other')!.push(review);
      }

      // Group by change type
      for (const changeRequest of review.changeRequests) {
        const changeType = changeRequest.changeType || 'other';
        if (!groups.byType.has(changeType)) {
          groups.byType.set(changeType, []);
        }
        groups.byType.get(changeType)!.push(review);
      }

      // Group by priority
      const priority = this.getReviewPriority(review);
      if (!groups.byPriority.has(priority)) {
        groups.byPriority.set(priority, []);
      }
      groups.byPriority.get(priority)!.push(review);

      // Group by author
      if (!groups.byAuthor.has(review.comment.author)) {
        groups.byAuthor.set(review.comment.author, []);
      }
      groups.byAuthor.get(review.comment.author)!.push(review);
    }

    return groups;
  }

  prioritizeGroups(groups: GroupedReviews): PrioritizedGroups {
    const prioritized: PrioritizedGroups = {
      required: [],
      suggested: [],
      optional: [],
      questions: [],
    };

    // Extract from priority groups
    const required = groups.byPriority.get('required') || [];
    const suggested = groups.byPriority.get('suggested') || [];
    const optional = groups.byPriority.get('optional') || [];

    // Sort each priority group
    prioritized.required = this.sortByComplexityAndDependencies(required);
    prioritized.suggested = this.sortByComplexityAndDependencies(suggested);
    prioritized.optional = this.sortByComplexityAndDependencies(optional);

    // Extract questions
    prioritized.questions = Array.from(groups.byPriority.values())
      .flat()
      .filter(review => review.intent === ReviewIntent.Question);

    return prioritized;
  }

  private getReviewPriority(review: ParsedReview): string {
    // If it's just a question, treat as optional
    if (review.intent === ReviewIntent.Question && review.changeRequests.length === 0) {
      return 'optional';
    }

    // If approval, also optional
    if (review.intent === ReviewIntent.Approval) {
      return 'optional';
    }

    // Check change request priorities
    const priorities = review.changeRequests.map(r => r.priority);
    
    if (priorities.includes('required')) {
      return 'required';
    }
    if (priorities.includes('suggested')) {
      return 'suggested';
    }
    
    return 'optional';
  }

  private sortByComplexityAndDependencies(reviews: ParsedReview[]): ParsedReview[] {
    return reviews.sort((a, b) => {
      // First sort by complexity (simple first)
      const aComplexity = this.getReviewComplexity(a);
      const bComplexity = this.getReviewComplexity(b);
      
      if (aComplexity !== bComplexity) {
        const complexityOrder = { low: 0, medium: 1, high: 2 };
        return complexityOrder[aComplexity] - complexityOrder[bComplexity];
      }

      // Then by number of files affected (fewer first)
      const aFiles = new Set(a.locations.map(l => l.file)).size;
      const bFiles = new Set(b.locations.map(l => l.file)).size;
      
      if (aFiles !== bFiles) {
        return aFiles - bFiles;
      }

      // Then by estimated LOC (smaller first)
      const aLOC = a.changeRequests.reduce((sum, r) => sum + (r.estimatedLOC || 0), 0);
      const bLOC = b.changeRequests.reduce((sum, r) => sum + (r.estimatedLOC || 0), 0);
      
      return aLOC - bLOC;
    });
  }

  private getReviewComplexity(review: ParsedReview): 'low' | 'medium' | 'high' {
    const complexities = review.changeRequests.map(r => r.complexity || 'medium');
    
    if (complexities.includes('high')) {
      return 'high';
    }
    if (complexities.includes('medium')) {
      return 'medium';
    }
    
    return 'low';
  }

  findRelatedReviews(review: ParsedReview, allReviews: ParsedReview[]): ParsedReview[] {
    const related: ParsedReview[] = [];
    const reviewFiles = new Set(review.locations.map(l => l.file));
    const reviewTypes = new Set(review.changeRequests.map(r => r.changeType));

    for (const other of allReviews) {
      if (other === review) continue;

      // Check file overlap
      const otherFiles = new Set(other.locations.map(l => l.file));
      const hasFileOverlap = [...reviewFiles].some(f => otherFiles.has(f));

      // Check type overlap
      const otherTypes = new Set(other.changeRequests.map(r => r.changeType));
      const hasTypeOverlap = [...reviewTypes].some(t => otherTypes.has(t));

      // Check if they're in the same thread
      const sameThread = review.comment.thread && 
                        other.comment.thread && 
                        review.comment.thread.id === other.comment.thread.id;

      if (hasFileOverlap || hasTypeOverlap || sameThread) {
        related.push(other);
      }
    }

    return related;
  }

  createBatches(
    prioritized: PrioritizedGroups,
    maxBatchSize: number = 5
  ): ParsedReview[][] {
    const batches: ParsedReview[][] = [];
    
    // Process in priority order
    const allReviews = [
      ...prioritized.required,
      ...prioritized.suggested,
      ...prioritized.optional,
    ];

    const processed = new Set<ParsedReview>();
    
    for (const review of allReviews) {
      if (processed.has(review)) continue;

      const batch: ParsedReview[] = [review];
      processed.add(review);

      // Find related reviews that can be batched together
      const related = this.findRelatedReviews(review, allReviews)
        .filter(r => !processed.has(r))
        .slice(0, maxBatchSize - 1);

      for (const rel of related) {
        batch.push(rel);
        processed.add(rel);
      }

      batches.push(batch);
    }

    return batches;
  }
}