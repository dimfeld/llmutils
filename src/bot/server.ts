import { log, error } from '../logging.js';
import { handleGitHubWebhook } from './github_handler.js';
import { config } from './config.js';

export function startServer(): void {
  const port = config.BOT_SERVER_PORT;
  log(`Starting HTTP server on port ${port}...`);

  Bun.serve({
    port: port,
    hostname: '0.0.0.0',
    async fetch(request) {
      const url = new URL(request.url);
      log(`Received request: ${request.method} ${url.pathname}`);

      if (url.pathname === '/webhooks/github' && request.method === 'POST') {
        return handleGitHubWebhook(request);
      }

      if (url.pathname === '/health') {
        return new Response('OK', { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    },
    error(err) {
      // Bun's error handler for the server
      error('HTTP server error:', err);
      return new Response('Internal Server Error', { status: 500 });
    },
  });
  log(`HTTP server listening on http://0.0.0.0:${port}`);
}
