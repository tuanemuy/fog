import type { SsoErrorCode } from "@/components/auth/schema";

/** The wording of a `?sso=` / `?sso_error=` the link callback redirected to P-13 with. */
export function renderSettingsSsoNotice(
  sso: "linked" | undefined,
  ssoError: SsoErrorCode | undefined,
): { kind: "status" | "alert"; text: string } | null {
  if (sso === "linked") {
    return { kind: "status", text: "外部アカウントを連携しました" };
  }
  switch (ssoError) {
    case undefined:
      return null;
    case "already_used":
      return {
        kind: "alert",
        text: "この外部アカウントは既に別のアカウントに連携されています",
      };
    case "cancelled":
      return { kind: "alert", text: "外部アカウントの連携が中断されました" };
    case "email_registered":
    case "unverified":
    case "failed":
      return {
        kind: "alert",
        text: "外部アカウントの連携に失敗しました。もう一度お試しください",
      };
  }
}

export function SsoNotice({
  sso,
  ssoError,
}: {
  sso: "linked" | undefined;
  ssoError: SsoErrorCode | undefined;
}) {
  const notice = renderSettingsSsoNotice(sso, ssoError);
  if (notice === null) return null;
  return (
    <p
      className={notice.kind === "status" ? "fog-notice" : "fog-error"}
      role={notice.kind}
    >
      {notice.text}
    </p>
  );
}
