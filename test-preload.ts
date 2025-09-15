// Preload run before Bun tests.
// Purpose: ensure tests never make accidental network calls via API keys.
// We explicitly unset Google keys that trigger auto-marking logic in CodexCliExecutor.

const KEYS_TO_UNSET = [
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

for (const key of KEYS_TO_UNSET) {
  if (process.env[key]) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[key as keyof typeof process.env];
  }
}

// If you need to extend this later, add more keys here (e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY).
