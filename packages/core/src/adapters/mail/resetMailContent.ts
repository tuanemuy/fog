/** The link the mail carries; `appUrl` is configuration, never a request header. */
export function passwordResetUrl(appUrl: string, resetToken: string): string {
  const url = new URL("/password-reset", appUrl);
  url.searchParams.set("token", resetToken);
  return url.toString();
}

export function passwordResetMailText(resetUrl: string): string {
  return [
    "fog のパスワードをリセットするには、次のリンクを開いてください。",
    "",
    resetUrl,
    "",
    "このメールに心当たりが無い場合は、何もしないでください。リンクは 1 時間で無効になります。",
  ].join("\n");
}

export const PASSWORD_RESET_MAIL_SUBJECT = "fog のパスワードリセット";
