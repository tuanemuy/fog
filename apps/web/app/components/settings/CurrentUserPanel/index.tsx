import { cache } from "react";
import { requireUserId } from "@/presentation/currentUser";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";

const loadCurrentUser = cache(
  serverData(
    () => import("@repo/core/application/identity/getCurrentUser"),
    async (
      { container },
      { getCurrentUser },
      identity: { userId: string; epoch: number },
    ) => getCurrentUser({ container, input: identity }),
  ),
);

const CREDENTIAL_LABEL = {
  email: "メールアドレスとパスワード",
  sso: "外部アカウント",
} as const;

const ROW = "flex items-center justify-between gap-md py-row";

export async function CurrentUserPanel() {
  // This leaf is streamed, so it renders outside `errorResponseMiddleware`.
  const user = await guardStreamedRender(async () =>
    loadCurrentUser(await requireUserId()),
  );

  // The address itself is deliberately absent: the original lives encrypted in
  // the Identity Directory and is decrypted one at a time through an entry this
  // issue does not implement (#12). What is shown here is the non-PII summary.
  const signInMethods = user.credentials.filter(
    (credential) => credential.usableForLogin,
  );

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-label text-neutral-600">
        アカウント
      </h2>
      {signInMethods.map((credential, index) => (
        <div
          key={credential.credentialId}
          className={`${ROW} ${index === 0 ? "mt-sm" : "border-t border-neutral-100"}`}
        >
          <span className="text-sm font-medium">認証方式</span>
          <span className="text-sm text-neutral-700">
            {credential.label === ""
              ? CREDENTIAL_LABEL[credential.kind]
              : `${CREDENTIAL_LABEL[credential.kind]}（${credential.label}）`}
          </span>
        </div>
      ))}
    </section>
  );
}
