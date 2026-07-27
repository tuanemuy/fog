import { z } from "zod";

/**
 * Transport-boundary schemas for the authentication forms — shape and DoS
 * only. The meaningful length rules (password 8–128, address ≤320) belong
 * to `PlainPassword` / `Email` and must surface as `BusinessRuleError`;
 * encoding them here would misreport a 129-character password as a
 * transport `validation` failure. The ceiling below only keeps a
 * multi-megabyte body away from the key-derivation function.
 */
export const AUTH_FIELD_MAX_LENGTH = 1024;

// Messages are Japanese because they reach the field they belong to
// verbatim (`toAuthErrorDisplay`); zod's English defaults would surface as-is.
const emailField = z
  .string({ message: "メールアドレスを入力してください" })
  .min(1, { message: "メールアドレスを入力してください" })
  .max(AUTH_FIELD_MAX_LENGTH, { message: "メールアドレスが長すぎます" });

const passwordField = z
  .string({ message: "パスワードを入力してください" })
  .min(1, { message: "パスワードを入力してください" })
  .max(AUTH_FIELD_MAX_LENGTH, { message: "パスワードが長すぎます" });

export const loginSchema = z.object({
  email: emailField,
  password: passwordField,
});

export const signupSchema = z.object({
  operationId: z.uuid(),
  email: emailField,
  password: passwordField,
});
