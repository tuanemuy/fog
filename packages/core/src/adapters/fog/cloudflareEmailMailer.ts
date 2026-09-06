import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { ResetMailer } from "@repo/core/application/fog/accountPorts";

export interface CloudflareEmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export function createCloudflareResetMailer({
  binding,
  from,
}: {
  binding: CloudflareEmailBinding;
  from: string;
}): ResetMailer {
  if (!from || /[\r\n]/.test(from)) throw new Error("Invalid email sender");
  return {
    async sendPasswordReset(input) {
      try {
        await binding.send({
          to: input.to,
          from,
          subject: "fog パスワード再設定",
          text: [
            "fog のパスワード再設定リンクです。",
            "",
            input.resetUrl,
            "",
            `有効期限: ${input.expiresAt}`,
            "心当たりがない場合は、このメールを破棄してください。",
          ].join("\n"),
          headers: { "X-Fog-Message-ID": input.id },
        });
      } catch (cause) {
        throw new SystemError(
          SystemErrorCode.ExternalApiError,
          "Password reset email could not be sent.",
          cause,
        );
      }
    },
  };
}
