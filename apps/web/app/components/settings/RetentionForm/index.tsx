"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  type FormEvent,
  startTransition,
  useActionState,
  useId,
  useState,
} from "react";
import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/FieldError";
import { useToast } from "@/components/ui/Toast";
import { displayError, toDisplayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { changeTrashRetentionDaysFn } from "../actions";
import {
  isRetentionSavedResult,
  RETENTION_DAYS_TRANSPORT_MAX,
} from "../schema";

type FormState = Readonly<{ error: string | null }>;

export const RULE_MESSAGE = "1以上の日数を入力してください";
export const CEILING_MESSAGE = `${RETENTION_DAYS_TRANSPORT_MAX.toLocaleString("ja-JP")}日以下で入力してください`;
export const RETENTION_SAVED_MESSAGE = "保持期限を保存しました";

// `.input-number` in `spec/design/pages/settings.html`: the form's field box
// at the number's width, digits in tabular figures.
const NUMBER_INPUT_CLASS =
  "w-input-number rounded-md bg-bg-card p-(--pad-input) font-base text-base leading-tight tabular-nums text-neutral-900 [border:var(--border-input)] transition-colors focus:not-aria-invalid:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-invalid:border-error read-only:text-neutral-600";

/**
 * P-13's retention setting (S-ST-01), a settings row: label and note, then
 * the number, its unit and 「保存」, stacked on a narrow screen. While the
 * request runs the field is read-only and the button says 「保存中…」; a
 * rejection keeps the draft and names the rule under the row; the success is
 * a toast. The domain has no upper bound; the transport's DoS
 * ceiling is checked here too, so a value past it gets words instead of the
 * schema's English. The submit dispatches the action itself rather than
 * through `<form action>`: that path resets the form afterwards, and a
 * focused number input's default is the value it was drawn with, so a
 * rejected draft would snap back to it.
 */
export function RetentionForm({ retentionDays }: { retentionDays: number }) {
  const router = useRouter();
  const change = useServerFn(changeTrashRetentionDaysFn);
  const toast = useToast();
  const id = useId();
  const inputId = `${id}-days`;
  const noteId = `${id}-note`;
  const errorId = `${id}-error`;
  // Controlled so the draft survives a rejected save (P-13 項目別エラー).
  const [draft, setDraft] = useState(String(retentionDays));
  const [state, action, pending] = useActionState<FormState, FormData>(
    async (_previous, formData) => {
      const raw = String(formData.get("retentionDays") ?? "").trim();
      const value = Number(raw);
      if (raw.length === 0 || !Number.isInteger(value) || value < 1) {
        return { error: RULE_MESSAGE };
      }
      if (value > RETENTION_DAYS_TRANSPORT_MAX) {
        return { error: CEILING_MESSAGE };
      }
      try {
        readServerFnResult(
          await change({ data: { retentionDays: value } }),
          isRetentionSavedResult,
          "changeTrashRetentionDaysFn",
        );
        await router.invalidate();
        toast(RETENTION_SAVED_MESSAGE);
        return { error: null };
      } catch (failure) {
        const serialized = toDisplayError(failure);
        const refusedValue =
          (serialized.kind === "business" &&
            serialized.code === "INVALID_TRASH_RETENTION_DAYS") ||
          (serialized.kind === "validation" &&
            serialized.fieldErrors?.retentionDays !== undefined);
        return { error: refusedValue ? RULE_MESSAGE : displayError(failure) };
      }
    },
    { error: null },
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => action(data));
  };

  const hasError = state.error !== null;

  return (
    <form
      onSubmit={submit}
      aria-label="ゴミ箱の保持期限"
      className="flex flex-col items-start gap-md py-row sm:flex-row sm:flex-wrap sm:items-end"
    >
      <div className="min-w-[0] flex-1">
        <label
          htmlFor={inputId}
          className="block font-base text-sm font-medium leading-tight text-neutral-900"
        >
          保持期限
        </label>
        <p
          id={noteId}
          className="mt-xs font-base text-sm leading-tight text-neutral-600"
        >
          既存のゴミ箱の項目にも適用されます
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-sm">
        <input
          id={inputId}
          name="retentionDays"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          required
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          readOnly={pending}
          aria-invalid={hasError ? true : undefined}
          aria-describedby={hasError ? `${errorId} ${noteId}` : noteId}
          className={NUMBER_INPUT_CLASS}
        />
        <span className="whitespace-nowrap font-base text-sm text-neutral-600">
          日
        </span>
        <Button variant="fill-sm" type="submit" disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </Button>
      </div>
      {state.error !== null && (
        <div className="sm:basis-full">
          <FieldError id={errorId}>{state.error}</FieldError>
        </div>
      )}
    </form>
  );
}
