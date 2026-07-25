import { z } from "zod";

/**
 * Transport-boundary schemas for the authentication forms.
 *
 * Shape and DoS only. The length rules that carry meaning — a password
 * of 8–128 characters, an address of at most 320 — belong to
 * `PlainPassword` / `Email` and must surface as `BusinessRuleError`, so
 * they are deliberately absent here. Encoding 128 at this boundary would
 * turn a 129-character password into a transport `validation` failure and
 * the user would be told the wrong thing about their own input
 * (TC-registerWithPassword-006 / 009).
 *
 * The ceiling below exists purely to stop a multi-megabyte body from
 * reaching the key-derivation function, and is set far above any value a
 * domain rule would accept.
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
  email: emailField,
  password: passwordField,
});
