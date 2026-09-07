import { z } from "zod";

// Transport shape only (DoS bounds). The business rules — canonical email,
// 8–128 character password — belong to the value objects.
export const credentialsSchema = z.object({
  email: z.string().max(1024),
  password: z.string().max(1024),
});

export type CredentialsInput = z.infer<typeof credentialsSchema>;
