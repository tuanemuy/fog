import type {
  AiClientConnectionView,
  CurrentUserView,
} from "@repo/core/application/identity/view";
import { AiConnectionsList } from "../AiConnectionsList";
import { CredentialList } from "../CredentialList";
import { ExportPanel } from "../ExportPanel";
import { LogoutButton } from "../LogoutButton";
import { PasswordChangeForm } from "../PasswordChangeForm";
import { RetentionForm } from "../RetentionForm";

/** The password section exists only for an account that can log in with one (S-AC-07). */
export function hasPasswordCredential(user: CurrentUserView): boolean {
  return user.credentials.some((c) => c.kind === "email" && c.usableForLogin);
}

/**
 * The display half of P-13: the address, the login methods with their
 * unlink and link actions, the password change, the trash retention, the
 * export and the AI connections. Never shows a verifier or a provider
 * subject: the view has none.
 */
export function CurrentUserPanel({
  user,
  ssoProviders,
  aiConnections,
  mcpUrl,
}: {
  user: CurrentUserView;
  /** `AppConfig.ssoProviders`: the link entries P-13 may offer. */
  ssoProviders: readonly string[];
  aiConnections: readonly AiClientConnectionView[];
  mcpUrl: string;
}) {
  return (
    <div className="fog-settings">
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
        <CredentialList
          credentials={user.credentials}
          linkProviders={ssoProviders}
        />
      </section>

      {hasPasswordCredential(user) && (
        <section aria-labelledby="settings-password">
          <h2 id="settings-password" className="fog-section-heading">
            パスワードの変更
          </h2>
          <PasswordChangeForm />
        </section>
      )}

      <section aria-labelledby="settings-trash">
        <h2 id="settings-trash" className="fog-section-heading">
          ゴミ箱の保持期限
        </h2>
        <RetentionForm retentionDays={user.trashRetentionDays} />
      </section>

      <section aria-labelledby="settings-data">
        <h2 id="settings-data" className="fog-section-heading">
          データ
        </h2>
        <ExportPanel />
      </section>

      <section aria-labelledby="settings-ai">
        <h2 id="settings-ai" className="fog-section-heading">
          AI クライアント接続
        </h2>
        <AiConnectionsList connections={aiConnections} mcpUrl={mcpUrl} />
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
