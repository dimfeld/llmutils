import * as z from 'zod/v4';

/**
 * The `EndTimSession` tool lets the agent of an interactive top-level session (for example
 * `tim pr fix`, `tim pr fix-ci`, or `tim pr rebase`) end its own session. It has the same
 * effect as the "End session" button, but it waits for the current turn to finish, so the
 * agent's final message is not lost. The Claude and Codex adapters share this contract.
 */
export const END_SESSION_TOOL_NAME = 'EndTimSession';

export const END_SESSION_TOOL_DESCRIPTION =
  'End this session after your current turn. Call it only when your work is complete, everything is pushed, and you do not expect or need an answer from the user. `reason` is a short explanation that is shown to the user. After you call this tool, write your final message and stop; the session closes when your turn ends, and the user cannot reply.';

export const endSessionToolArgumentsSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();

export type EndSessionToolArguments = z.infer<typeof endSessionToolArgumentsSchema>;

/** The result that the tool returns to the agent. */
export const END_SESSION_TOOL_RESULT_TEXT =
  'The session will end after this turn. Finish your final message now and do not wait for an answer.';

/**
 * Trusted, executor-side handler that marks the session to close after the current turn.
 * The handler must not close input or interrupt the turn itself.
 */
export type EndSessionToolHandler = (args: EndSessionToolArguments) => void | Promise<void>;
