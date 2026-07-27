import { cache } from "react";
import { LogoutButton } from "@/components/settings/LogoutButton";
import { requireUserId } from "@/presentation/currentUser";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";

const loadCurrentUser = cache(
  serverData(
    () => import("@/presentation/identityActionHandlers"),
    async ({ container }, { currentUserAction }, userId: string) =>
      currentUserAction(container, userId),
  ),
);

const AUTH_METHOD_LABEL = {
  password: "メールアドレスとパスワード",
  sso: "外部アカウント",
} as const;

const ROW = "flex items-center justify-between gap-md py-row";

export async function CurrentUserPanel() {
  // This leaf is streamed, so it renders outside `errorResponseMiddleware`.
  const user = await guardStreamedRender(async () =>
    loadCurrentUser(await requireUserId()),
  );

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
