import { LogoutButton } from "../LogoutButton";

/**
 * P-13 when the account cannot be read: the failure, and the one control
 * that must survive it. A settings screen whose data cannot be loaded
 * (the address undecryptable after `purge-user-mappings`, a reverse-index
 * row gone) would otherwise leave the user with no way out but deleting
 * the cookie by hand — the session is alive on the object's side.
 */
export function SettingsUnavailable({ message }: { message: string }) {
  return (
    <div className="fog-content fog-settings">
      <div role="alert">
        <h2 className="fog-section-heading">読み込めませんでした</h2>
        <p>{message}</p>
      </div>
      <section aria-labelledby="settings-session">
        <h2 id="settings-session" className="fog-section-heading">
          セッション
        </h2>
        <LogoutButton />
      </section>
    </div>
  );
}
