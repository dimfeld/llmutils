export interface PlanArtifact {
  uuid: string;
  planUuid: string;
  projectUuid: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  message: string | null;
  storagePath: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface PlanArtifactInsert {
  uuid: string;
  planUuid: string;
  projectUuid: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  message?: string | null;
  storagePath: string;
  deletedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  revision?: number;
}
