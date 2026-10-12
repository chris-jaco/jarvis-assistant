import { z } from 'zod';

// A gesture in the packaged extension popup identifies the conversation the
// user selected. It is not a claim that the site's displayed identity is true.
export const manualSelectionSchema = z.object({
  selectionId: z.string().uuid(),
  scopeId: z.string().uuid(),
  tabId: z.string().uuid(),
  documentId: z.string().uuid(),
  epoch: z.string().uuid(),
  expiresAt: z.number().int().positive(),
  assurance: z.literal('USER_SELECTED')
}).strict();
export type ManualSelection = z.infer<typeof manualSelectionSchema>;
