import { z } from 'zod';
import { createModel } from '../common/model_factory.js';
import { debugLog } from '../logging.js';
import { expandPattern } from '../common/file_finder.js';
import { generateObject } from 'ai';

/**
 * Generates grep terms from a natural language query using a language model.
 * @param modelName The model identifier (e.g., "google/gemini-2.0-flash").
 * @param query The natural language query to convert into grep terms.
 * @returns A promise that resolves to an array of grep patterns.
 */
export async function generateGrepTermsFromQuery(
  modelName: string,
  query: string
): Promise<string[]> {
  debugLog(`Generating grep terms for query: ${query}`);
  const schema = z.object({
    grepTerms: z.array(z.string()),
  });
  const model = createModel(modelName);
  const prompt = `
Given the following natural language query, generate a list of grep patterns that would help find relevant files.
The patterns should be suitable for use with ripgrep (e.g., exact phrases, keywords, or regex patterns).
Focus on specific terms or phrases that capture the intent of the query.

Query: "${query}"

Respond with a JSON object containing a "grepTerms" array of strings.
  `;
  const { object } = await generateObject({
    model,
    schema,
    prompt,
    mode: 'json',
  });
  debugLog(`Generated grep terms: ${object.grepTerms.join(', ')}`);
  const grepTerms = new Set(object.grepTerms.flatMap(expandPattern));
  return Array.from(grepTerms);
}
