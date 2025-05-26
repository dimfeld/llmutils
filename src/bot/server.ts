import { log } from '../logging.js';
import { handleGitHubWebhook } from './github_handler.js';

export function startServer(port: number): void {
  const server = Bun.serve({
    port,
    hostname: '0.0.0.0',
    async fetch(request) {
      log(`${request.method} ${request.url}`);

      const url = new URL(request.url);

      if (url.pathname === '/github/webhook' && request.method === 'POST') {
        return await handleGitHubWebhook(request);
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  log(`HTTP server listening on port ${port}`);
}
