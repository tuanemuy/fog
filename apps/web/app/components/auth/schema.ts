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

const emailField = z.string().min(1).max(AUTH_FIELD_MAX_LENGTH);
const passwordField = z.string().min(1).max(AUTH_FIELD_MAX_LENGTH);

export const loginSchema = z.object({
  email: emailField,
  password: passwordField,
});

export const signupSchema = z.object({
  email: emailField,
  password: passwordField,
});
