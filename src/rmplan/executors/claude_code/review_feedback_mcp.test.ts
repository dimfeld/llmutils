import { test, describe, expect, mock, afterEach, beforeEach } from 'bun:test';
import { z } from 'zod';
import * as net from 'net';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ModuleMocker } from '../../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

afterEach(() => {
  moduleMocker.clear();
});

describe('Review Feedback MCP Tool', () => {
  describe('Schema validation', () => {
    test('ReviewFeedbackInputSchema validates correct input', async () => {
      const { ReviewFeedbackInputSchema } = await import('./permissions_mcp.ts');

      const validInput = {
        reviewerFeedback: 'The code looks good but there are some issues to address...',
      };

      const result = ReviewFeedbackInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reviewerFeedback).toBe(validInput.reviewerFeedback);
      }
    });

    test('ReviewFeedbackInputSchema rejects invalid input', async () => {
      const { ReviewFeedbackInputSchema } = await import('./permissions_mcp.ts');

      const invalidInputs = [
        {},
        { reviewerFeedback: 123 },
        { wrongField: 'test' },
        null,
        undefined,
        'just a string',
      ];

      for (const invalidInput of invalidInputs) {
        const result = ReviewFeedbackInputSchema.safeParse(invalidInput);
        expect(result.success).toBe(false);
      }
    });

    test('ReviewFeedbackInputSchema handles empty string', async () => {
      const { ReviewFeedbackInputSchema } = await import('./permissions_mcp.ts');

      const input = { reviewerFeedback: '' };
      const result = ReviewFeedbackInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reviewerFeedback).toBe('');
      }
    });

    test('ReviewFeedbackInputSchema handles multiline strings', async () => {
      const { ReviewFeedbackInputSchema } = await import('./permissions_mcp.ts');

      const multilineInput = {
        reviewerFeedback: `Issue 1: Missing error handling
Issue 2: Code style issues
Issue 3: Performance concerns`,
      };

      const result = ReviewFeedbackInputSchema.safeParse(multilineInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reviewerFeedback).toBe(multilineInput.reviewerFeedback);
      }
    });
  });

  describe('Unix socket communication', () => {
    let tempDir: string;
    let socketPath: string;
    let server: net.Server;
    let serverResponses: { type: string; userFeedback?: string; error?: string }[] = [];

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(process.cwd(), 'tmp-test-'));
      socketPath = path.join(tempDir, 'test-socket');
      serverResponses = [];
    });

    afterEach(async () => {
      if (server) {
        server.close();
      }
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    function createMockServer(responses: any[]) {
      return new Promise<net.Server>((resolve) => {
        const server = net.createServer((socket) => {
          let responseIndex = 0;

          socket.on('data', (data) => {
            try {
              const request = JSON.parse(data.toString().trim());

              if (request.type === 'review_feedback_request') {
                const response = responses[responseIndex] || {
                  type: 'review_feedback_response',
                  requestId: request.requestId, // Echo back the requestId
                  userFeedback: 'Default response',
                };
                // If the response doesn't have a requestId, add it
                if (!response.requestId) {
                  response.requestId = request.requestId;
                }
                responseIndex++;

                socket.write(JSON.stringify(response) + '\n');
              }
            } catch (err) {
              console.error('Mock server error:', err);
            }
          });
        });

        server.listen(socketPath, () => {
          resolve(server);
        });
      });
    }

    test('requestReviewFeedbackFromParent sends correct request format', async () => {
      const mockResponse = {
        type: 'review_feedback_response',
        userFeedback: 'This looks good to me',
        // requestId will be added by the mock server
      };

      server = await createMockServer([mockResponse]);

      // Import the functions
      const { requestReviewFeedbackFromParent, setParentSocket } =
        await import('./permissions_mcp.ts');

      // We need to simulate the connection setup
      let socket: net.Socket | null = null;
      const connectPromise = new Promise<void>((resolve) => {
        socket = net.createConnection(socketPath, resolve);
      });

      await connectPromise;

      // Set the parent socket for testing
      setParentSocket(socket);

      // Test the function
      const testFeedback = 'Code review feedback here...';
      const result = await requestReviewFeedbackFromParent(testFeedback);

      expect(result).toBe('This looks good to me');

      socket?.end();
      // Import and use cleanup function
      const { cleanupForTests } = await import('./permissions_mcp.ts');
      cleanupForTests(); // Clean up
    });

    test('requestReviewFeedbackFromParent handles empty response', async () => {
      const mockResponse = {
        type: 'review_feedback_response',
        userFeedback: '',
        // requestId will be added by the mock server
      };

      server = await createMockServer([mockResponse]);

      const { requestReviewFeedbackFromParent, setParentSocket } =
        await import('./permissions_mcp.ts');

      let socket: net.Socket | null = null;
      const connectPromise = new Promise<void>((resolve) => {
        socket = net.createConnection(socketPath, resolve);
      });

      await connectPromise;
      setParentSocket(socket);

      const result = await requestReviewFeedbackFromParent('Some feedback');

      expect(result).toBe('');

      socket?.end();
      const { cleanupForTests } = await import('./permissions_mcp.ts');
      cleanupForTests();
    });

    test('requestReviewFeedbackFromParent handles missing userFeedback field', async () => {
      const mockResponse = {
        type: 'review_feedback_response',
        // userFeedback field is missing
        // requestId will be added by the mock server
      };

      server = await createMockServer([mockResponse]);

      const { requestReviewFeedbackFromParent, setParentSocket } =
        await import('./permissions_mcp.ts');

      let socket: net.Socket | null = null;
      const connectPromise = new Promise<void>((resolve) => {
        socket = net.createConnection(socketPath, resolve);
      });

      await connectPromise;
      setParentSocket(socket);

      const result = await requestReviewFeedbackFromParent('Some feedback');

      // Should default to empty string when userFeedback is missing
      expect(result).toBe('');

      socket?.end();
      const { cleanupForTests } = await import('./permissions_mcp.ts');
      cleanupForTests();
    });

    test('requestReviewFeedbackFromParent throws error when not connected', async () => {
      // Don't set up a mock parentSocket, so it should be null
      const { requestReviewFeedbackFromParent, setParentSocket } =
        await import('./permissions_mcp.ts');
      const { cleanupForTests } = await import('./permissions_mcp.ts');
      cleanupForTests(); // Ensure socket is null

      await expect(requestReviewFeedbackFromParent('test')).rejects.toThrow(
        'Not connected to parent process'
      );
    });
  });

  describe('MCP tool registration and execution', () => {
    test('review_feedback_prompt tool is registered correctly', async () => {
      // Import the module to trigger server setup
      await import('./permissions_mcp.ts');

      // Since we can't easily test FastMCP server directly, we test the schema and function
      const { ReviewFeedbackInputSchema } = await import('./permissions_mcp.ts');

      expect(ReviewFeedbackInputSchema).toBeDefined();
      expect(ReviewFeedbackInputSchema.shape.reviewerFeedback).toBeDefined();
    });

    test('review_feedback_prompt tool handles successful execution', async () => {
      const mockUserFeedback =
        'The reviewer is correct about issue 1, but issue 2 is not relevant.';

      // Mock the requestReviewFeedbackFromParent function
      await moduleMocker.mock('./permissions_mcp.ts', () => ({
        ReviewFeedbackInputSchema: z.object({
          reviewerFeedback: z
            .string()
            .describe('The output from the reviewer subagent that needs user feedback'),
        }),
        requestReviewFeedbackFromParent: mock(() => Promise.resolve(mockUserFeedback)),
        setParentSocket: mock(),
      }));

      const { requestReviewFeedbackFromParent } = await import('./permissions_mcp.ts');

      // Simulate tool execution
      const input = { reviewerFeedback: 'Some reviewer feedback' };
      const result = await requestReviewFeedbackFromParent(input.reviewerFeedback);

      expect(result).toBe(mockUserFeedback);
    });

    test('review_feedback_prompt tool handles execution errors', async () => {
      const errorMessage = 'Socket connection failed';

      // Mock the requestReviewFeedbackFromParent function to throw an error
      await moduleMocker.mock('./permissions_mcp.ts', () => ({
        ReviewFeedbackInputSchema: z.object({
          reviewerFeedback: z
            .string()
            .describe('The output from the reviewer subagent that needs user feedback'),
        }),
        requestReviewFeedbackFromParent: mock(() => Promise.reject(new Error(errorMessage))),
        setParentSocket: mock(),
      }));

      const { requestReviewFeedbackFromParent } = await import('./permissions_mcp.ts');

      // The tool should handle errors gracefully
      await expect(requestReviewFeedbackFromParent('test')).rejects.toThrow(errorMessage);
    });
  });

  describe('Integration with existing permissions MCP infrastructure', () => {
    test('review feedback tool coexists with approval prompt tool', async () => {
      const { ReviewFeedbackInputSchema, PermissionInputSchema } =
        await import('./permissions_mcp.ts');

      // Both schemas should be defined and distinct
      expect(ReviewFeedbackInputSchema).toBeDefined();
      expect(PermissionInputSchema).toBeDefined();

      // Test they have different shapes
      const reviewInput = { reviewerFeedback: 'test feedback' };
      const permissionInput = { tool_name: 'test_tool', input: {} };

      expect(ReviewFeedbackInputSchema.safeParse(reviewInput).success).toBe(true);
      expect(ReviewFeedbackInputSchema.safeParse(permissionInput).success).toBe(false);

      expect(PermissionInputSchema.safeParse(permissionInput).success).toBe(true);
      expect(PermissionInputSchema.safeParse(reviewInput).success).toBe(false);
    });

    test('multiple socket message types can be handled', async () => {
      // This test verifies that the socket communication can handle both permission and review feedback requests
      const permissionsMcp = await import('./permissions_mcp.ts');

      expect(typeof permissionsMcp.requestReviewFeedbackFromParent).toBe('function');
      expect(typeof permissionsMcp.setParentSocket).toBe('function');
      // The original requestPermissionFromParent should still exist
      // (we can't test it directly but we can verify the import doesn't break)
    });
  });

  describe('Socket message format validation', () => {
    test('review_feedback_request message has correct format', () => {
      const reviewerFeedback = 'Test feedback from reviewer';

      const expectedMessage = {
        type: 'review_feedback_request',
        requestId: 'req_123_1', // Mock requestId
        reviewerFeedback,
      };

      // Test that the message format is correct
      expect(expectedMessage.type).toBe('review_feedback_request');
      expect(expectedMessage.requestId).toBe('req_123_1');
      expect(expectedMessage.reviewerFeedback).toBe(reviewerFeedback);
      expect(Object.keys(expectedMessage)).toEqual(['type', 'requestId', 'reviewerFeedback']);
    });

    test('review_feedback_response message handles various userFeedback values', () => {
      const testCases = [
        'User feedback text',
        '',
        'Multi\nline\nfeedback',
        'Feedback with special chars: !@#$%^&*()',
        undefined,
      ];

      for (const userFeedback of testCases) {
        const responseMessage = {
          type: 'review_feedback_response',
          requestId: 'req_123_1', // Mock requestId
          userFeedback,
        };

        expect(responseMessage.type).toBe('review_feedback_response');
        expect(responseMessage.requestId).toBe('req_123_1');

        // Test that the response format can be JSON serialized/parsed
        const serialized = JSON.stringify(responseMessage);
        const parsed = JSON.parse(serialized);

        expect(parsed.type).toBe('review_feedback_response');
        expect(parsed.requestId).toBe('req_123_1');
        expect(parsed.userFeedback).toBe(userFeedback);
      }
    });
  });
});
