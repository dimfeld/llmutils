import {
  ReviewIntent,
  type ChangeRequest,
  type Question,
  type ChangeType,
} from './types';

export class ReviewNLPParser {
  private patterns = {
    request: [
      /please\s+(add|implement|create|fix|update|change)/i,
      /can you\s+(add|change|modify|fix|update)/i,
      /should\s+(have|include|handle|add|implement)/i,
      /needs?\s+(to|a|an)/i,
      /missing\s+\w+/i,
      /this\s+(should|must|needs)/i,
      /don't forget to/i,
      /make sure to/i,
    ],
    suggestion: [
      /consider\s+/i,
      /might\s+be\s+better/i,
      /suggest\s+/i,
      /alternatively/i,
      /optional:/i,
      /nice to have/i,
      /could\s+(use|be|have)/i,
      /perhaps/i,
    ],
    question: [
      /why\s+(did|does|is|are)/i,
      /what\s+(is|does|about|are)/i,
      /how\s+(does|is|about|do)/i,
      /when\s+(does|is|will)/i,
      /where\s+(is|does|are)/i,
      /\?$/,
      /can you explain/i,
      /could you clarify/i,
    ],
    approval: [
      /LGTM/i,
      /looks good/i,
      /approve/i,
      /ship it/i,
      /nice work/i,
      /well done/i,
      /perfect/i,
      /👍|✅|🚀|💯/,
    ],
  };

  private priorityPatterns = {
    required: [
      /must\s+/i,
      /required/i,
      /needs?\s+to/i,
      /critical/i,
      /blocker/i,
      /before\s+merging/i,
    ],
    optional: [
      /optional/i,
      /nice to have/i,
      /could\s+/i,
      /maybe/i,
      /perhaps/i,
      /if you want/i,
    ],
  };

  parseIntent(comment: string): ReviewIntent {
    // Check for explicit markers first
    if (this.patterns.approval.some(p => p.test(comment))) {
      return ReviewIntent.Approval;
    }

    // Check for change requests before questions (since requests often contain questions)
    if (this.patterns.request.some(p => p.test(comment))) {
      return ReviewIntent.RequestChanges;
    }

    // Check if it's primarily a question
    const questionCount = this.patterns.question.filter(p => p.test(comment)).length;
    if (questionCount >= 2 || (comment.includes('?') && questionCount >= 1)) {
      return ReviewIntent.Question;
    }

    // Check for suggestions
    if (this.patterns.suggestion.some(p => p.test(comment))) {
      return ReviewIntent.Suggestion;
    }

    // Default to comment
    return ReviewIntent.Comment;
  }

  extractChangeRequests(comment: string): ChangeRequest[] {
    const requests: ChangeRequest[] = [];

    // Split into sentences
    const sentences = this.splitSentences(comment);

    for (const sentence of sentences) {
      const request = this.parseChangeRequest(sentence, comment);
      if (request) {
        requests.push(request);
      }
    }

    // Merge related requests
    return this.mergeRelatedRequests(requests);
  }

  extractQuestions(comment: string): Question[] {
    const questions: Question[] = [];
    const sentences = this.splitSentences(comment);

    for (const sentence of sentences) {
      if (this.isQuestion(sentence)) {
        questions.push({
          text: sentence.trim(),
          topic: this.inferQuestionTopic(sentence),
          needsResponse: this.requiresResponse(sentence),
        });
      }
    }

    return questions;
  }

  private splitSentences(text: string): string[] {
    // Handle code blocks separately
    const codeBlocks: string[] = [];
    let processedText = text.replace(/```[\s\S]*?```/g, (match) => {
      codeBlocks.push(match);
      return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });

    // Split by sentence endings or numbered lists
    const sentences = processedText.split(/(?<=[.!?])\s+(?=[A-Z])|\n\s*\d+\.|\n\n/);

    // Restore code blocks
    return sentences.map(s => {
      return s.replace(/__CODE_BLOCK_(\d+)__/g, (_, index) => codeBlocks[parseInt(index)]);
    }).filter(s => s.trim().length > 0);
  }

  private parseChangeRequest(sentence: string, fullComment: string): ChangeRequest | null {
    // Skip if it's a question or approval
    if (this.isQuestion(sentence) || this.patterns.approval.some(p => p.test(sentence))) {
      return null;
    }

    // Check if it contains actionable content
    const hasActionableContent = 
      this.patterns.request.some(p => p.test(sentence)) ||
      this.patterns.suggestion.some(p => p.test(sentence));

    if (!hasActionableContent) {
      return null;
    }

    const type = this.inferRequestType(sentence);
    const priority = this.inferPriority(sentence, fullComment);

    // Extract suggested code if present
    const suggestedCode = this.extractSuggestedCode(sentence, fullComment);

    return {
      type,
      description: sentence.trim(),
      priority,
      suggestedCode,
      rationale: this.extractRationale(sentence, fullComment),
    };
  }

  private inferRequestType(text: string): 'add' | 'modify' | 'remove' | 'refactor' {
    const lowerText = text.toLowerCase();

    if (/add|implement|create|include/.test(lowerText)) {
      return 'add';
    }
    if (/remove|delete|drop/.test(lowerText)) {
      return 'remove';
    }
    if (/refactor|extract|move|rename/.test(lowerText)) {
      return 'refactor';
    }
    return 'modify';
  }

  private inferPriority(
    sentence: string,
    fullComment: string
  ): 'required' | 'suggested' | 'optional' {
    // Check sentence first
    if (this.priorityPatterns.required.some(p => p.test(sentence))) {
      return 'required';
    }
    if (this.priorityPatterns.optional.some(p => p.test(sentence))) {
      return 'optional';
    }

    // Check full comment context
    if (this.priorityPatterns.required.some(p => p.test(fullComment))) {
      return 'required';
    }

    // Default based on intent patterns
    if (this.patterns.suggestion.some(p => p.test(sentence))) {
      return 'suggested';
    }

    return 'suggested';
  }

  private extractSuggestedCode(sentence: string, fullComment: string): string | undefined {
    // Look for inline code in the sentence
    const inlineCode = sentence.match(/`([^`]+)`/);
    if (inlineCode) {
      return inlineCode[1];
    }

    // Look for code blocks after this sentence in the full comment
    const sentenceIndex = fullComment.indexOf(sentence);
    if (sentenceIndex !== -1) {
      const afterSentence = fullComment.substring(sentenceIndex + sentence.length);
      const codeBlock = afterSentence.match(/```(?:\w+)?\n([\s\S]*?)\n```/);
      if (codeBlock && afterSentence.indexOf(codeBlock[0]) < 100) {
        return codeBlock[1].trim();
      }
    }

    return undefined;
  }

  private extractRationale(sentence: string, fullComment: string): string | undefined {
    // Look for "because", "since", "as", etc.
    const rationalePatterns = [
      /because\s+([^.!?]+)/i,
      /since\s+([^.!?]+)/i,
      /as\s+([^.!?]+)/i,
      /to\s+(avoid|prevent|ensure|improve)\s+([^.!?]+)/i,
    ];

    for (const pattern of rationalePatterns) {
      const match = sentence.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    return undefined;
  }

  private isQuestion(sentence: string): boolean {
    return sentence.includes('?') || 
           this.patterns.question.some(p => p.test(sentence));
  }

  private inferQuestionTopic(question: string): string {
    const topics = {
      implementation: /\bhow\s+(does|is|to|do|will)/i,
      rationale: /\bwhy\s+(did|does|is|are|was)/i,
      clarification: /\bwhat\s+(is|does|about|are|happens)/i,
      timing: /\bwhen\s+(does|is|will|should)/i,
      location: /\bwhere\s+(is|does|are|should)/i,
      confirmation: /\b(is|are|does|do)\s+(this|that|it)/i,
    };

    for (const [topic, pattern] of Object.entries(topics)) {
      if (pattern.test(question)) {
        return topic;
      }
    }

    return 'general';
  }

  private requiresResponse(question: string): boolean {
    // Questions that need a response vs rhetorical
    const rhetoricalPatterns = [
      /,\s*(isn't it|doesn't it|don't you think|right)\?$/i,
      /\b(obviously|clearly|surely)\b.*\?/i,
    ];

    return !rhetoricalPatterns.some(p => p.test(question));
  }

  private mergeRelatedRequests(requests: ChangeRequest[]): ChangeRequest[] {
    // Merge requests that refer to the same thing
    const merged: ChangeRequest[] = [];
    const used = new Set<number>();

    for (let i = 0; i < requests.length; i++) {
      if (used.has(i)) continue;

      const current = requests[i];
      const related: ChangeRequest[] = [current];

      for (let j = i + 1; j < requests.length; j++) {
        if (used.has(j)) continue;

        if (this.areRequestsRelated(current, requests[j])) {
          related.push(requests[j]);
          used.add(j);
        }
      }

      if (related.length > 1) {
        merged.push(this.combineRequests(related));
      } else {
        merged.push(current);
      }
    }

    return merged;
  }

  private areRequestsRelated(a: ChangeRequest, b: ChangeRequest): boolean {
    // Check if they mention the same symbols or concepts
    const aWords = new Set(a.description.toLowerCase().match(/\w+/g) || []);
    const bWords = new Set(b.description.toLowerCase().match(/\w+/g) || []);

    // Count common meaningful words (exclude common words)
    const commonWords = ['the', 'a', 'an', 'to', 'of', 'in', 'for', 'and', 'or', 'but'];
    let overlap = 0;

    for (const word of aWords) {
      if (bWords.has(word) && !commonWords.includes(word) && word.length > 2) {
        overlap++;
      }
    }

    return overlap >= 2;
  }

  private combineRequests(requests: ChangeRequest[]): ChangeRequest {
    // Take the highest priority
    const priority = requests.some(r => r.priority === 'required') ? 'required' :
                    requests.some(r => r.priority === 'suggested') ? 'suggested' : 'optional';

    // Combine descriptions
    const description = requests.map(r => r.description).join(' Also, ');

    // Combine suggested code
    const suggestedCode = requests
      .map(r => r.suggestedCode)
      .filter(Boolean)
      .join('\n\n');

    return {
      type: requests[0].type,
      description,
      priority,
      suggestedCode: suggestedCode || undefined,
      rationale: requests[0].rationale,
    };
  }
}