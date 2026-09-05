import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import type {
  GoogleIdentityPort,
  ResetMailer,
} from "@repo/core/application/fog/accountPorts";
import { RESET_REQUEST_MESSAGE } from "@repo/core/application/fog/recoveryServices";
import { dispatchResetEmails } from "@repo/core/application/fog/resetEmailDispatcher";
import { createFogServices } from "@repo/core/application/fog/services";
import type {
  Actor,
  AuthResult,
  FogServices,
  GoogleAuthResult,
  HumanActor,
} from "@repo/core/application/fog/types";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { nodeSecretCrypto } from "../crypto";
import { migrateFog } from "../schema";
import { LibsqlFogUnitOfWork } from "../unitOfWork";

let dir: string;
let client: Client;
let services: FogServices;
let now: Date;
let a: AuthResult;
let b: AuthResult;
const clock = { now: () => now };
const browserToken = "browser".repeat(8);
const originalPassword = "long-enough-password";
const newPassword = "a-new-long-password";
const identity = {
  subject: "google-subject-1",
  email: "google@example.com",
  emailVerified: true as const,
};
let exchange: ReturnType<typeof vi.fn<GoogleIdentityPort["exchange"]>>;
let authorizeUrl: ReturnType<
  typeof vi.fn<GoogleIdentityPort["authorizationUrl"]>
>;
const google = (): GoogleIdentityPort => ({
  authorizationUrl: authorizeUrl,
  exchange,
});
const unitOfWork = () => new LibsqlFogUnitOfWork(client);
const makeServices = () =>
  createFogServices({
    unitOfWork: unitOfWork(),
    crypto: nodeSecretCrypto,
    clock,
    ids: UuidV7Generator,
    googleIdentity: google(),
    appUrl: "http://localhost:3000",
    aiClients: [
      {
        id: "test-ai",
        name: "AI",
        redirectUris: ["http://127.0.0.1/callback"],
      },
    ],
  });
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fog-account-"));
  client = createClient({ url: `file:${dir}/app.db` });
  await client.execute("PRAGMA journal_mode=WAL");
  await client.execute("PRAGMA foreign_keys=ON");
  await client.execute("PRAGMA busy_timeout=5000");
  await migrateFog(client);
  now = new Date("2026-09-05T14:00:00.000Z");
  authorizeUrl = vi.fn(
    (input) =>
      `https://accounts.example/authorize?${new URLSearchParams(input)}`,
  );
  exchange = vi.fn(async () => identity);
  services = await makeServices();
  a = await services.register({
    email: "a@example.com",
    password: originalPassword,
  });
  b = await services.register({
    email: "b@example.com",
    password: originalPassword,
  });
});
afterEach(async () => {
  client.close();
  await rm(dir, { recursive: true, force: true });
});
async function begin(actor: HumanActor | null = null, returnTo = "/timeline") {
  const result = await services.beginGoogleAuth(actor, {
    browserToken,
    returnTo,
  });
  const state = new URL(result.url).searchParams.get("state");
  if (!state) throw new Error("no state");
  return state;
}
const complete = (state: string, actor: HumanActor | null = null) =>
  services.completeGoogleAuth(actor, {
    browserToken,
    state,
    code: "provider-code",
  });
const signedIn = (result: GoogleAuthResult) => {
  if (result.kind !== "signedIn") throw new Error("not signed in");
  return result.auth;
};
const googleUser = async () => signedIn(await complete(await begin()));
const count = async (table: string) =>
  Number((await client.execute(`SELECT count(*) n FROM ${table}`)).rows[0]?.n);
const mailer = () => ({
  sendPasswordReset: vi.fn<ResetMailer["sendPasswordReset"]>(async () => {}),
});
const dispatch = (mailer?: ResetMailer) =>
  dispatchResetEmails({
    unitOfWork: unitOfWork(),
    clock,
    ids: UuidV7Generator,
    ...(mailer ? { mailer } : {}),
  });
async function resetToken(email = a.user.email) {
  const sender = mailer();
  await services.requestPasswordReset({ email });
  await dispatch(sender);
  const url = sender.sendPasswordReset.mock.calls.at(-1)?.[0].resetUrl;
  if (!url) throw new Error("missing email");
  const token = new URL(url).searchParams.get("token");
  if (!token) throw new Error("missing token");
  return token;
}
async function connectAi(actor = a.user) {
  const verifier = "v".repeat(43);
  const request = await services.beginAiAuthorization({
    clientId: "test-ai",
    redirectUri: "http://127.0.0.1/callback",
    state: "state",
    codeChallenge: nodeSecretCrypto.pkceChallenge(verifier),
    codeChallengeMethod: "S256",
  });
  await services.getAiAuthorization(actor, request.requestToken);
  const consent = await services.decideAiAuthorization(actor, {
    requestToken: request.requestToken,
    allow: true,
  });
  const code = new URL(consent.redirectUri).searchParams.get("code");
  if (!code) throw new Error("code");
  return (
    await services.exchangeAiCode({
      clientId: "test-ai",
      redirectUri: "http://127.0.0.1/callback",
      code,
      codeVerifier: verifier,
    })
  ).accessToken;
}

test("Google initial sign-in atomically creates an SSO-only user and subsequent subject login preserves primary email", async () => {
  const state = await begin();
  const auth = signedIn(await complete(state));
  expect(auth.user.email).toBe(identity.email);
  expect(await services.authenticate(auth.token)).toEqual(auth.user);
  expect(await services.credentials(auth.user)).toMatchObject({
    hasPassword: false,
    google: [{ email: identity.email, removable: false }],
  });
  expect(await count("fog_users")).toBe(3);
  expect(await count("fog_password_credentials")).toBe(2);
  const params = authorizeUrl.mock.calls[0]?.[0];
  expect(params?.nonce).toBeTruthy();
  const called = exchange.mock.calls[0]?.[0];
  expect(called?.nonce).toBe(params?.nonce);
  expect(nodeSecretCrypto.pkceChallenge(called?.codeVerifier ?? "")).toBe(
    params?.codeChallenge,
  );
  exchange.mockResolvedValue({ ...identity, email: "changed@example.com" });
  const second = signedIn(await complete(await begin()));
  expect(second.user).toEqual(auth.user);
  expect(await count("fog_users")).toBe(3);
  await expect(complete(state)).rejects.toMatchObject({
    code: "INVALID_GOOGLE_AUTH",
  });
  const stored = JSON.stringify(
    (await client.execute("SELECT * FROM fog_google_requests")).rows,
  );
  expect(stored).not.toContain(state);
  expect(stored).not.toContain(browserToken);
  expect(stored).not.toContain(called?.codeVerifier ?? "never");
});

test("SSO does not auto-link an existing primary email, but signed-in explicit linking retains the human session", async () => {
  exchange.mockResolvedValue({ ...identity, email: a.user.email });
  await expect(complete(await begin())).rejects.toMatchObject({
    code: "EMAIL_EXISTS",
  });
  expect(await count("fog_google_credentials")).toBe(0);
  expect(await count("fog_users")).toBe(2);
  expect(await complete(await begin(a.user, "/settings"), a.user)).toEqual({
    kind: "linked",
    returnTo: "/settings",
  });
  expect(await services.authenticate(a.token)).toEqual(a.user);
  const credentials = await services.credentials(a.user);
  expect(credentials).toMatchObject({
    hasPassword: true,
    google: [{ email: a.user.email, removable: true }],
  });
  await expect(complete(await begin(a.user), a.user)).rejects.toMatchObject({
    code: "GOOGLE_CREDENTIAL_EXISTS",
  });
  await expect(complete(await begin(b.user), b.user)).rejects.toMatchObject({
    code: "GOOGLE_CREDENTIAL_EXISTS",
  });
});

test("Google state binds browser and login/link actor, rejects expiry and unsafe return paths", async () => {
  const state = await begin(a.user);
  await expect(
    services.completeGoogleAuth(a.user, {
      browserToken: "different".repeat(8),
      state,
      code: "code",
    }),
  ).rejects.toMatchObject({ code: "INVALID_GOOGLE_AUTH" });
  await expect(complete(state, b.user)).rejects.toMatchObject({
    code: "INVALID_GOOGLE_AUTH",
  });
  await expect(complete(state)).rejects.toMatchObject({
    code: "INVALID_GOOGLE_AUTH",
  });
  const login = await begin();
  await expect(complete(login, a.user)).rejects.toMatchObject({
    code: "INVALID_GOOGLE_AUTH",
  });
  now = new Date(now.getTime() + 600_000);
  await expect(complete(state, a.user)).rejects.toMatchObject({
    code: "INVALID_GOOGLE_AUTH",
  });
  expect(exchange).not.toHaveBeenCalled();
  for (const returnTo of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/bad\npath",
  ])
    await expect(begin(null, returnTo)).rejects.toMatchObject({
      code: "INVALID_RETURN_TO",
    });
});

test("provider cancellation consumes state without exchange or account creation; other provider errors remain explicit failures", async () => {
  const state = await begin(null, "/timeline?memo=test");
  expect(
    await services.completeGoogleAuth(null, {
      browserToken,
      state,
      error: "access_denied",
    }),
  ).toEqual({ kind: "cancelled", returnTo: "/timeline?memo=test" });
  await expect(complete(state)).rejects.toMatchObject({
    code: "INVALID_GOOGLE_AUTH",
  });
  const failed = await begin();
  await expect(
    services.completeGoogleAuth(null, {
      browserToken,
      state: failed,
      error: "server_error",
    }),
  ).rejects.toMatchObject({ code: "GOOGLE_AUTH_FAILED" });
  expect(exchange).not.toHaveBeenCalled();
  expect(await count("fog_users")).toBe(2);
});

test("provider exchange runs outside the UoW and state is revalidated after exchange", async () => {
  exchange.mockImplementation(async () => {
    await services.createMemo(a.user, { body: "exchange中の独立操作" });
    now = new Date(now.getTime() + 600_000);
    return identity;
  });
  await expect(complete(await begin())).rejects.toMatchObject({
    code: "INVALID_GOOGLE_AUTH",
  });
  expect(await count("fog_users")).toBe(2);
  expect(await count("fog_google_credentials")).toBe(0);
  expect(await services.listMemos(a.user)).toHaveLength(1);
});

test("SSO subject/email creation races preserve one account and never auto-link distinct subjects", async () => {
  const first = await begin();
  const second = await begin();
  const results = await Promise.all([complete(first), complete(second)]);
  expect(
    new Set(results.map((result) => signedIn(result).user.userId)).size,
  ).toBe(1);
  expect(await count("fog_google_credentials")).toBe(1);
  exchange.mockResolvedValue({ ...identity, subject: "different-subject" });
  await expect(complete(await begin())).rejects.toMatchObject({
    code: "EMAIL_EXISTS",
  });
  expect(await count("fog_users")).toBe(3);
});

test("duplicate callbacks yield one session and a failed credential insert rolls new user back", async () => {
  const state = await begin();
  const before = await count("fog_sessions");
  const results = await Promise.allSettled([complete(state), complete(state)]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(await count("fog_sessions")).toBe(before + 1);
  exchange.mockResolvedValue({
    ...identity,
    subject: "new-subject",
    email: "new@example.com",
  });
  await client.execute(
    "CREATE TRIGGER fail_google_insert BEFORE INSERT ON fog_google_credentials BEGIN SELECT RAISE(ABORT,'fail'); END",
  );
  await expect(complete(await begin())).rejects.toMatchObject({
    code: "STORAGE_CONFLICT",
  });
  expect(await count("fog_users")).toBe(3);
});

test("credential removal enforces owner and final-method guards, including concurrent unlink attempts", async () => {
  const auth = await googleUser();
  const only = (await services.credentials(auth.user)).google[0];
  if (!only) throw new Error("credential");
  await expect(
    services.unlinkGoogleCredential(auth.user, { id: only.id }),
  ).rejects.toMatchObject({ code: "LAST_LOGIN_METHOD" });
  await expect(
    services.unlinkGoogleCredential(a.user, { id: only.id }),
  ).rejects.toMatchObject({ code: "GOOGLE_CREDENTIAL_NOT_FOUND" });
  exchange.mockResolvedValue({
    ...identity,
    subject: "second-google",
    email: "second@example.com",
  });
  await complete(await begin(auth.user), auth.user);
  const two = (await services.credentials(auth.user)).google;
  expect(two.every((credential) => credential.removable)).toBe(true);
  const results = await Promise.allSettled(
    two.map((credential) =>
      services.unlinkGoogleCredential(auth.user, { id: credential.id }),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect((await services.credentials(auth.user)).google).toHaveLength(1);
  exchange.mockResolvedValue({ ...identity, subject: "third-google" });
  await complete(await begin(a.user), a.user);
  const linked = (await services.credentials(a.user)).google[0];
  if (!linked) throw new Error("link");
  await services.unlinkGoogleCredential(a.user, { id: linked.id });
  expect(await services.credentials(a.user)).toEqual({
    hasPassword: true,
    google: [],
  });
});

test("reset requests return exactly the same body for password, unknown, SSO-only and throttled users", async () => {
  const auth = await googleUser();
  const result = { message: RESET_REQUEST_MESSAGE };
  expect(
    await services.requestPasswordReset({ email: "unknown@example.com" }),
  ).toEqual(result);
  expect(
    await services.requestPasswordReset({ email: auth.user.email }),
  ).toEqual(result);
  for (let i = 0; i < 5; i++)
    expect(
      await services.requestPasswordReset({ email: a.user.email }),
    ).toEqual(result);
  expect(await count("fog_password_resets")).toBe(3);
  expect(await count("fog_reset_emails")).toBe(3);
  now = new Date(now.getTime() + 900_000);
  expect(await services.requestPasswordReset({ email: a.user.email })).toEqual(
    result,
  );
  expect(await count("fog_reset_emails")).toBe(4);
});

test("reset request atomically enqueues mail and hashed token; delivery clears secret payload", async () => {
  await services.requestPasswordReset({ email: a.user.email });
  const raw = (await client.execute("SELECT reset_url FROM fog_reset_emails"))
    .rows[0]?.reset_url;
  if (typeof raw !== "string") throw new Error("url");
  const token = new URL(raw).searchParams.get("token");
  expect(token).toBeTruthy();
  expect(raw).toMatch(/^http:\/\/localhost:3000\/password\/reset\?token=/);
  expect(
    JSON.stringify(
      (await client.execute("SELECT * FROM fog_password_resets")).rows,
    ),
  ).not.toContain(token);
  const sender = mailer();
  expect(await dispatch(sender)).toEqual({ sentCount: 1, failedCount: 0 });
  expect(sender.sendPasswordReset.mock.calls[0]?.[0]).toMatchObject({
    to: a.user.email,
    resetUrl: raw,
  });
  expect(await count("fog_reset_emails")).toBe(0);
  expect(await count("fog_password_resets")).toBe(1);
  await client.execute(
    "CREATE TRIGGER fail_mail_insert BEFORE INSERT ON fog_reset_emails BEGIN SELECT RAISE(ABORT,'fail'); END",
  );
  await expect(
    services.requestPasswordReset({ email: b.user.email }),
  ).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
  expect(await count("fog_password_resets")).toBe(1);
});

test("mailer failure is retried after backoff with stable ID; missing mailer still purges expired payloads", async () => {
  await services.requestPasswordReset({ email: a.user.email });
  const sender = mailer();
  sender.sendPasswordReset.mockRejectedValueOnce(new Error("SMTP unavailable"));
  expect(await dispatch(sender)).toEqual({ sentCount: 0, failedCount: 1 });
  expect(await count("fog_reset_emails")).toBe(1);
  expect(await dispatch(sender)).toEqual({ sentCount: 0, failedCount: 0 });
  now = new Date(now.getTime() + 30_000);
  expect(await dispatch(sender)).toEqual({ sentCount: 1, failedCount: 0 });
  expect(sender.sendPasswordReset.mock.calls[0]?.[0].id).toBe(
    sender.sendPasswordReset.mock.calls[1]?.[0].id,
  );
  await services.requestPasswordReset({ email: b.user.email });
  expect(await dispatch()).toEqual({ sentCount: 0, failedCount: 0 });
  expect(await count("fog_reset_emails")).toBe(1);
  now = new Date(now.getTime() + 1_800_000);
  await dispatch();
  expect(await count("fog_reset_emails")).toBe(0);
  expect(await count("fog_password_resets")).toBe(0);
});

test("mail leases exclude concurrent dispatchers and expired leases are reclaimable", async () => {
  await services.requestPasswordReset({ email: a.user.email });
  const sender = mailer();
  const results = await Promise.all([dispatch(sender), dispatch(sender)]);
  expect(results.reduce((sum, result) => sum + result.sentCount, 0)).toBe(1);
  expect(sender.sendPasswordReset).toHaveBeenCalledTimes(1);
  await services.requestPasswordReset({ email: b.user.email });
  const claimed = await unitOfWork().run(({ account }) =>
    account.claimResetMail({
      now: now.toISOString(),
      leaseUntil: new Date(now.getTime() + 60_000).toISOString(),
      leaseToken: "crashed-worker",
    }),
  );
  expect(claimed).not.toBeNull();
  expect(await dispatch(sender)).toEqual({ sentCount: 0, failedCount: 0 });
  now = new Date(now.getTime() + 60_000);
  expect(await dispatch(sender)).toEqual({ sentCount: 1, failedCount: 0 });
});

test("password reset consumes all links, rotates all sessions, logs in immediately and rejects old password", async () => {
  const oldLogin = await services.login({
    email: a.user.email,
    password: originalPassword,
  });
  const token = await resetToken();
  const otherToken = await resetToken();
  const reset = await services.completePasswordReset({ token, newPassword });
  expect(reset.user).toEqual(a.user);
  expect(await services.authenticate(reset.token)).toEqual(a.user);
  expect(await services.authenticate(a.token)).toBeNull();
  expect(await services.authenticate(oldLogin.token)).toBeNull();
  expect(await services.authenticate(b.token)).toEqual(b.user);
  await expect(
    services.completePasswordReset({ token, newPassword }),
  ).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
  await expect(
    services.completePasswordReset({ token: otherToken, newPassword }),
  ).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
  await expect(
    services.login({ email: a.user.email, password: originalPassword }),
  ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  expect(
    (await services.login({ email: a.user.email, password: newPassword })).user,
  ).toEqual(a.user);
  expect(await count("fog_password_resets")).toBe(0);
  expect(await count("fog_reset_emails")).toBe(0);
});

test("reset expiry and invalid password leave sessions/password intact; concurrent token completion has one winner", async () => {
  const token = await resetToken();
  await expect(
    services.completePasswordReset({ token, newPassword: "short" }),
  ).rejects.toMatchObject({ code: "INVALID_PASSWORD" });
  now = new Date(now.getTime() + 1_800_000);
  await expect(
    services.completePasswordReset({ token, newPassword }),
  ).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
  expect(await services.authenticate(a.token)).toEqual(a.user);
  const fresh = await resetToken();
  const results = await Promise.allSettled([
    services.completePasswordReset({ token: fresh, newPassword }),
    services.completePasswordReset({
      token: fresh,
      newPassword: "another-new-password",
    }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
});

test("reset revokes AI created since previous reset inclusive, preserves older/other-owner connections and supports revoke-all", async () => {
  const old = await connectAi();
  const foreign = await connectAi(b.user);
  now = new Date(now.getTime() + 1000);
  const cutoff = now.toISOString();
  await client.execute({
    sql: "INSERT INTO fog_account_recovery(owner_id,last_reset_at) VALUES(?,?)",
    args: [a.user.userId, cutoff],
  });
  const recent = await connectAi();
  const token = await resetToken();
  now = new Date(now.getTime() + 1000);
  await services.completePasswordReset({ token, newPassword });
  await expect(
    services.executeAi(recent, { operation: "guidance", input: {} }),
  ).rejects.toMatchObject({ code: "AI_CONNECTION_UNAUTHORIZED" });
  expect(
    (await services.executeAi(old, { operation: "guidance", input: {} })).kind,
  ).toBe("read");
  expect(
    (await services.executeAi(foreign, { operation: "guidance", input: {} }))
      .kind,
  ).toBe("read");
  await services.revokeAllAiConnections(a.user);
  await expect(
    services.executeAi(old, { operation: "guidance", input: {} }),
  ).rejects.toMatchObject({ code: "AI_CONNECTION_UNAUTHORIZED" });
  expect(await services.listAiConnections(b.user)).toHaveLength(1);
});

test("first reset revokes every existing AI connection and final-session failure rolls all recovery changes back", async () => {
  const ai = await connectAi();
  const token = await resetToken();
  await client.execute(
    "CREATE TRIGGER fail_new_session BEFORE INSERT ON fog_sessions BEGIN SELECT RAISE(ABORT,'fail'); END",
  );
  await expect(
    services.completePasswordReset({ token, newPassword }),
  ).rejects.toMatchObject({ code: "STORAGE_CONFLICT" });
  expect(await services.authenticate(a.token)).toEqual(a.user);
  expect(
    (await services.executeAi(ai, { operation: "guidance", input: {} })).kind,
  ).toBe("read");
  expect(await count("fog_password_resets")).toBe(1);
  expect(await count("fog_account_recovery")).toBe(0);
  await client.execute("DROP TRIGGER fail_new_session");
  await services.completePasswordReset({ token, newPassword });
  await expect(
    services.executeAi(ai, { operation: "guidance", input: {} }),
  ).rejects.toMatchObject({ code: "AI_CONNECTION_UNAUTHORIZED" });
});

test("password change checks current credential, rotates sessions and invalidates queued reset links without revoking AI", async () => {
  const token = await resetToken();
  await services.requestPasswordReset({ email: a.user.email });
  const ai = await connectAi();
  await expect(
    services.changePassword(a.user, { currentPassword: "wrong", newPassword }),
  ).rejects.toMatchObject({ code: "INVALID_CURRENT_PASSWORD" });
  expect(await services.authenticate(a.token)).toEqual(a.user);
  const changed = await services.changePassword(a.user, {
    currentPassword: originalPassword,
    newPassword,
  });
  expect(await services.authenticate(a.token)).toBeNull();
  expect(await services.authenticate(changed.token)).toEqual(a.user);
  await expect(
    services.completePasswordReset({ token, newPassword }),
  ).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
  expect(await count("fog_reset_emails")).toBe(0);
  expect(
    (await services.executeAi(ai, { operation: "guidance", input: {} })).kind,
  ).toBe("read");
  const sso = await googleUser();
  await expect(
    services.changePassword(sso.user, {
      currentPassword: originalPassword,
      newPassword,
    }),
  ).rejects.toMatchObject({ code: "PASSWORD_LOGIN_UNAVAILABLE" });
});

test("AI cannot use human account/credential operations and repeated migration preserves SSO, recovery, content and AI", async () => {
  const actor = {
    kind: "ai",
    userId: a.user.userId,
    clientId: "test-ai",
    clientName: "AI",
  } as Actor as HumanActor;
  for (const operation of [
    () => services.beginGoogleAuth(actor, { browserToken, returnTo: "/" }),
    () =>
      services.completeGoogleAuth(actor, {
        browserToken,
        state: "bad",
        code: "code",
      }),
    () => services.credentials(actor),
    () => services.unlinkGoogleCredential(actor, { id: "bad" }),
    () =>
      services.changePassword(actor, {
        currentPassword: originalPassword,
        newPassword,
      }),
    () => services.revokeAllAiConnections(actor),
  ])
    await expect(operation()).rejects.toMatchObject({ code: "HUMAN_ONLY" });
  await complete(await begin(a.user), a.user);
  const memo = await services.createMemo(a.user, { body: "保持する本文" });
  const ai = await connectAi();
  await services.requestPasswordReset({ email: a.user.email });
  await migrateFog(client);
  await migrateFog(client);
  expect((await services.credentials(a.user)).google).toHaveLength(1);
  expect((await services.getMemo(a.user, memo.id)).body).toBe("保持する本文");
  expect(
    (await services.executeAi(ai, { operation: "guidance", input: {} })).kind,
  ).toBe("read");
  expect(await count("fog_password_resets")).toBe(1);
  expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
});

test("session rotation invalidates pending AI grants and Google links while preserving active AI connections on ordinary password change", async () => {
  const active = await connectAi();
  const verifier = "w".repeat(43);
  const request = await services.beginAiAuthorization({
    clientId: "test-ai",
    redirectUri: "http://127.0.0.1/callback",
    state: "state",
    codeChallenge: nodeSecretCrypto.pkceChallenge(verifier),
    codeChallengeMethod: "S256",
  });
  await services.getAiAuthorization(a.user, request.requestToken);
  const result = await services.decideAiAuthorization(a.user, {
    requestToken: request.requestToken,
    allow: true,
  });
  const code = new URL(result.redirectUri).searchParams.get("code");
  if (!code) throw new Error("code");
  const state = await begin(a.user);
  const rotated = await services.changePassword(a.user, {
    currentPassword: originalPassword,
    newPassword,
  });
  await expect(
    services.exchangeAiCode({
      clientId: "test-ai",
      redirectUri: "http://127.0.0.1/callback",
      code,
      codeVerifier: verifier,
    }),
  ).rejects.toMatchObject({ code: "INVALID_AI_CODE" });
  await expect(complete(state, rotated.user)).rejects.toMatchObject({
    code: "INVALID_GOOGLE_AUTH",
  });
  expect(
    (await services.executeAi(active, { operation: "guidance", input: {} }))
      .kind,
  ).toBe("read");
});

test("SSO distinct subjects competing for one email create one account, and reset invalidates queued earlier mail links", async () => {
  let number = 0;
  exchange.mockImplementation(async () => ({
    ...identity,
    subject: `subject-${++number}`,
  }));
  const first = await begin();
  const second = await begin();
  const results = await Promise.allSettled([complete(first), complete(second)]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(await count("fog_users")).toBe(3);
  expect(await count("fog_google_credentials")).toBe(1);
  const token = await resetToken();
  await services.requestPasswordReset({ email: a.user.email });
  const queued = (
    await client.execute("SELECT reset_url FROM fog_reset_emails")
  ).rows[0]?.reset_url;
  if (typeof queued !== "string") throw new Error("mail");
  await services.completePasswordReset({ token, newPassword });
  expect(await count("fog_reset_emails")).toBe(0);
  const old = new URL(queued).searchParams.get("token");
  if (!old) throw new Error("token");
  await expect(
    services.completePasswordReset({ token: old, newPassword }),
  ).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
});

test("revoke-all invalidates pending AI grants without interrupting an unrelated Google link", async () => {
  const verifier = "z".repeat(43);
  const pending = await services.beginAiAuthorization({
    clientId: "test-ai",
    redirectUri: "http://127.0.0.1/callback",
    state: "state",
    codeChallenge: nodeSecretCrypto.pkceChallenge(verifier),
    codeChallengeMethod: "S256",
  });
  await services.getAiAuthorization(a.user, pending.requestToken);
  const consent = await services.decideAiAuthorization(a.user, {
    requestToken: pending.requestToken,
    allow: true,
  });
  const code = new URL(consent.redirectUri).searchParams.get("code");
  if (!code) throw new Error("code");
  const googleState = await begin(a.user);
  await services.revokeAllAiConnections(a.user);
  await expect(
    services.exchangeAiCode({
      clientId: "test-ai",
      redirectUri: "http://127.0.0.1/callback",
      code,
      codeVerifier: verifier,
    }),
  ).rejects.toMatchObject({ code: "INVALID_AI_CODE" });
  expect((await complete(googleState, a.user)).kind).toBe("linked");
});
