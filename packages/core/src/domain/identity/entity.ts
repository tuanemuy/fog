import { BusinessRuleError, RehydrationError } from "../error";
import {
  type TrashRetentionDays,
  TrashRetentionDays as TrashRetentionDaysValue,
  type UserId,
} from "./valueObject";

export type Profile = Readonly<{
  userId: UserId;
  displayName: string | null;
}>;

export type Settings = Readonly<{
  userId: UserId;
  trashRetentionDays: TrashRetentionDays;
}>;

function displayName(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (new TextEncoder().encode(value).byteLength > 200) {
    throw new BusinessRuleError(
      "IDENTITY_DISPLAY_NAME_TOO_LONG",
      "Display name is too long",
    );
  }
  return value;
}

export const Profile = {
  create: (input: Profile): Profile => ({
    userId: input.userId,
    displayName: displayName(input.displayName),
  }),
};

export const Settings = {
  create: (input: Settings): Settings => ({
    userId: input.userId,
    trashRetentionDays: TrashRetentionDaysValue.create(
      input.trashRetentionDays,
    ),
  }),
  changeTrashRetentionDays: (
    settings: Settings,
    trashRetentionDays: TrashRetentionDays,
  ): Settings =>
    trashRetentionDays === settings.trashRetentionDays
      ? settings
      : { ...settings, trashRetentionDays },
  reconstruct: (input: {
    userId: UserId;
    trashRetentionDays: number;
  }): Settings => {
    try {
      return {
        userId: input.userId,
        trashRetentionDays: TrashRetentionDaysValue.create(
          input.trashRetentionDays,
        ),
      };
    } catch (error) {
      throw new RehydrationError(
        `Failed to rehydrate Settings (userId=${input.userId})`,
        error,
      );
    }
  },
};
