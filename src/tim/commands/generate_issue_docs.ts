import { parseLinearIssueIdentifier } from '../../common/linear.js';
import type { IssueDocument } from '../../common/issue_tracker/types.js';
import { getIssueTracker } from '../../common/issue_tracker/factory.js';
import { promptCheckbox } from '../../common/input.js';
import { warn } from '../../logging.js';
import type { TimConfig } from '../configSchema.js';
import type { PlanSchema } from '../planSchema.js';
import { writeIssueDocuments } from '../issue_docs.js';

export interface CollectIssueDocumentsOptions {
  plan: PlanSchema;
  baseDir: string;
  config: TimConfig;
  projectId?: number;
  interactive: boolean;
}

export async function collectIssueDocuments(
  options: CollectIssueDocumentsOptions
): Promise<string[] | undefined> {
  const issueIdentifiers = getLinearIssueIdentifiers(options.plan.issue);
  if (issueIdentifiers.length === 0) {
    return undefined;
  }

  // Only Linear-configured projects fetch issue documents. A plan can carry a
  // Linear-looking URL even when the configured tracker is GitHub; in that case
  // skip entirely so behavior is unchanged and we never resolve a GitHub tracker
  // (which could throw and surface a misleading "Linear documents" warning).
  if ((options.config.issueTracker ?? 'github') !== 'linear') {
    return undefined;
  }

  let tracker: Awaited<ReturnType<typeof getIssueTracker>>;
  try {
    tracker = await getIssueTracker(options.config, { projectId: options.projectId });
  } catch (err) {
    warn(`Unable to fetch Linear documents for linked issues: ${formatErrorMessage(err)}`);
    return undefined;
  }

  if (!tracker.fetchIssueDocuments) {
    return undefined;
  }

  let documents: IssueDocument[];
  try {
    documents = dedupeIssueDocuments(
      (
        await Promise.all(
          issueIdentifiers.map((identifier) => tracker.fetchIssueDocuments!(identifier))
        )
      ).flat()
    );
  } catch (err) {
    warn(`Unable to fetch Linear documents for linked issues: ${formatErrorMessage(err)}`);
    return undefined;
  }

  if (documents.length === 0) {
    return undefined;
  }

  const selectedDocuments = options.interactive
    ? await promptForIssueDocuments(documents)
    : documents;

  if (selectedDocuments.length === 0) {
    return undefined;
  }

  const planId = options.plan.id ?? 'unknown';
  const { docPaths } = await writeIssueDocuments(options.baseDir, planId, selectedDocuments);

  return docPaths.length > 0 ? docPaths : undefined;
}

export function hasLinearIssueReferences(plan: PlanSchema): boolean {
  return getLinearIssueIdentifiers(plan.issue).length > 0;
}

function getLinearIssueIdentifiers(issueUrls: string[] | undefined): string[] {
  if (!issueUrls) {
    return [];
  }

  const seenIdentifiers = new Set<string>();
  const identifiers: string[] = [];

  for (const issueUrl of issueUrls) {
    const parsed = parseLinearIssueIdentifier(issueUrl);
    if (!parsed || seenIdentifiers.has(parsed.identifier)) {
      continue;
    }

    seenIdentifiers.add(parsed.identifier);
    identifiers.push(issueUrl);
  }

  return identifiers;
}

function dedupeIssueDocuments(documents: IssueDocument[]): IssueDocument[] {
  const byId = new Map<string, IssueDocument>();

  for (const document of documents) {
    if (!byId.has(document.id)) {
      byId.set(document.id, document);
    }
  }

  return [...byId.values()];
}

async function promptForIssueDocuments(documents: IssueDocument[]): Promise<IssueDocument[]> {
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const selectedIds = await promptCheckbox<string>({
    message: 'Select Linear documents to include in the generate prompt',
    choices: documents.map((document) => ({
      name: formatIssueDocumentChoice(document),
      value: document.id,
      checked: true,
    })),
  });

  return selectedIds.flatMap((id) => {
    const document = documentsById.get(id);
    return document ? [document] : [];
  });
}

function formatIssueDocumentChoice(document: IssueDocument): string {
  const source = document.source === 'issue' ? 'Issue' : 'Project';
  const title = document.title.trim() || document.id;
  return `[${source}] ${title}`;
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
