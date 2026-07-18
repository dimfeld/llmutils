export type UploadFileBody = BodyInit;

export interface UploadFileOptions {
  /**
   * Origin-only base URL of the media host (e.g. `https://media.example.com`). The media host
   * routes from root and returns root-absolute signed URLs, so a path prefix on `baseUrl` is not
   * supported: the upload PUT would include the prefix but the returned signed URL would not.
   */
  baseUrl: string;
  apiKey: string;
  relativePath: string;
  body: UploadFileBody;
  contentType?: string;
}

export interface UploadFileResult {
  url: string;
  size: number;
}

interface UploadResponsePayload {
  path: string;
  size: number;
  url: string;
}

function encodeMediaPath(relativePath: string): string {
  return relativePath.split('/').map(encodeURIComponent).join('/');
}

function buildUploadUrl(baseUrl: string, relativePath: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(encodeMediaPath(relativePath), normalizedBaseUrl).toString();
}

function parseUploadResponse(payload: unknown): UploadResponsePayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Media host upload returned an invalid JSON payload');
  }

  const response = payload as Partial<UploadResponsePayload>;
  if (
    typeof response.path !== 'string' ||
    typeof response.url !== 'string' ||
    typeof response.size !== 'number' ||
    !Number.isFinite(response.size)
  ) {
    throw new Error('Media host upload returned an invalid response shape');
  }

  return {
    path: response.path,
    size: response.size,
    url: response.url,
  };
}

export async function uploadFile(options: UploadFileOptions): Promise<UploadFileResult> {
  const headers = new Headers({
    authorization: `Bearer ${options.apiKey}`,
  });
  if (options.contentType) {
    headers.set('content-type', options.contentType);
  }

  const response = await fetch(buildUploadUrl(options.baseUrl, options.relativePath), {
    method: 'PUT',
    headers,
    body: options.body,
  });

  if (response.status !== 201) {
    throw new Error(
      `Media host upload failed with HTTP ${response.status}: ${await response.text()}`
    );
  }

  const payload = parseUploadResponse(await response.json());
  return {
    url: new URL(payload.url, options.baseUrl).toString(),
    size: payload.size,
  };
}

export function artifactMediaPath(
  planUuid: string,
  artifactUuid: string,
  filename: string
): string {
  const safeFilename = filename.replaceAll(String.fromCharCode(0), '').replace(/[\\/]+/g, '_');
  return `tim/plans/${planUuid}/${artifactUuid}/${safeFilename}`;
}
