import chalk from 'chalk';
import { table, type TableUserConfig } from 'table';
import { promptConfirm } from '../../common/input.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import {
  getProject,
  getProjectById,
  getProjectByUuid,
  listProjects,
  type Project,
} from '../db/project.js';
import { getProjectDeleteSummary } from '../sync/project_delete.js';
import { writeProjectDelete } from '../sync/write_router.js';

interface ProjectListOptions {
  format?: 'table' | 'tsv' | 'json';
  header?: boolean;
}

interface ProjectDeleteOptions {
  yes?: boolean;
}

function getRootCommand(command: any): any {
  let cursor = command;
  while (cursor?.parent) {
    cursor = cursor.parent;
  }
  return cursor;
}

function resolveProject(projectRef: string): Project | null {
  const db = getDatabase();
  const numericId = Number(projectRef);
  if (Number.isInteger(numericId) && String(numericId) === projectRef) {
    return getProjectById(db, numericId);
  }

  return getProjectByUuid(db, projectRef) ?? getProject(db, projectRef);
}

export async function handleProjectListCommand(options: ProjectListOptions = {}): Promise<void> {
  const projects = listProjects(getDatabase());
  const format = options.format ?? 'table';
  if (format === 'json') {
    log(JSON.stringify(projects, null, 2));
    return;
  }

  const rows = projects.map((project) => [
    String(project.id),
    project.repository_id,
    project.remote_label ?? '',
    project.last_git_root ?? '',
    String(project.highest_plan_id),
    project.updated_at,
  ]);
  const data =
    options.header === false
      ? rows
      : [['ID', 'Repository', 'Remote', 'Path', 'Max Plan', 'Updated'], ...rows];

  if (format === 'tsv') {
    log(data.map((row) => row.join('\t')).join('\n'));
    return;
  }

  const config: TableUserConfig = {
    columns: {
      0: { alignment: 'right' },
      4: { alignment: 'right' },
    },
  };
  log(table(data, config).trimEnd());
}

export async function handleProjectDeleteCommand(
  projectRef: string,
  options: ProjectDeleteOptions = {},
  command: any
): Promise<void> {
  const project = resolveProject(projectRef);
  if (!project) {
    throw new Error(`Project not found: ${projectRef}`);
  }

  const db = getDatabase();
  const summary = getProjectDeleteSummary(db, project);
  log(chalk.yellow(`Project ${project.id}: ${project.repository_id}`));
  log(
    `This will delete ${summary.plans} plans, ${summary.tasks} tasks, ${summary.workspaces} workspaces, ${summary.assignments} assignments, ${summary.permissions} permissions, and ${summary.reviews} reviews.`
  );

  const confirmed =
    options.yes === true
      ? true
      : await promptConfirm({
          message: `Delete project ${project.id} (${project.repository_id}) and all related data?`,
          default: false,
        });
  if (!confirmed) {
    log('Cancelled.');
    return;
  }

  const rootCommand = getRootCommand(command);
  const globalOpts = typeof rootCommand?.opts === 'function' ? rootCommand.opts() : {};
  const config = await loadEffectiveConfig(globalOpts.config);
  await writeProjectDelete(db, config, { projectUuid: project.uuid });
  log(chalk.green(`Deleted project ${project.id} (${project.repository_id})`));
}
