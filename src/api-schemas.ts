import { z } from 'zod';

export const registrySchema = z.object({
  instance: z.string().min(1),
  pid: z.number().int().positive(),
});

export const inboxSchema = z.object({
  from: z.string().min(1),
  to: z.string().optional(),
  body: z.string(),
  replyTo: z.string().optional(),
  threadId: z.string().optional(),
  status: z.enum(['WAITING_FOR_REPLY', 'FYI_ONLY', 'ACTION_NEEDED', 'RESOLVED']).optional(),
  _meta: z.object({
    type: z.string().optional(),
    originalId: z.string().optional(),
    readAt: z.string().optional(),
    recipients: z.array(z.string()).optional(),
  }).nullable().optional(),
});

export const execSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeout: z.number().int().positive().optional(),
  cwd: z.string().optional(),
});

export const readfileSchema = z.object({
  path: z.string().min(1),
});
