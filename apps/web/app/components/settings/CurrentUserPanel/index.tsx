import { cache } from "react";
import { LogoutButton } from "@/components/settings/LogoutButton";
import { requireUserId } from "@/presentation/currentUser";
import { serverData } from "@/presentation/serverAction";

const loadCurrentUser = cache(
  serverData(
    () => import("@repo/core/application/identity/getCurrentUser"),
    async ({ container }, { getCurrentUser }, userId: string) =>
      getCurrentUser({ container, input: { userId } }),
  ),
);

const AUTH_METHOD_LABEL = {
  password: "メールアドレスとパスワード",
  sso: "外部アカウント",
} as const;

const ROW = "flex items-center justify-between gap-md py-(--pad-row)";

export async function CurrentUserPanel() {
  const userId = await requireUserId();
  const { user } = await loadCurrentUser(userId);

  return (
    <section>
      <h2 className="mb-sm text-xs font-semibold uppercase tracking-label text-neutral-600">
        アカウント
      </h2>
      <div className={ROW}>
        <span className="text-sm font-medium">メールアドレス</span>
        <span className="min-w-0 truncate text-sm text-neutral-700">
          {user.email}
        </span>
      </div>
      <div className={`${ROW} border-t border-neutral-100`}>
        <span className="text-sm font-medium">認証方式</span>
        <span className="text-sm text-neutral-700">
          {AUTH_METHOD_LABEL[user.authMethod]}
        </span>
      </div>
      <div className="border-t border-neutral-100 pt-lg">
        <LogoutButton />
      </div>
    </section>
  );
}
