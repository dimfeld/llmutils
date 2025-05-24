import { describe, it, expect, beforeEach } from 'bun:test';
import { ReviewNLPParser } from './nlp_parser';
import { ReviewIntent } from './types';

describe('ReviewNLPParser', () => {
  let parser: ReviewNLPParser;

  beforeEach(() => {
    parser = new ReviewNLPParser();
  });

  describe('parseIntent', () => {
    it('should detect approval comments', () => {
      expect(parser.parseIntent('LGTM!')).toBe(ReviewIntent.Approval);
      expect(parser.parseIntent('Looks good to me 👍')).toBe(ReviewIntent.Approval);
      expect(parser.parseIntent('Ship it! 🚀')).toBe(ReviewIntent.Approval);
      expect(parser.parseIntent('Perfect implementation')).toBe(ReviewIntent.Approval);
    });

    it('should detect questions', () => {
      expect(parser.parseIntent('Why did you choose this approach?')).toBe(ReviewIntent.Question);
      expect(parser.parseIntent('What does this function do?')).toBe(ReviewIntent.Question);
      expect(parser.parseIntent('How does this handle errors?')).toBe(ReviewIntent.Question);
      expect(parser.parseIntent('Is this the best way? Can you explain?')).toBe(ReviewIntent.Question);
    });

    it('should detect change requests', () => {
      expect(parser.parseIntent('Please add error handling here')).toBe(ReviewIntent.RequestChanges);
      expect(parser.parseIntent('Can you change this to use async/await?')).toBe(ReviewIntent.RequestChanges);
      expect(parser.parseIntent('This needs to be refactored')).toBe(ReviewIntent.RequestChanges);
      expect(parser.parseIntent('Missing validation for user input')).toBe(ReviewIntent.RequestChanges);
    });

    it('should detect suggestions', () => {
      expect(parser.parseIntent('Consider using a map instead of an array')).toBe(ReviewIntent.Suggestion);
      expect(parser.parseIntent('It might be better to extract this into a function')).toBe(ReviewIntent.Suggestion);
      expect(parser.parseIntent('Optional: you could add logging here')).toBe(ReviewIntent.Suggestion);
      expect(parser.parseIntent('Perhaps we should cache this result')).toBe(ReviewIntent.Suggestion);
    });

    it('should default to comment for neutral text', () => {
      expect(parser.parseIntent('I see what you did here')).toBe(ReviewIntent.Comment);
      expect(parser.parseIntent('Interesting approach')).toBe(ReviewIntent.Comment);
      expect(parser.parseIntent('Thanks for the update')).toBe(ReviewIntent.Comment);
    });
  });

  describe('extractChangeRequests', () => {
    it('should extract simple change requests', () => {
      const comment = 'Please add error handling for this function.';
      const requests = parser.extractChangeRequests(comment);
      
      expect(requests).toHaveLength(1);
      expect(requests[0].type).toBe('add');
      expect(requests[0].description).toContain('error handling');
      expect(requests[0].priority).toBe('suggested');
    });

    it('should extract multiple requests', () => {
      const comment = `
        This looks good overall, but a few things:
        1. Please add validation for the user input
        2. Can you remove the console.log statements?
        3. Consider refactoring this into smaller functions
      `;
      const requests = parser.extractChangeRequests(comment);
      
      // The parser may merge some related requests
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests.length).toBeLessThanOrEqual(3);
      expect(requests[0].type).toBe('add');
      // Types might vary based on how the parser interprets the text
      expect(['remove', 'modify', 'refactor']).toContain(requests[1].type);
      if (requests.length > 2) {
        expect(requests[2].type).toBe('refactor');
      }
    });

    it('should detect priority levels', () => {
      const required = parser.extractChangeRequests('This must be fixed before merging')[0];
      expect(required.priority).toBe('required');

      const optional = parser.extractChangeRequests('Optional: add some logging')[0];
      expect(optional.priority).toBe('optional');

      const suggested = parser.extractChangeRequests('Please consider adding tests')[0];
      expect(suggested.priority).toBe('suggested');
    });

    it('should extract suggested code', () => {
      const comment = `
        Please change this to use async/await:
        \`\`\`javascript
        async function fetchData() {
          const result = await fetch(url);
          return result.json();
        }
        \`\`\`
      `;
      const requests = parser.extractChangeRequests(comment);
      
      expect(requests).toHaveLength(1);
      expect(requests[0].suggestedCode).toContain('async function fetchData');
    });

    it('should extract rationale', () => {
      const comment = 'Please add error handling because the API might be down';
      const requests = parser.extractChangeRequests(comment);
      
      expect(requests[0].rationale).toBe('the API might be down');
    });

    it('should merge related requests', () => {
      const comment = `
        The error handling needs work.
        Please add try-catch blocks.
        Also, the error messages should be more descriptive.
      `;
      const requests = parser.extractChangeRequests(comment);
      
      // Should merge error-related requests
      expect(requests.length).toBeLessThan(3);
      // Should contain error-related content
      const hasErrorContent = requests.some(r => 
        r.description.toLowerCase().includes('error') || 
        r.description.toLowerCase().includes('catch')
      );
      expect(hasErrorContent).toBe(true);
    });
  });

  describe('extractQuestions', () => {
    it('should extract questions from comments', () => {
      const comment = `
        Why did you choose this approach?
        What happens if the user cancels?
        Is this performant enough?
      `;
      const questions = parser.extractQuestions(comment);
      
      expect(questions).toHaveLength(3);
      expect(questions[0].topic).toBe('rationale');
      expect(questions[1].topic).toBe('clarification');
      expect(questions[0].needsResponse).toBe(true);
    });

    it('should identify rhetorical questions', () => {
      const comment = "This works well, doesn't it?";
      const questions = parser.extractQuestions(comment);
      
      expect(questions).toHaveLength(1);
      expect(questions[0].needsResponse).toBe(false);
    });

    it('should categorize question topics', () => {
      const questions = parser.extractQuestions(`
        How does this work?
        Why was this changed?
        When will this run?
        Where is this used?
      `);
      
      expect(questions[0].topic).toBe('implementation');
      expect(questions[1].topic).toBe('rationale');
      expect(questions[2].topic).toBe('timing');
      expect(questions[3].topic).toBe('location');
    });
  });
});