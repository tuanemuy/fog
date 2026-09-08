import { Link } from "@tanstack/react-router";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { AiConnectionsPanel } from "../AiConnectionsPanel";
import { CredentialList } from "../CredentialList";

const loadCurrentUser = serverData(
  () => import("@repo/core/application/identity/getCurrentUser"),
  async ({ container }, { getCurrentUser }, userId: string) =>
    getCurrentUser({ container, input: { userId } }),
);

/**
 * The streamed leaf of `/password-reset/done` (P-03 after the reset): the
 * login methods with their unlink, the AI connections with their
 * revocation, and the way back to the timeline. The link-adding entry is
 * deliberately absent — this screen removes what the user does not
 * recognise; it never adds.
 */
export async function PasswordResetDoneFeed() {
  const user = await guardStreamedRender(async () => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    return loadCurrentUser(userId);
  });
  return (
    <div className="fog-content fog-settings">
      <p className="fog-notice" role="status">
        パスワードを再設定しました。他の端末のセッションはすべて終了しています。
      </p>
      <section aria-labelledby="reset-done-credentials">
        <h2 id="reset-done-credentials" className="fog-section-heading">
          ログイン手段の確認
        </h2>
        <p className="fog-meta">
          覚えの無い外部アカウントの連携があれば、ここで解除してください。
        </p>
        <CredentialList credentials={user.credentials} showAddLink={false} />
      </section>
      <section aria-labelledby="reset-done-ai">
        <h2 id="reset-done-ai" className="fog-section-heading">
          AI クライアント接続の確認
        </h2>
        <AiConnectionsPanel />
      </section>
      <p>
        <Link to="/" className="fog-primary">
          タイムラインへ
        </Link>
      </p>
    </div>
  );
}
