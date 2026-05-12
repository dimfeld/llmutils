export function syncUrl(serverUrl: string, path: string): URL {
  const base = serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`;
  return new URL(path, base);
}

export function authHeaders(
  token: string,
  nodeId: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    ...extra,
    authorization: `Bearer ${token}`,
    'x-tim-node-id': nodeId,
  };
}

export async function assertOk(response: Response, url: URL): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Sync server returned ${response.status} ${response.statusText} from ${url.toString()}${body ? `: ${body}` : ''}`
    );
  }
}

export function isConnectionError(err: unknown): boolean {
  if (err instanceof TypeError) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|Unable to connect/i.test(
    message
  );
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
