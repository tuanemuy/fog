export type CurrentUserView = Readonly<{
  userId: string;
  email: string;
  authMethods: readonly ("password" | "sso")[];
  displayName: string | null;
  trashRetentionDays: number;
}>;
