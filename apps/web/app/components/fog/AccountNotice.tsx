export function AccountNotice({ status }: { status?: string | undefined }) {
  const messages: Record<string, string> = {
    cancelled: "Googleでの認証を中断しました。",
    linked: "Googleのログイン手段を追加しました。",
    failed: "Googleでの認証に失敗しました。もう一度お試しください。",
    "email-exists":
      "このメールアドレスは既に使われています。パスワードでログインして、設定からGoogle連携を追加してください。",
    "already-linked":
      "このGoogleアカウントは既に連携されています。別のアカウントを選んでください。",
  };
  return status && messages[status] ? (
    <p
      className={
        status === "cancelled" || status === "linked" ? "fog-hint" : "fog-error"
      }
      role={status === "cancelled" || status === "linked" ? "status" : "alert"}
    >
      {messages[status]}
    </p>
  ) : null;
}
