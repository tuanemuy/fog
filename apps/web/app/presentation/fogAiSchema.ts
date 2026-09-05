import type { AiRequest } from "@repo/core/application/fog/aiTypes";
import { z } from "zod";

const id = z.string().min(1).max(128);
const version = z.number().int().positive();
const title = z.string().max(200);
const body = z.string().max(100000);
const reason = z.string().trim().min(1).max(2000);
const empty = z.object({}).strict();
const target = z.object({ id }).strict();
const key = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/);
const read = <N extends string, T extends z.ZodType>(operation: N, input: T) =>
  z.object({ operation: z.literal(operation), input }).strict();
const write = <N extends string, T extends z.ZodType>(operation: N, input: T) =>
  z
    .object({ operation: z.literal(operation), input, idempotencyKey: key })
    .strict();

export const aiRequestSchema: z.ZodType<AiRequest> = z.discriminatedUnion(
  "operation",
  [
    read("guidance", empty),
    read(
      "memos.recent",
      z
        .object({
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.string().max(4096).optional(),
        })
        .strict()
        .transform(({ limit, cursor }) => ({
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        })),
    ),
    read("memos.get", target),
    read("topics.list", empty),
    read("topics.get", target),
    read("documents.get", target),
    read(
      "search",
      z
        .object({
          query: z.string().max(500),
          topicId: id.optional(),
          cursor: z.string().max(4096).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict()
        .transform(({ query, topicId, cursor, limit }) => ({
          query,
          ...(topicId === undefined ? {} : { topicId }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        })),
    ),
    write("memos.create", z.object({ body }).strict()),
    write(
      "memos.replace",
      z.object({ id, body, expectedVersion: version }).strict(),
    ),
    write(
      "topics.create",
      z.object({ title, description: z.string().max(2000) }).strict(),
    ),
    write(
      "topics.update",
      z
        .object({
          id,
          title,
          description: z.string().max(2000),
          completed: z.boolean(),
          expectedVersion: version,
        })
        .strict(),
    ),
    write(
      "documents.create",
      z
        .object({
          topicId: id,
          title,
          body,
          sourceMemoIds: z.array(id).max(500),
          reason,
        })
        .strict(),
    ),
    write(
      "documents.patch",
      z
        .object({
          id,
          expectedVersion: version,
          find: body.min(1),
          replace: body,
          reason,
          title: title.optional(),
        })
        .strict()
        .transform(({ title, ...input }) => ({
          ...input,
          ...(title === undefined ? {} : { title }),
        })),
    ),
    write(
      "documents.rewrite",
      z
        .object({
          id,
          expectedVersion: version,
          title,
          body,
          reason,
          confirmRewrite: z.literal(true),
        })
        .strict(),
    ),
    write(
      "content.delete",
      z
        .object({
          kind: z.enum(["memo", "document", "topic"]),
          id,
          expectedVersion: version,
        })
        .strict(),
    ),
  ],
);

export const aiAuthorizeQuerySchema = z
  .object({
    response_type: z.literal("code"),
    client_id: z.string().min(1).max(100),
    redirect_uri: z.string().url().max(2048),
    state: z.string().min(16).max(512),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal("S256"),
  })
  .strict();
export const aiTokenSchema = z
  .object({
    grant_type: z.literal("authorization_code"),
    client_id: z.string().min(1).max(100),
    redirect_uri: z.string().url().max(2048),
    code: z.string().min(1).max(256),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  })
  .strict();
export const aiConsentSearchSchema = z
  .object({ request: z.string().min(1).max(256) })
  .strict();
