import type { RequestContainer } from "@repo/core/application/di/types";
import { getCurrentUser } from "@repo/core/application/identity/getCurrentUser";
import { loginWithPassword } from "@repo/core/application/identity/loginWithPassword";
import { logout } from "@repo/core/application/identity/logout";
import { registerWithPassword } from "@repo/core/application/identity/registerWithPassword";

export function registerPasswordAction(
  container: RequestContainer,
  input: Parameters<typeof registerWithPassword>[0]["input"],
) {
  return registerWithPassword({ container, input });
}

export function loginPasswordAction(
  container: RequestContainer,
  input: Parameters<typeof loginWithPassword>[0]["input"],
) {
  return loginWithPassword({ container, input });
}

export function currentUserAction(container: RequestContainer, userId: string) {
  return getCurrentUser({ container, input: { userId } });
}

export function logoutAction(container: RequestContainer, userId: string) {
  return logout({ container, input: { userId } });
}
