import type { CurrentUserView } from "@repo/core/application/identity/view";
import { LogoutButton } from "../LogoutButton";
import { RetentionForm } from "../RetentionForm";

const KIND_LABELS = { email: "メールアドレス", sso: "外部アカウント" } as const;

function credentialLabel(
  credential: CurrentUserView["credentials"][number],
): string {
  if (credential.kind === "sso") {
    return `${KIND_LABELS.sso}（${credential.label}）`;
  }
  return KIND_LABELS.email;
}

/**
 * The display half of P-13: the address, the login methods, the trash
 * retention and the AI connections placeholder. The mutations (retention
 * change, password change, SSO link, export, AI revocation) join with their
 * slices. Never shows a verifier or a provider subject: the view has none.
 */
export function CurrentUserPanel({ user }: { user: CurrentUserView }) {
  return (
    <div className="fog-content fog-settings">
      <section aria-labelledby="settings-account">
        <h2 id="settings-account" className="fog-section-heading">
          アカウント
        </h2>
        <dl className="fog-settings-list">
          <div className="fog-settings-row">
            <dt>メールアドレス</dt>
            <dd>{user.email}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="settings-credentials">
        <h2 id="settings-credentials" className="fog-section-heading">
          ログイン手段
        </h2>
        <ul className="fog-settings-list">
          {user.credentials.map((credential) => (
            <li key={credential.credentialId} className="fog-settings-row">
              <span>{credentialLabel(credential)}</span>
              <span className="fog-meta">
                {credential.usableForLogin
                  ? "ログインに使用"
                  : "一意性の予約のみ"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="settings-trash">
        <h2 id="settings-trash" className="fog-section-heading">
          ゴミ箱の保持期限
        </h2>
        <RetentionForm retentionDays={user.trashRetentionDays} />
      </section>

      <section aria-labelledby="settings-ai">
        <h2 id="settings-ai" className="fog-section-heading">
          AI クライアント接続
        </h2>
        <p className="fog-meta">
          接続はまだありません。AI
          クライアントからの接続は今後の更新で有効になります。
        </p>
      </section>

      <section aria-labelledby="settings-session">
        <h2 id="settings-session" className="fog-section-heading">
          セッション
        </h2>
        <LogoutButton />
      </section>
    </div>
  );
}
