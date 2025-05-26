import { log } from '../logging.js';

export function startServer(port: number): void {
  const server = Bun.serve({
    port,
    hostname: '0.0.0.0',
    fetch(request) {
      log(`${request.method} ${request.url}`);
      return new Response('OK');
    },
  });

  log(`HTTP server listening on port ${port}`);
}
