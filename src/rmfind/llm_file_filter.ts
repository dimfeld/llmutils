import { generateObject } from 'ai';
import { encode } from 'gpt-tokenizer';
import { z } from 'zod';
import { createModel } from '../common/model_factory.ts';
import { debugLog, error } from '../logging.ts';
import * as path from 'node:path';

const baseQuery = `
# File Relevance Analyzer

You are a specialized assistant designed to analyze source code files and determine their relevance to a specific programming task or query. Your goal is to help developers identify which files from a grep search are most important for their task.

## Input Format
You will receive:
1. The original natural language query describing a task or question about a codebase
2. A list of files with their content that were returned from a grep search

## Output Format
You MUST provide your output as a single JSON object with the following structure:

\`\`\`json
{
  "query": "Original query text",
  "relevantFiles": [
    {
      "filename": "path/to/file.ext",
      "queryRelation": "How it relates to the task",
      "relevanceReason": "Brief explanation of why it's relevant",
      "relevance": "high|medium|low",
      "needsEditing": true|false|"maybe",
      "editingReason": "Explanation of why editing is needed or not",
      "relevance": "high|medium|low"
    }
  ]
}
\`\`\`

## Relevance Classification Criteria

### Highly Relevant
Files that:
- Contain the primary functionality described in the query
- Would definitely need to be modified to implement the requested changes
- Contain key methods, classes, or functions directly related to the query
- Define core data structures or interfaces mentioned in the query
- Are central to the architecture of the component in question

### Moderately Relevant
Files that:
- Interact with or call the primary functionality
- Contain supporting code that may need to be understood
- Define related interfaces or data structures
- Provide context for understanding the primary functionality
- Might need small modifications depending on implementation approach

### Low Relevance
Files that:
- Merely reference the relevant components tangentially
- Contain only comments or documentation about the component
- Only import or include the relevant components without significant interaction
- Are in the same directory but not directly related to the functionality

Files that are considered irrelevant can be omitted from the output.

## Important Considerations When Analyzing Files

### Code Understanding
- Identify main functions, classes, and methods in each file
- Recognize important data structures and their relationships
- Understand the flow of data through the code
- Identify how different components interact

### Implementation Analysis
- Look for code that implements the functionality described in the query
- Identify tests associated with the relevant functionality
- Recognize configuration or setup code related to the query
- Identify dependencies or imports related to the functionality

### Usage Analysis
- Determine how frequently relevant functions or classes are called
- Identify where key components are instantiated or initialized
- Understand how the component integrates with the rest of the system
- Recognize patterns of usage that might need to be modified

## Example

**Query**: "I need to add rate limiting to the API endpoints"

**Example Machine-Readable Output**:

\`\`\`json
{
  "query": "I need to add rate limiting to the API endpoints",
  "relevantFiles": [
    {
      "filename": "src/api/middleware/index.js",
      "queryRelation": "This is the main integration point for API middleware including authentication and logging",
      "relevanceReason": "Contains middleware pipeline for API requests where rate limiting would be integrated",
      "relevance": "high",
      "needsEditing": true,
      "editingReason": "Rate limiting middleware needs to be added to the pipeline"
    },
    {
      "filename": "src/config/api.js",
      "queryRelation": "Configuration parameters for rate limits would be defined here",
      "relevanceReason": "Contains API configuration including settings that would control rate limiting behavior",
      "relevance": "high",
      "needsEditing": true,
      "editingReason": "Rate limit configuration needs to be added"
    },
    {
      "filename": "src/api/controllers/userController.js",
      "queryRelation": "These endpoints would be protected by the rate limiting implementation",
      "relevanceReason": "Contains API endpoints that would be affected by rate limiting",
      "relevance": "medium",
      "needsEditing": false,
      "editingReason": "The rate limiting would be applied at the middleware level"
    },
    {
      "filename": "src/utils/redis.js",
      "queryRelation": "Could be used to store rate limiting counters and state",
      "relevanceReason": "Contains Redis client implementation which is commonly used for rate limiting",
      "relevance": "medium",
      "needsEditing": "maybe",
      "editingReason": "May need to add rate limiting specific methods"
    },
    {
      "filename": "src/api/models/user.js",
      "queryRelation": "No direct relationship to rate limiting",
      "relevanceReason": "Only defines user data structure with no connection to request processing",
      "relevance": "low",
      "needsEditing": false,
      "editingReason": "No changes needed for rate limiting implementation"
    }
  ]
}
\`\`\`

This example demonstrates how to provide machine-readable output with clear structured data about each file's relevance to adding rate limiting functionality.
`;

// Define schema for AI response
const relevantFilesSchema = z.object({
  query: z.string().describe('The original natural language query'),
  relevantFiles: z
    .array(
      z.object({
        filename: z.string().describe('The name of the file'),
        queryRelation: z.string().describe('The relation between the query and the file'),
        relevanceReason: z.string().describe('The reason why the file is relevant to the query'),
        relevance: z
          .enum(['high', 'medium', 'low'])
          .describe('The relevance of the file to the query'),
        needsEditing: z
          .boolean()
          .or(z.literal('maybe'))
          .describe('Whether the file needs to be edited to meet the query'),
      })
    )
    .describe('The files that are relevant to the query'),
});

export type RelevantFile = z.infer<typeof relevantFilesSchema>['relevantFiles'][number];

export async function filterFilesWithQuery(
  modelName: string,
  query: string,
  baseDir: string,
  files: string[]
) {
  debugLog(`Filtering ${files.length} files with query: ${query}`);
  try {
    // Read contents of all files
    const fileContents = await Promise.all(
      files.map(async (file) => ({
        path: path.relative(baseDir, file),
        content: await Bun.file(file).text(),
      }))
    );

    // Batch files into groups of roughly 64,000 tokens
    const TOKEN_LIMIT = 64000;
    const batches: { path: string; content: string }[][] = [];
    let currentBatch: { path: string; content: string }[] = [];
    let currentTokenCount = 0;

    const basePromptTokens = encode(baseQuery).length;

    for (const file of fileContents) {
      const fileTokens = encode(`Path: ${file.path}\nContent:\n${file.content}\n\n---\n\n`).length;
      if (
        currentTokenCount + fileTokens + basePromptTokens > TOKEN_LIMIT &&
        currentBatch.length > 0
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokenCount = 0;
      }
      currentBatch.push(file);
      currentTokenCount += fileTokens;
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    debugLog(`Created ${batches.length} batches for processing`);

    // Process each batch
    const model = await createModel(modelName);
    const filteredFiles: RelevantFile[] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      debugLog(`Processing batch ${i + 1} with ${batch.length} files`);

      // Generate prompt for the batch
      const prompt = `${baseQuery}

Files:
${batch.map((f) => `Path: ${f.path}\nContent:\n${f.content}`).join('\n\n---\n\n')}

Remember, the query to match is: "${query}"
      `;

      // Query the language model
      const { object } = await generateObject({
        model,
        schema: relevantFilesSchema,
        prompt,
        mode: 'json',
      });

      // Collect relevant files from this batch
      object.relevantFiles.forEach((file) => {
        debugLog(JSON.stringify(file, null, 2));
        if (batch.some((b) => b.path === file.filename)) {
          filteredFiles.push({
            ...file,
            filename: path.resolve(baseDir, file.filename),
          });
        } else {
          debugLog(`Model returned file ${file.filename} which was not passed in`);
        }
      });
    }

    debugLog(
      `AI filtered to ${filteredFiles.length} files: ${filteredFiles.map((f) => f.filename).join(', ')}`
    );
    return filteredFiles;
  } catch (e) {
    error(`Error processing query: ${(e as Error).toString()}`);
    process.exit(1);
  }
}
