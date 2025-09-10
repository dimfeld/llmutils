import { describe, test, expect } from 'bun:test';
import { createLinearClient } from '../../common/linear.js';

/**
 * Tests to verify that documented Linear URL formats actually work with our parser.
 * These tests validate that examples in the documentation are accurate.
 */
describe('Documentation Consistency Check', () => {
  describe('Linear URL Format Examples', () => {
    test('should parse Linear URLs exactly as documented', () => {
      // Create a Linear client instance to test parsing
      const linearClient = createLinearClient({ type: 'linear' });

      // Test all URL formats mentioned in the documentation

      // Example from README.md: https://linear.app/workspace/issue/TEAM-456
      const result1 = linearClient.parseIssueIdentifier(
        'https://linear.app/workspace/issue/TEAM-456'
      );
      expect(result1?.identifier).toBe('TEAM-456');

      // Example from linear-integration.md: https://linear.app/workspace/issue/TEAM-123
      const result2 = linearClient.parseIssueIdentifier(
        'https://linear.app/workspace/issue/TEAM-123'
      );
      expect(result2?.identifier).toBe('TEAM-123');

      // Example with slug from linear-integration.md
      const result3 = linearClient.parseIssueIdentifier(
        'https://linear.app/workspace/issue/TEAM-123/implement-user-authentication'
      );
      expect(result3?.identifier).toBe('TEAM-123');

      // Various team identifier formats mentioned in documentation
      const result4 = linearClient.parseIssueIdentifier(
        'https://linear.app/company/issue/PROJ-001'
      );
      expect(result4?.identifier).toBe('PROJ-001');

      const result5 = linearClient.parseIssueIdentifier(
        'https://linear.app/mycompany/issue/ABC123-789'
      );
      expect(result5?.identifier).toBe('ABC123-789');
    });

    test('should handle direct issue IDs as documented', () => {
      const linearClient = createLinearClient({ type: 'linear' });

      // Direct issue ID formats mentioned in documentation
      expect(linearClient.parseIssueIdentifier('TEAM-123')?.identifier).toBe('TEAM-123');
      expect(linearClient.parseIssueIdentifier('PROJ-456')?.identifier).toBe('PROJ-456');
      expect(linearClient.parseIssueIdentifier('ABC123-789')?.identifier).toBe('ABC123-789');

      // We also allow lowercase
      expect(linearClient.parseIssueIdentifier('TEAM-123')?.identifier).toBe('TEAM-123');
    });

    test('should reject invalid formats not documented', () => {
      const linearClient = createLinearClient({ type: 'linear' });

      // These formats are not documented as supported and should return null
      expect(linearClient.parseIssueIdentifier('invalid-format')).toBeNull();
      expect(linearClient.parseIssueIdentifier('TEAM123')).toBeNull(); // Missing dash
    });
  });

  describe('Linear Issue ID Format Validation', () => {
    test('should match documented Linear issue ID patterns', () => {
      const linearClient = createLinearClient({ type: 'linear' });

      // From linear-integration.md: "TEAM-123 where TEAM is your Linear team identifier (uppercase letters and numbers)"
      const validPatterns = [
        'TEAM-123',
        'PROJ-456',
        'ABC123-789',
        'A-1',
        'TEAM123-456',
        'PROJ1-2',
        // We also allow lowercase for convenience of typing, and convert before talking to the API
        'team-123',
      ];

      for (const pattern of validPatterns) {
        const result = linearClient.parseIssueIdentifier(pattern);
        expect(result).not.toBeNull();
        expect(result?.identifier).toBe(pattern.toUpperCase());
      }
    });

    test('should reject patterns not matching documentation', () => {
      const linearClient = createLinearClient({ type: 'linear' });

      const invalidPatterns = [
        // 'team-123', // Lowercase team identifier. We allow this and convert internally to make things easier to type
        'TEAM123', // Missing dash
        'TEAM-', // Missing number
        '-123', // Missing team identifier
        'TEAM-ABC', // Non-numeric issue number
        'team_123', // Underscore instead of dash
        '123', // Just a number
      ];

      for (const pattern of invalidPatterns) {
        const result = linearClient.parseIssueIdentifier(pattern);
        expect(result).toBeNull();
      }
    });
  });
});
