import { z } from 'zod';

// A historical credential label, never a secret or a claim supplied with an upload.
export const agentIdentitySchema = z.object({
  kind: z.enum(['API_TOKEN', 'OAUTH', 'INTEGRATION']),
  id: z.string().uuid(),
  name: z.string(),
  clientId: z.string().optional(),
});
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

export function agentIdentityOf(value: unknown): AgentIdentity | null {
  const parsed = agentIdentitySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
