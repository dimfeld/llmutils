import { command, query } from '$app/server';
import { error, redirect } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import {
  createPlansFromIssue as createPlansFromIssueOnServer,
  fetchIssueForImport as fetchIssueForImportOnServer,
  getIssueTrackerStatus as getIssueTrackerStatusOnServer,
  type IssueImportMode,
} from '$lib/server/issue_import.js';
import { getProjectById } from '$tim/db/project.js';
import { getPreferredProjectGitRoot } from '$tim/workspace/workspace_info';

const modeSchema = z.enum(['single', 'separate', 'merged']);
const issueWithCommentsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      issue: z
        .object({
          title: z.string(),
          htmlUrl: z.string(),
          number: z.union([z.number(), z.string()]),
          body: z.string().nullish(),
        })
        .passthrough(),
      comments: z.array(
        z
          .object({
            body: z.string().nullish(),
          })
          .passthrough()
      ),
      children: z.array(issueWithCommentsSchema).optional(),
    })
    .passthrough()
);

const fetchIssueForImportSchema = z.object({
  identifier: z.string().min(1),
  mode: modeSchema,
  projectId: z.number().int().positive(),
});

export const fetchIssueForImport = command(
  fetchIssueForImportSchema,
  async ({ identifier, mode, projectId }) => {
    const { db } = await getServerContext();
    const project = getProjectById(db, projectId);
    if (!project) {
      error(404, 'Project not found');
    }

    const gitRoot = getPreferredProjectGitRoot(db, projectId);
    if (!gitRoot) {
      error(404, 'Project not found');
    }
    return fetchIssueForImportOnServer(identifier, mode as IssueImportMode, gitRoot, projectId);
  }
);

const importIssueSchema = z.object({
  projectId: z.number().int().positive(),
  mode: modeSchema,
  issueData: issueWithCommentsSchema,
  selectedParentContent: z.array(z.number().int().nonnegative()),
  selectedChildIndices: z.array(z.number().int().nonnegative()),
  selectedChildContent: z.record(z.string(), z.array(z.number().int().nonnegative())),
});

export const importIssue = command(
  importIssueSchema,
  async ({
    projectId,
    mode,
    issueData,
    selectedParentContent,
    selectedChildIndices,
    selectedChildContent,
  }) => {
    const { db } = await getServerContext();
    const project = getProjectById(db, projectId);
    if (!project) {
      error(404, 'Project not found');
    }

    const result = await createPlansFromIssueOnServer(
      projectId,
      issueData,
      mode as IssueImportMode,
      {
        selectedParentContent,
        selectedChildIndices,
        selectedChildContent: Object.fromEntries(
          Object.entries(selectedChildContent).map(([key, value]) => [Number(key), value])
        ),
      }
    );

    redirect(303, `/projects/${projectId}/plans/${result.planUuid}`);
  }
);

const checkIssueTrackerStatusSchema = z.object({
  projectId: z.number().int().positive(),
});

export const checkIssueTrackerStatus = query(
  checkIssueTrackerStatusSchema,
  async ({ projectId }) => {
    const { db } = await getServerContext();
    return getIssueTrackerStatusOnServer(db, projectId);
  }
);
