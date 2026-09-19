import { EmptyState } from "@/components/ui/EmptyState";
import { LogoutButton } from "../LogoutButton";

/**
 * P-13 when the account cannot be read: the load failure's one sentence,
 * with the one control that must survive it in place of 「再試行」. A
 * settings screen whose data cannot be loaded (the address undecryptable
 * after `purge-user-mappings`, a reverse-index row gone) would otherwise
 * leave the user with no way out but deleting the cookie by hand — the
 * session is alive on the object's side. The sentence is fixed, like the
 * route error's: nothing of the failure reaches the page.
 */
export function SettingsUnavailable() {
  return (
    <div role="alert">
      <EmptyState message="読み込めませんでした" action={<LogoutButton />} />
    </div>
  );
}
