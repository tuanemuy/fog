import type { CurrentUserView } from "@repo/core/application/identity/view";
import { LogoutButton } from "@/components/settings/LogoutButton";

type CurrentUserPanelProps = {
  user: Pick<CurrentUserView, "email" | "authMethods">;
};

const AUTH_METHOD_LABEL = {
  password: "メールアドレスとパスワード",
  sso: "外部アカウント",
} as const;

const ROW = "flex items-center justify-between gap-md py-row";

export function CurrentUserPanel({ user }: CurrentUserPanelProps) {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-label text-neutral-600">
        アカウント
      </h2>
      <div className={`${ROW} mt-sm`}>
        <span className="text-sm font-medium">メールアドレス</span>
        <span className="min-w-0 truncate text-sm text-neutral-700">
          {user.email}
        </span>
      </div>
      <div className={`${ROW} border-t border-neutral-100`}>
        <span className="text-sm font-medium">認証方式</span>
        <span className="text-sm text-neutral-700">
          {user.authMethods
            .map((method) => AUTH_METHOD_LABEL[method])
            .join("、")}
        </span>
      </div>
      <div className="border-t border-neutral-100 pt-lg">
        <LogoutButton />
      </div>
    </section>
  );
}
