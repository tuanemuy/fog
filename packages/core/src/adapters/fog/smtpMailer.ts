import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { ResetMailer } from "@repo/core/application/fog/accountPorts";
import nodemailer from "nodemailer";

export function createSmtpResetMailer({
  host,
  port,
  from,
  user,
  password,
  appUrl,
  local = false,
}: {
  host: string;
  port: number;
  from: string;
  user?: string;
  password?: string;
  appUrl: string;
  local?: boolean;
}): ResetMailer {
  const app = new URL(appUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"];
  if (
    local &&
    (!loopback.includes(host) ||
      app.protocol !== "http:" ||
      !loopback.includes(app.hostname))
  )
    throw new Error(
      "Local SMTP fixture requires loopback mail and application URLs",
    );
  const secure = !local && port === 465;
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !local && !secure,
    ignoreTLS: local,
    ...(user && password ? { auth: { user, pass: password } } : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    logger: false,
    debug: false,
  });
  return {
    async sendPasswordReset({ id, to, resetUrl, expiresAt }) {
      const link = new URL(resetUrl);
      if (link.origin !== app.origin || link.pathname !== "/password/reset")
        throw new SystemError(
          SystemErrorCode.NetworkError,
          "復旧メールの宛先URLを確認できません。",
        );
      try {
        await transport.sendMail({
          from,
          to,
          messageId: `<${id}@fog.local>`,
          subject: "fog のパスワードを再設定",
          text: `次のリンクから新しいパスワードを設定してください。\n\n${resetUrl}\n\n有効期限: ${expiresAt}\nこの操作を依頼していない場合は、このメールを破棄してください。`,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
      } catch {
        throw new SystemError(
          SystemErrorCode.NetworkError,
          "復旧メールを送信できませんでした。",
        );
      }
    },
  };
}
