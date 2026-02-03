import { z } from 'zod';
import { createModel } from '../common/model_factory.js';
import { debugLog } from '../logging.js';
import { generateObject } from 'ai';

/**
 * Generates grep terms from a natural language query using a language model.
 * @param modelName The model identifier (e.g., "google/gemini-2.5-flash").
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
  const model = await createModel(modelName);
  const prompt = `
# Code Search Query Processor

You are a specialized assistant designed to convert natural language queries about codebases into effective grep search terms. Your goal is to help developers quickly find relevant files and code snippets based on their information needs.

## Input Format
The user will provide a natural language query describing what they're looking for in a codebase. The query may reference:
- Functionality (what the code does)
- Components or modules
- File types or languages
- Architectural patterns
- Implementation details
- Variable names, function names, or other identifiers

## Output Format
For each query, provide a JSON object containing a "grepTerms" array of strings, in order of likely relevance.

## Guidelines for Generating Search Terms:

### General Strategy
- Begin with highly specific identifiers that would uniquely identify relevant code
- Include multiple search term variations to account for different naming conventions
- Progress from specific to general terms
- Include regexp patterns when appropriate for flexibility
- Consider different ways the concept might be implemented or named

### Naming Conventions
Generate search terms that account for common coding conventions:
- camelCase: \`readUserData\`
- snake_case: \`read_user_data\`
- kebab-case: \`read-user-data\`
- PascalCase: \`ReadUserData\`
- Acronyms: \`readUD\`, \`RUD\`

### Code Patterns
Generate terms for common code patterns related to the query:
- Definitions: \`class\`, \`def\`, \`function\`, \`interface\`, etc.
- Import statements: \`import\`, \`require\`, \`from\`, etc.
- Comments: \`TODO\`, \`FIXME\`, \`NOTE\`, etc.

### Term Structure
- Prioritize unique identifiers likely to have low false positives
- Include partial words with wildcards when appropriate: \`auth.*service\`
- Use regex character classes when helpful: \`[aA]uth[sS]ervice\`
- For multi-word concepts, provide both full and partial matches

## Examples

**Query**: "Where is user authentication handled in this app?"

\`\`\`
{
  "grepTerms": [
    "authenticateUser|userAuthentication|authenticate",
    "login|signIn|logIn",
    "auth[^a-z]|[aA]uth",
    "passport|oauth|jwt|token",
    "user.*password|credential",
  ]
}
\`\`\`

**Query**: "Find code that handles database connection pooling"

\`\`\`
{
  "grepTerms": [
    "connectionPool|ConnPool|connection_pool",
    "createPool|newPool|initPool|setupPool",
    "pool\\.get|pool\\.acquire|pool\\.release",
    "maxConnections|poolSize|min_pool_size|max_pool_size",
    "database.*pool|db.*pool|pool.*connect",
  ]
}
\`\`\`

**Query**: "Where are API rate limits implemented?"

\`\`\`
{
  "grepTerms": [
    "rateLimit|rate_limit|RateLimit",
    "throttle|Throttle|throttling",
    "requestsPerMinute|requests_per_minute|requestsPerSecond",
    "limiter\\.limit|rateLimiter|rate_limiter",
    "429|TOO_MANY_REQUESTS",
  ]
}
\`\`\`

## Final Tips

- For each query, consider different abstraction levels (interface vs. implementation)
- Include both generic programming patterns and domain-specific terms
- When the query references specific libraries or frameworks, include framework-specific patterns
- Generate terms that balance precision (fewer false positives) and recall (fewer false negatives)
- Keep search terms reasonably short to avoid excessive specificity

Query: "${query}"

  `;
  const { object } = await generateObject({
    model,
    schema,
    prompt,
    mode: 'json',
  });
  debugLog(`Generated grep terms: ${object.grepTerms.join(', ')}`);
  const grepTerms = new Set(object.grepTerms);
  return Array.from(grepTerms);
}
