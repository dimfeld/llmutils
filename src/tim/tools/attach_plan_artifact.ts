import { buildReferenceArtifactMessage } from '../artifacts/reference.js';
import { addArtifact } from '../artifacts/service.js';
import type { ToolContext, ToolResult } from './context.js';
import type { AttachPlanArtifactArguments } from './schemas.js';

export async function attachPlanArtifactTool(
  args: AttachPlanArtifactArguments,
  context: ToolContext
): Promise<ToolResult<{ uuid: string; filename: string; mimeType: string; size: number }>> {
  const message = args.reference ? buildReferenceArtifactMessage(args.message) : args.message;
  const artifact = await addArtifact({
    planId: args.planId,
    sourcePath: args.filePath,
    message,
    config: context.config,
    repoRoot: context.gitRoot,
  });

  return {
    text: JSON.stringify(
      {
        uuid: artifact.uuid,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        size: artifact.size,
      },
      null,
      2
    ),
    data: {
      uuid: artifact.uuid,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      size: artifact.size,
    },
  };
}
