#!/usr/bin/env bun

import { Command } from 'commander';
import { StateStore } from './store.js';
import { WorkflowRecovery } from './recovery.js';
import { join } from 'path';
import { homedir } from 'os';
import { table } from 'table';
import { formatDistanceToNow } from 'date-fns';

const program = new Command();

// Get database path
const getDbPath = (): string => {
  return process.env.RMAPP_STATE_DB || join(homedir(), '.rmapp', 'state.db');
};

program
  .name('rmapp-state')
  .description('CLI for managing rmapp state')
  .version('1.0.0');

program
  .command('list')
  .description('List active workflows')
  .option('-a, --all', 'Show all workflows, not just active ones')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const store = new StateStore(getDbPath());
    await store.initialize();

    try {
      const workflows = await store.listActiveWorkflows();

      if (options.json) {
        console.log(JSON.stringify(workflows, null, 2));
      } else {
        if (workflows.length === 0) {
          console.log('No active workflows');
          return;
        }

        const data = [
          ['ID', 'Type', 'Status', 'Repository', 'Created', 'Updated'],
          ...workflows.map(w => [
            w.id.substring(0, 8),
            w.type,
            w.status,
            `${w.repository.owner}/${w.repository.name}`,
            formatDistanceToNow(w.createdAt, { addSuffix: true }),
            formatDistanceToNow(w.updatedAt, { addSuffix: true }),
          ]),
        ];

        console.log(table(data));
      }
    } finally {
      await store.close();
    }
  });

program
  .command('show <id>')
  .description('Show detailed workflow information')
  .option('--events', 'Include workflow events')
  .action(async (id, options) => {
    const store = new StateStore(getDbPath());
    await store.initialize();

    try {
      const workflow = await store.getWorkflow(id);

      if (!workflow) {
        console.error(`Workflow ${id} not found`);
        process.exit(1);
      }

      console.log('Workflow Details:');
      console.log('================');
      console.log(`ID: ${workflow.id}`);
      console.log(`Type: ${workflow.type}`);
      console.log(`Status: ${workflow.status}`);
      console.log(`Repository: ${workflow.repository.owner}/${workflow.repository.name}`);
      console.log(`Created: ${workflow.createdAt.toISOString()}`);
      console.log(`Updated: ${workflow.updatedAt.toISOString()}`);

      if (workflow.error) {
        console.log(`Error: ${workflow.error}`);
      }

      if (workflow.type === 'issue') {
        const issue = workflow as any;
        console.log(`\nIssue Details:`);
        console.log(`  Number: #${issue.issueNumber}`);
        console.log(`  Title: ${issue.issueTitle}`);
        console.log(`  Branch: ${issue.branchName || 'Not created'}`);
        console.log(`  PR: ${issue.prNumber ? `#${issue.prNumber}` : 'Not created'}`);
        console.log(`\nSteps:`);
        console.log(`  Analyzed: ${issue.steps.analyzed ? '✓' : '✗'}`);
        console.log(`  Plan Generated: ${issue.steps.planGenerated ? '✓' : '✗'}`);
        console.log(`  Implemented: ${issue.steps.implemented ? '✓' : '✗'}`);
        console.log(`  PR Created: ${issue.steps.prCreated ? '✓' : '✗'}`);
      } else if (workflow.type === 'pr_review') {
        const pr = workflow as any;
        console.log(`\nPR Details:`);
        console.log(`  Number: #${pr.prNumber}`);
        console.log(`  Title: ${pr.prTitle}`);
        console.log(`  Comments: ${pr.reviewComments.length}`);
        console.log(`\nSteps:`);
        console.log(`  Comments Parsed: ${pr.steps.commentsParsed ? '✓' : '✗'}`);
        console.log(`  Changes Applied: ${pr.steps.changesApplied ? '✓' : '✗'}`);
        console.log(`  Responded: ${pr.steps.responded ? '✓' : '✗'}`);
      }

      if (options.events) {
        const events = await store.getWorkflowEvents(workflow.id, 20);
        console.log(`\nRecent Events:`);
        for (const event of events) {
          console.log(`  ${event.createdAt.toISOString()} - ${event.type}: ${JSON.stringify(event.payload)}`);
        }
      }
    } finally {
      await store.close();
    }
  });

program
  .command('cleanup')
  .description('Clean up failed and old workflows')
  .option('--dry-run', 'Show what would be cleaned up without actually doing it')
  .option('--days <days>', 'Archive workflows older than this many days', '7')
  .action(async (options) => {
    const store = new StateStore(getDbPath());
    await store.initialize();

    try {
      const recovery = new WorkflowRecovery(store);
      
      // First recover any interrupted workflows
      console.log('Recovering interrupted workflows...');
      await recovery.recoverInterruptedWorkflows({
        dryRun: options.dryRun,
      });

      // Then archive old completed workflows
      const days = parseInt(options.days);
      const olderThan = new Date();
      olderThan.setDate(olderThan.getDate() - days);

      console.log(`\nArchiving completed workflows older than ${days} days...`);
      
      if (!options.dryRun) {
        const archived = await store.archiveCompletedWorkflows(olderThan);
        console.log(`Archived ${archived} workflows`);
      } else {
        console.log('(Dry run - no changes made)');
      }
    } finally {
      await store.close();
    }
  });

program
  .command('export')
  .description('Export state for debugging')
  .option('-o, --output <file>', 'Output file (default: stdout)')
  .action(async (options) => {
    const store = new StateStore(getDbPath());
    await store.initialize();

    try {
      const workflows = await store.listActiveWorkflows();
      const exportData = {
        exportedAt: new Date().toISOString(),
        workflows: await Promise.all(
          workflows.map(async (w) => ({
            ...w,
            events: await store.getWorkflowEvents(w.id, 100),
          }))
        ),
      };

      const json = JSON.stringify(exportData, null, 2);

      if (options.output) {
        await Bun.write(options.output, json);
        console.log(`Exported to ${options.output}`);
      } else {
        console.log(json);
      }
    } finally {
      await store.close();
    }
  });

program
  .command('recover')
  .description('Manually trigger workflow recovery')
  .option('--dry-run', 'Show what would be recovered without actually doing it')
  .action(async (options) => {
    const store = new StateStore(getDbPath());
    await store.initialize();

    try {
      const recovery = new WorkflowRecovery(store);
      
      console.log('Checking recovery status...');
      const status = await recovery.getRecoveryStatus();
      console.log(`Active workflows: ${status.activeWorkflows}`);
      console.log(`Stale workflows: ${status.staleWorkflows}`);
      console.log(`Zombie workspaces: ${status.zombieWorkspaces}`);

      console.log('\nRunning recovery...');
      await recovery.recoverInterruptedWorkflows({
        dryRun: options.dryRun,
      });
    } finally {
      await store.close();
    }
  });

program.parse();