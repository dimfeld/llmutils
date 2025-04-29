// from github.com/mckaywrigley/o1-xml-parser + modifications
import { DOMParser } from '@xmldom/xmldom';
import { error } from '../../logging.ts';

interface ParsedFileChange {
  file_summary: string;
  file_operation: string;
  file_path: string;
  file_code?: string;
}

export async function parseContentsWithXml(content: string) {
  const results: ParsedFileChange[] = [];
  const regex = /<code_changes>(.*?)<\/code_changes>/gms;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const xmlContent = match[1];
    const parsed = await parseXmlString(xmlContent);
    if (parsed) {
      results.push(...parsed);
    }
  }

  return results;
}

export async function parseXmlString(xmlString: string): Promise<ParsedFileChange[] | null> {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');

    const changedFilesNodes = doc.getElementsByTagName('changed_files');
    if (!changedFilesNodes?.length) {
      return null;
    }

    const changes: ParsedFileChange[] = [];
    for (let changedFileNode of changedFilesNodes) {
      const fileNodes = changedFileNode.getElementsByTagName('file');

      for (let i = 0; i < fileNodes.length; i++) {
        const fileNode = fileNodes[i];

        const fileSummaryNode = fileNode.getElementsByTagName('file_summary')[0];
        const fileOperationNode = fileNode.getElementsByTagName('file_operation')[0];
        const filePathNode = fileNode.getElementsByTagName('file_path')[0];
        const fileCodeNode = fileNode.getElementsByTagName('file_code')[0];

        if (!fileOperationNode || !filePathNode) {
          continue;
        }

        const file_summary = fileSummaryNode?.textContent?.trim() ?? '';
        const file_operation = fileOperationNode.textContent?.trim() ?? '';
        const file_path = filePathNode.textContent?.trim() ?? '';

        let file_code: string | undefined = undefined;
        if (fileCodeNode && fileCodeNode.firstChild) {
          file_code = fileCodeNode.textContent?.trim() ?? '';
        }

        changes.push({
          file_summary,
          file_operation,
          file_path,
          file_code,
        });
      }
    }

    return changes;
  } catch (e: unknown) {
    error('Error parsing XML:', error);
    return null;
  }
}
