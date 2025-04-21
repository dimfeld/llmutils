import { generateObject } from 'ai';
import { encode } from 'gpt-tokenizer';
import { z } from 'zod';
import { createModel } from '../common/model_factory.ts';
import { debugLog } from '../logging.ts';
import * as path from 'node:path';

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

    // Define schema for AI response
    const schema = z.object({
      relevantFiles: z.array(z.string()),
    });

    // Batch files into groups of roughly 64,000 tokens
    const TOKEN_LIMIT = 64000;
    const batches: { path: string; content: string }[][] = [];
    let currentBatch: { path: string; content: string }[] = [];
    let currentTokenCount = 0;

    const basePromptTokens = encode(`
Given the following files and their contents, select the files that are relevant to the query: "${query}".
Return a list of file paths that match the query.

Files:
`).length;

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
    const model = createModel(modelName);
    const allRelevantFiles = new Set<string>();

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      debugLog(`Processing batch ${i + 1} with ${batch.length} files`);

      // Generate prompt for the batch
      const prompt = `
Given the following files and their contents, select the files that are relevant to the query: "${query}".
Return a list of file paths that match the query.

Files:
${batch.map((f) => `Path: ${f.path}\nContent:\n${f.content}`).join('\n\n---\n\n')}

Respond with a JSON object containing a "relevantFiles" array of file paths.
Remember, the query to match is: "${query}"
      `;

      // Query the language model
      const { object } = await generateObject({
        model,
        schema,
        prompt,
        mode: 'json',
      });

      // Collect relevant files from this batch
      object.relevantFiles.forEach((relPath) => allRelevantFiles.add(relPath));
    }

    // Filter files based on AI response
    let filteredFiles = Array.from(allRelevantFiles)
      .map((relPath) => path.resolve(baseDir, relPath))
      .filter((file) => files.includes(file));

    debugLog(`AI filtered to ${filteredFiles.length} files: ${filteredFiles.join(', ')}`);
    return filteredFiles;
  } catch (error) {
    console.error(`Error processing query: ${(error as Error).toString()}`);
    process.exit(1);
  }
}
