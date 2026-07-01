import { buildReferenceArtifactMessage } from '$tim/artifacts/reference.js';

export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export interface BuildUploadFormDataInput {
  planUuid: string;
  projectId?: string | number;
  file: File;
  message?: string;
  reference?: boolean;
}

export function buildUploadFormData(input: BuildUploadFormDataInput): FormData {
  const form = new FormData();
  form.set('planUuid', input.planUuid);
  if (input.projectId !== undefined && input.projectId !== null && input.projectId !== 'all') {
    form.set('projectId', String(input.projectId));
  }
  form.set('file', input.file);
  // Reference artifacts carry the `tim-reference:` marker prefix (mirroring `tim-proof:`),
  // with the user message becoming the optional description.
  const rawMessage = input.reference ? buildReferenceArtifactMessage(input.message) : input.message;
  const trimmed = rawMessage?.trim();
  if (trimmed) form.set('message', trimmed);
  return form;
}

export interface UploadSizeCheckResult {
  ok: boolean;
  error?: string;
}

export function checkUploadSize(size: number): UploadSizeCheckResult {
  if (size > MAX_ARTIFACT_BYTES) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    return { ok: false, error: `File is too large (${mb} MB). Maximum is 25 MB.` };
  }
  return { ok: true };
}

export interface UploadArtifactInput {
  planUuid: string;
  projectId?: string | number;
  file: File;
  message?: string;
  reference?: boolean;
  fetchImpl?: typeof fetch;
}

export interface UploadArtifactResult {
  ok: boolean;
  error?: string;
  status?: number;
}

export async function uploadArtifact(input: UploadArtifactInput): Promise<UploadArtifactResult> {
  const sizeCheck = checkUploadSize(input.file.size);
  if (!sizeCheck.ok) {
    return { ok: false, error: sizeCheck.error };
  }

  const form = buildUploadFormData(input);
  const doFetch = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch('/api/artifacts', { method: 'POST', body: form });
  } catch (err) {
    return { ok: false, error: `Upload failed: ${(err as Error).message}` };
  }

  if (!response.ok) {
    return { ok: false, error: await parseUploadError(response), status: response.status };
  }
  return { ok: true, status: response.status };
}

export function buildShowDeletedUrl(currentUrl: URL, show: boolean): string {
  const url = new URL(currentUrl);
  if (show) {
    url.searchParams.set('includeDeletedArtifacts', '1');
  } else {
    url.searchParams.delete('includeDeletedArtifacts');
  }
  return url.pathname + url.search;
}

export async function parseUploadError(response: Response): Promise<string> {
  if (response.status === 413) {
    return 'File is too large. Maximum is 25 MB.';
  }
  let detail = `Upload failed (${response.status})`;
  try {
    const body = await response.json();
    if (body && typeof body === 'object') {
      if (typeof body.error === 'string') return body.error;
      if (typeof body.message === 'string') return body.message;
    }
  } catch {
    // ignore
  }
  return detail;
}
