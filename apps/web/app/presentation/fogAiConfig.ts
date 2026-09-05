import { z } from "zod";

const redirectUri = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }, "Redirect URI must use HTTPS or HTTP loopback, without credentials or a fragment");

const clients = z
  .array(
    z
      .object({
        id: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-zA-Z0-9._-]+$/),
        name: z.string().trim().min(1).max(100),
        redirectUris: z.array(redirectUri).min(1).max(10),
      })
      .strict(),
  )
  .max(100)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Client IDs must be unique",
  );

export function readFogAiClients(value: string | undefined) {
  return clients.parse(value ? JSON.parse(value) : []);
}
