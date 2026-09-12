import type { ReactNode } from "react";
import { SectionLabel } from "@/components/ui/SectionLabel";

/**
 * One section of the settings sheet (`spec/design/pages/settings.html`,
 * `.section-head`): its label, then its rows. Every section but the first
 * opens with the section gap and a hairline above the label — the line is the
 * section's, not the label's.
 */
export function SettingsSection({
  id,
  label,
  children,
}: Readonly<{
  /** Names the section after its label (`aria-labelledby`). */
  id: string;
  label: string;
  children: ReactNode;
}>) {
  return (
    <section
      aria-labelledby={id}
      className="not-first:mt-section not-first:border-t not-first:border-neutral-100 not-first:pt-lg"
    >
      <SectionLabel id={id}>{label}</SectionLabel>
      {children}
    </section>
  );
}

/** A settings row's name (`.item-name`): a client, a login method, the export. */
export function ItemName({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="font-base text-base font-medium leading-normal text-neutral-900 wrap-anywhere">
      {children}
    </p>
  );
}

/** The small line under an `ItemName` (`.item-meta`): dates, the kind of method. */
export function ItemMeta({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="mt-xs font-base text-xs leading-tight text-neutral-400 tabular-nums wrap-anywhere">
      {children}
    </p>
  );
}

/** The sentence under an `ItemName` that explains the row (`.export-desc`). */
export function ItemDescription({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <p className="mt-xs font-base text-sm leading-tight text-neutral-600">
      {children}
    </p>
  );
}

/** What stands in for a control a row cannot offer (`.item-note`, 「解除できません」). */
export function ItemNote({ children }: Readonly<{ children: string }>) {
  return (
    <span className="whitespace-nowrap font-base text-sm leading-tight text-neutral-600">
      {children}
    </span>
  );
}

/** A section with nothing to list (`.section-empty`). */
export function SectionEmpty({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="py-row font-base text-sm leading-normal text-neutral-600 wrap-anywhere">
      {children}
    </p>
  );
}
