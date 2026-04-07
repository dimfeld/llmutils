import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import {
  createPlansFromIssue as createPlansFromIssueOnServer,
  fetchIssueForImport as fetchIssueForImportOnServer,
  getIssueTrackerStatus as getIssueTrackerStatusOnServer,
  type IssueImportMode,
} from '$lib/server/issue_import.js';
import { getProjectById } from '$tim/db/project.js';

const modeSchema = z.enum(['single', 'separate', 'merged']);

const fetchIssueForImportSchema = z.object({
  identifier: z.string().min(1),
  mode: modeSchema,
  projectId: z.number().int().positive(),
});

export const fetchIssueForImport = query(
  fetchIssueForImportSchema,
  async ({ identifier, mode, projectId }) => {
    const { db } = await getServerContext();
    const project = getProjectById(db, projectId);
    if (!project) {
      error(404, 'Project not found');
    }
    if (!project.last_git_root) {
      error(400, 'Project does not have a git root configured');
    }

    return fetchIssueForImportOnServer(identifier, mode as IssueImportMode, project.last_git_root);
  }
);

const importIssueSchema = z.object({
  projectId: z.number().int().positive(),
  mode: modeSchema,
  issueData: z.any(),
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

    return createPlansFromIssueOnServer(projectId, issueData, mode as IssueImportMode, {
      selectedParentContent,
      selectedChildIndices,
      selectedChildContent: Object.fromEntries(
        Object.entries(selectedChildContent).map(([key, value]) => [Number(key), value])
      ),
    });
  }
);

const checkIssueTrackerStatusSchema = z.object({
  projectId: z.number().int().positive(),
});

export const checkIssueTrackerStatus = query(
  checkIssueTrackerStatusSchema,
  async ({ projectId }) => {
    const { db } = await getServerContext();
    const project = getProjectById(db, projectId);
    if (!project) {
      error(404, 'Project not found');
    }
    if (!project.last_git_root) {
      return {
        available: false,
        trackerType: 'github' as const,
        displayName: 'GitHub',
        supportsHierarchical: false,
      };
    }

    return getIssueTrackerStatusOnServer(project.last_git_root);
  }
);
