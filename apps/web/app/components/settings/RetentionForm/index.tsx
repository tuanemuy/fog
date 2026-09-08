"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId, useOptimistic, useState } from "react";
import { displayError, toDisplayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import { changeTrashRetentionDaysFn } from "../actions";
import { isRetentionSavedResult } from "../schema";

type FormState = Readonly<{ error: string | null; saved: boolean }>;

/**
 * P-13's retention setting (S-ST-01). The saved value shows optimistically
 * while the request runs; a rejection keeps the draft and names the rule.
 * No upper bound on the input: the domain has none (decision △-4).
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
        return { error: "1 以上の整数を入力してください", saved: false };
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
        return {
          error:
            serialized.kind === "business" &&
            serialized.code === "INVALID_TRASH_RETENTION_DAYS"
              ? "1 以上の整数を入力してください"
              : displayError(failure),
          saved: false,
        };
      }
    },
    { error: null, saved: false },
  );

  return (
    <form
      action={action}
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
