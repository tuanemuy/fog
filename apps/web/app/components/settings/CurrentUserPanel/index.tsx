import type {
  AiClientConnectionView,
  CurrentUserView,
} from "@repo/core/application/identity/view";
import { SHEET_SECTION_CLASS } from "@/components/ui/SheetSection";
import { AiConnectionsList } from "../AiConnectionsList";
import { CredentialList } from "../CredentialList";
import { ExportPanel } from "../ExportPanel";
import { LogoutButton } from "../LogoutButton";
import { PasswordChangeForm } from "../PasswordChangeForm";
import { RetentionForm } from "../RetentionForm";
import { SettingsSection } from "../SettingsSection";

/** The password section exists only for an account that can log in with one (S-AC-07). */
export function hasPasswordCredential(user: CurrentUserView): boolean {
  return user.credentials.some((c) => c.kind === "email" && c.usableForLogin);
}

/**
 * The display half of P-13 (`spec/design/pages/settings.html`): the AI
 * connections, the login methods with their unlink and link actions, the
 * trash retention, the export, and the account — the password change and
 * the reset link where the account has a password, then logout. Never shows
 * a verifier or a provider subject: the view has none.
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
  const withPassword = hasPasswordCredential(user);
  return (
    <div>
      <SettingsSection id="settings-ai" label="AI">
        <AiConnectionsList connections={aiConnections} mcpUrl={mcpUrl} />
      </SettingsSection>
      <SettingsSection id="settings-credentials" label="ログイン手段">
        <CredentialList
          credentials={user.credentials}
          linkProviders={ssoProviders}
          email={user.email}
        />
      </SettingsSection>
      <SettingsSection id="settings-trash" label="ゴミ箱">
        <RetentionForm retentionDays={user.trashRetentionDays} />
      </SettingsSection>
      <SettingsSection id="settings-data" label="データ">
        <ExportPanel />
      </SettingsSection>
      <SettingsSection id="settings-account" label="アカウント">
        {withPassword && <PasswordChangeForm />}
        <div className={withPassword ? SHEET_SECTION_CLASS : undefined}>
          <LogoutButton />
        </div>
      </SettingsSection>
    </div>
  );
}
