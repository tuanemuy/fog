"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  type FormEvent,
  startTransition,
  useActionState,
  useId,
  useOptimistic,
  useState,
} from "react";
import { displayError, toDisplayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { changeTrashRetentionDaysFn } from "../actions";
import {
  isRetentionSavedResult,
  RETENTION_DAYS_TRANSPORT_MAX,
} from "../schema";

type FormState = Readonly<{ error: string | null; saved: boolean }>;

const RULE_MESSAGE = "1 以上の整数を入力してください";
const CEILING_MESSAGE = `${RETENTION_DAYS_TRANSPORT_MAX.toLocaleString("ja-JP")} 日以下で入力してください`;

/**
 * P-13's retention setting (S-ST-01). The saved value shows optimistically
 * while the request runs; a rejection keeps the draft and names the rule.
 * The domain has no upper bound (decision △-4); the transport's DoS ceiling
 * is checked here too, so a value past it gets words instead of the
 * schema's English. The submit dispatches the action itself rather than
 * through `<form action>`: that path resets the form afterwards, and a
 * focused number input's default is the value it was drawn with, so a
 * rejected draft would snap back to it.
 */
export function RetentionForm({ retentionDays }: { retentionDays: number }) {
  const router = useRouter();
  const change = useServerFn(changeTrashRetentionDaysFn);
  const inputId = useId();
  // Controlled so the draft survives a rejected save (P-13 項目別エラー).
  const [draft, setDraft] = useState(String(retentionDays));
  const [shown, showSaved] = useOptimistic<number, number>(
    retentionDays,
    (_current, next) => next,
  );
  const [state, action, pending] = useActionState<FormState, FormData>(
    async (_previous, formData) => {
      const raw = String(formData.get("retentionDays") ?? "").trim();
      const value = Number(raw);
      if (raw.length === 0 || !Number.isInteger(value) || value < 1) {
        return { error: RULE_MESSAGE, saved: false };
      }
      if (value > RETENTION_DAYS_TRANSPORT_MAX) {
        return { error: CEILING_MESSAGE, saved: false };
      }
      showSaved(value);
      try {
        readServerFnResult(
          await change({ data: { retentionDays: value } }),
          isRetentionSavedResult,
          "changeTrashRetentionDaysFn",
        );
        await router.invalidate();
        return { error: null, saved: true };
      } catch (failure) {
        const serialized = toDisplayError(failure);
        const refusedValue =
          (serialized.kind === "business" &&
            serialized.code === "INVALID_TRASH_RETENTION_DAYS") ||
          (serialized.kind === "validation" &&
            serialized.fieldErrors?.retentionDays !== undefined);
        return {
          error: refusedValue ? RULE_MESSAGE : displayError(failure),
          saved: false,
        };
      }
    },
    { error: null, saved: false },
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => action(data));
  };

  return (
    <form
      onSubmit={submit}
      className="fog-retention-form"
      aria-label="ゴミ箱の保持期限"
    >
      <label htmlFor={inputId}>削除した項目を保持する日数</label>
      <div className="fog-retention-line">
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
          disabled={pending}
        />
        <span className="fog-input-unit">日</span>
        <button type="submit" className="fog-primary" disabled={pending}>
          {pending ? "保存中…" : "保存"}
        </button>
      </div>
      <p className="fog-meta">
        現在: {shown} 日。既存のゴミ箱の項目にも適用されます。
      </p>
      {state.error !== null && (
        <p className="fog-error" role="alert">
          {state.error}
        </p>
      )}
      {state.saved && state.error === null && !pending && (
        <p className="fog-notice" role="status">
          保存しました。既存のゴミ箱の項目にも適用されます
        </p>
      )}
    </form>
  );
}
