import { command } from '$app/server';
import { z } from 'zod';

import { focusTerminalPane } from '$lib/server/terminal_control.js';

const terminalPaneSchema = z.object({
  terminalPaneId: z.string(),
  terminalType: z.string(),
});

export const activateSessionTerminalPane = command(terminalPaneSchema, async (target) => {
  await focusTerminalPane(target);
});
