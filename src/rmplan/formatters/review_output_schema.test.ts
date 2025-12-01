// Tests for review output JSON schema generation

import { describe, test, expect } from 'bun:test';
import {
  ReviewSeveritySchema,
  ReviewCategorySchema,
  ReviewIssueOutputSchema,
  ReviewOutputSchema,
  getReviewOutputJsonSchema,
  getReviewOutputJsonSchemaString,
} from './review_output_schema.js';

describe('ReviewSeveritySchema', () => {
  test('accepts valid severity values', () => {
    expect(ReviewSeveritySchema.safeParse('critical').success).toBe(true);
    expect(ReviewSeveritySchema.safeParse('major').success).toBe(true);
    expect(ReviewSeveritySchema.safeParse('minor').success).toBe(true);
    expect(ReviewSeveritySchema.safeParse('info').success).toBe(true);
  });

  test('rejects invalid severity values', () => {
    expect(ReviewSeveritySchema.safeParse('invalid').success).toBe(false);
    expect(ReviewSeveritySchema.safeParse('warning').success).toBe(false);
    expect(ReviewSeveritySchema.safeParse('').success).toBe(false);
    expect(ReviewSeveritySchema.safeParse(123).success).toBe(false);
  });
});

describe('ReviewCategorySchema', () => {
  test('accepts valid category values', () => {
    expect(ReviewCategorySchema.safeParse('security').success).toBe(true);
    expect(ReviewCategorySchema.safeParse('performance').success).toBe(true);
    expect(ReviewCategorySchema.safeParse('bug').success).toBe(true);
    expect(ReviewCategorySchema.safeParse('style').success).toBe(true);
    expect(ReviewCategorySchema.safeParse('compliance').success).toBe(true);
    expect(ReviewCategorySchema.safeParse('testing').success).toBe(true);
    expect(ReviewCategorySchema.safeParse('other').success).toBe(true);
  });

  test('rejects invalid category values', () => {
    expect(ReviewCategorySchema.safeParse('invalid').success).toBe(false);
    expect(ReviewCategorySchema.safeParse('error').success).toBe(false);
    expect(ReviewCategorySchema.safeParse('').success).toBe(false);
  });
});

describe('ReviewIssueOutputSchema', () => {
  test('accepts valid issue with all fields', () => {
    const issue = {
      severity: 'critical',
      category: 'security',
      content: 'SQL injection vulnerability',
      file: 'src/db.ts',
      line: '42',
      suggestion: 'Use parameterized queries',
    };

    const result = ReviewIssueOutputSchema.safeParse(issue);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(issue);
    }
  });

  test('accepts valid issue with all required fields', () => {
    const issue = {
      severity: 'minor',
      category: 'style',
      content: 'Consider using const instead of let',
      file: 'src/utils.ts',
      line: '15',
      suggestion: 'Use const for immutable values',
    };

    const result = ReviewIssueOutputSchema.safeParse(issue);
    expect(result.success).toBe(true);
  });

  test('rejects issue missing required fields', () => {
    expect(ReviewIssueOutputSchema.safeParse({ severity: 'critical' }).success).toBe(false);
    expect(ReviewIssueOutputSchema.safeParse({ category: 'bug' }).success).toBe(false);
    expect(ReviewIssueOutputSchema.safeParse({ content: 'test' }).success).toBe(false);
  });

  test('rejects issue with non-string line', () => {
    const issue = {
      severity: 'minor',
      category: 'style',
      content: 'test',
      file: 'src/test.ts',
      line: 42, // Should be string, not number
      suggestion: 'fix it',
    };

    expect(ReviewIssueOutputSchema.safeParse(issue).success).toBe(false);
  });

  test('accepts issue with line range as string', () => {
    const issue = {
      severity: 'minor',
      category: 'style',
      content: 'test',
      file: 'src/test.ts',
      line: '42-45',
      suggestion: 'fix it',
    };

    expect(ReviewIssueOutputSchema.safeParse(issue).success).toBe(true);
  });
});

describe('ReviewOutputSchema', () => {
  test('accepts valid complete output', () => {
    const output = {
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'XSS vulnerability',
          file: 'src/render.ts',
          line: '100',
          suggestion: 'Sanitize user input',
        },
        {
          severity: 'minor',
          category: 'style',
          content: 'Inconsistent naming',
          file: 'src/utils.ts',
          line: '25',
          suggestion: 'Use consistent naming conventions',
        },
      ],
      recommendations: ['Add input validation layer', 'Consider using TypeScript strict mode'],
      actionItems: ['Fix XSS before deployment', 'Add security tests'],
    };

    const result = ReviewOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  test('accepts output with empty arrays', () => {
    const output = {
      issues: [],
      recommendations: [],
      actionItems: [],
    };

    const result = ReviewOutputSchema.safeParse(output);
    expect(result.success).toBe(true);
  });

  test('rejects output missing required fields', () => {
    expect(ReviewOutputSchema.safeParse({ issues: [] }).success).toBe(false);
    expect(ReviewOutputSchema.safeParse({ recommendations: [] }).success).toBe(false);
    expect(ReviewOutputSchema.safeParse({ actionItems: [] }).success).toBe(false);
    expect(ReviewOutputSchema.safeParse({}).success).toBe(false);
  });

  test('rejects output with invalid issue in array', () => {
    const output = {
      issues: [{ invalid: 'structure' }],
      recommendations: [],
      actionItems: [],
    };

    expect(ReviewOutputSchema.safeParse(output).success).toBe(false);
  });
});

describe('getReviewOutputJsonSchema', () => {
  test('returns a valid JSON schema object', () => {
    const schema = getReviewOutputJsonSchema();

    expect(typeof schema).toBe('object');
    expect(schema).not.toBeNull();
  });

  test('schema has correct type property', () => {
    const schema = getReviewOutputJsonSchema() as Record<string, unknown>;

    expect(schema.type).toBe('object');
  });

  test('schema has properties for issues, recommendations, actionItems', () => {
    const schema = getReviewOutputJsonSchema() as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;

    expect(properties).toBeDefined();
    expect(properties.issues).toBeDefined();
    expect(properties.recommendations).toBeDefined();
    expect(properties.actionItems).toBeDefined();
  });

  test('issues property is an array type', () => {
    const schema = getReviewOutputJsonSchema() as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    const issues = properties.issues as Record<string, unknown>;

    expect(issues.type).toBe('array');
  });

  test('schema includes descriptions', () => {
    const schema = getReviewOutputJsonSchema() as Record<string, unknown>;

    // The schema should have a description
    expect(schema.description).toBeDefined();
    expect(typeof schema.description).toBe('string');
  });
});

describe('getReviewOutputJsonSchemaString', () => {
  test('returns a valid JSON string', () => {
    const schemaString = getReviewOutputJsonSchemaString();

    expect(typeof schemaString).toBe('string');
    expect(() => JSON.parse(schemaString)).not.toThrow();
  });

  test('returns formatted JSON (multi-line)', () => {
    const schemaString = getReviewOutputJsonSchemaString();

    expect(schemaString).toContain('\n');
    expect(schemaString).toContain('  '); // Has indentation
  });

  test('parsed string matches object version', () => {
    const schemaObject = getReviewOutputJsonSchema();
    const schemaString = getReviewOutputJsonSchemaString();
    const parsedString = JSON.parse(schemaString);

    expect(parsedString).toEqual(schemaObject);
  });
});

describe('JSON Schema compatibility', () => {
  test('schema can be used to validate example LLM output', () => {
    // Simulate what an LLM might produce
    const llmOutput = {
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content:
            'The function `processUserInput` at line 45 directly concatenates user input into a SQL query, creating a SQL injection vulnerability.',
          file: 'src/database/queries.ts',
          line: '45',
          suggestion:
            'Use parameterized queries: `db.query("SELECT * FROM users WHERE id = ?", [userId])`',
        },
        {
          severity: 'major',
          category: 'performance',
          content:
            'The loop on line 78 makes a database call for each item in the array, causing N+1 query problem.',
          file: 'src/services/user.ts',
          line: '78',
          suggestion: 'Batch the database queries or use a single query with IN clause.',
        },
        {
          severity: 'minor',
          category: 'style',
          content:
            'Variable names in this file use inconsistent casing (mix of camelCase and snake_case).',
          file: 'src/utils/format.ts',
          line: '12-24',
          suggestion: 'Use consistent camelCase naming throughout the file.',
        },
        {
          severity: 'info',
          category: 'testing',
          content: 'Consider adding unit tests for the edge case when the user list is empty.',
          file: 'src/services/user.ts',
          line: '150',
          suggestion: 'Add test case: it("handles empty user list", ...)',
        },
      ],
      recommendations: [
        'Consider implementing a centralized input validation layer to prevent injection attacks.',
        'Add database query logging to help identify performance bottlenecks.',
        'Set up a linter rule to enforce consistent variable naming conventions.',
      ],
      actionItems: [
        'CRITICAL: Fix SQL injection vulnerability in processUserInput before next release.',
        'Add integration tests for the user service database interactions.',
        'Review other database query locations for similar N+1 patterns.',
      ],
    };

    const result = ReviewOutputSchema.safeParse(llmOutput);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.issues).toHaveLength(4);
      expect(result.data.recommendations).toHaveLength(3);
      expect(result.data.actionItems).toHaveLength(3);
    }
  });
});
