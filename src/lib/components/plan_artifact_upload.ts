export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export interface BuildUploadFormDataInput {
  planUuid: string;
  projectId?: string | number;
  file: File;
  message?: string;
}

export function buildUploadFormData(input: BuildUploadFormDataInput): FormData {
  const form = new FormData();
  form.set('planUuid', input.planUuid);
  if (input.projectId !== undefined && input.projectId !== null && input.projectId !== 'all') {
    form.set('projectId', String(input.projectId));
  }
  form.set('file', input.file);
  const trimmed = input.message?.trim();
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
