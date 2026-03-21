import { Octokit } from 'octokit';
import { debugLog } from '../../logging.js';

export function getOctokit(): Octokit {
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  octokit.hook.wrap('request', async (request, options) => {
    const method = options.method ?? 'GET';
    const url = options.url ?? '';
    debugLog(`GitHub API ${method} ${url}`);

    const response = await request(options);

    const remaining = response.headers['x-ratelimit-remaining'];
    const used = response.headers['x-ratelimit-used'];
    const limit = response.headers['x-ratelimit-limit'];
    const resource = response.headers['x-ratelimit-resource'];

    debugLog(
      `GitHub API ${method} ${url} -> ${response.status}`,
      `(rate limit: ${used}/${limit} used, ${remaining} remaining${resource ? `, resource: ${resource}` : ''})`
    );
    debugLog('GitHub API response data:', response.data);

    return response;
  });

  return octokit;
}
