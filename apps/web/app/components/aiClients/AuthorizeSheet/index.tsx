"use client";

import { useServerFn } from "@tanstack/react-start";
import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";
import { AuthSheetTitle } from "@/components/layout/AuthSheet";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Icon } from "@/components/ui/Icon";
import { RowList } from "@/components/ui/RowList";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { SHEET_SECTION_CLASS } from "@/components/ui/SheetSection";
import { displayError } from "@/presentation/errorDisplay";
import { readServerFnResult } from "@/presentation/serverFnResult";
import {
  approveAiClientAuthorizationFn,
  denyAiClientAuthorizationFn,
} from "../actions";
import {
  type AuthorizationRequestView,
  isAuthorizationOutcome,
} from "../schema";

export const ALLOWED_OPERATIONS = [
  "メモを読む・書く",
  "ドキュメントを読む・書く",
  "トピックを作る・更新する（完了を含む）",
  "ゴミ箱へ移す（ソフトデリート）",
] as const;

export const DENIED_OPERATIONS = [
  "完全削除・履歴の削除はできません",
  "ゴミ箱にアクセス・復元・空にすることはできません",
  "履歴の閲覧・ロールバックはできません",
] as const;

export const INVALID_REQUEST_MESSAGE =
  "認可リクエストが正しくありません。クライアントアプリからやり直してください";

// A block of the sheet after the client: a section's space above it and the
// hairline that separates it from what came before.
const BLOCK_CLASS = SHEET_SECTION_CLASS;

// The glyph sits in a one-line box so it lines up with the first line of a
// wrapped item.
const GLYPH_CLASS = "flex h-[1lh] shrink-0 items-center text-neutral-500";

/**
 * The two decisions. The label of the one in flight says so (「許可中…」);
 * both stay disabled while the request is in flight — the navigation to the
 * client is asked for as the action ends, so they are pressable again for the
 * moment the browser takes to leave.
 */
function DecisionButtons() {
  const { pending, data } = useFormStatus();
  const approving = pending && data?.get("decision") === "approve";
  return (
    <>
      <Button
        variant="fill"
        type="submit"
        name="decision"
        value="approve"
        disabled={pending}
      >
        {approving ? "許可中…" : "許可する"}
      </Button>
      <Button
        variant="outline"
        type="submit"
        name="decision"
        value="deny"
        disabled={pending}
      >
        拒否する
      </Button>
    </>
  );
}

/**
 * P-14 (`spec/design/pages/ai-client-authorize.html`). The two decisions run
 * as actions; either ends in a full navigation to the client's own redirect
 * URI, so no route context survives. An invalid or expired request draws the
 * error in place of the lists and the buttons, and no 「許可する」 at all.
 */
export function AuthorizeSheet({
  request,
  view,
}: {
  request: string | undefined;
  view: AuthorizationRequestView;
}) {
  const approve = useServerFn(approveAiClientAuthorizationFn);
  const deny = useServerFn(denyAiClientAuthorizationFn);
  const id = useId();
  const [error, act, pending] = useActionState<string | null, FormData>(
    async (_previous, formData) => {
      if (request === undefined) return INVALID_REQUEST_MESSAGE;
      const decision = formData.get("decision");
      try {
        const outcome = readServerFnResult(
          await (decision === "approve" ? approve : deny)({
            data: { request },
          }),
          isAuthorizationOutcome,
          decision === "approve"
            ? "approveAiClientAuthorizationFn"
            : "denyAiClientAuthorizationFn",
        );
        window.location.assign(outcome.redirectTo);
        return null;
      } catch (failure) {
        return displayError(failure);
      }
    },
    null,
  );

  return (
    <section aria-labelledby={`${id}-title`}>
      <AuthSheetTitle id={`${id}-title`}>アクセス許可</AuthSheetTitle>
      {view.ok ? (
        <>
          <div className="mt-section font-base text-sm leading-tight wrap-anywhere">
            <p className="font-semibold text-neutral-900">{view.clientName}</p>
            <p className="mt-xs text-xs text-neutral-600">
              {view.email} として接続
            </p>
          </div>
          <section aria-labelledby={`${id}-allowed`} className={BLOCK_CLASS}>
            <SectionLabel id={`${id}-allowed`}>許可される操作</SectionLabel>
            <RowList>
              {ALLOWED_OPERATIONS.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-md py-row font-base text-sm leading-tight text-neutral-900"
                >
                  <span className={GLYPH_CLASS}>
                    <Icon name="check" size="md" />
                  </span>
                  <span className="min-w-[0] flex-1">{item}</span>
                </li>
              ))}
            </RowList>
          </section>
          <section aria-labelledby={`${id}-denied`} className={BLOCK_CLASS}>
            <SectionLabel id={`${id}-denied`}>できないこと</SectionLabel>
            <ul className="flex flex-col gap-md">
              {DENIED_OPERATIONS.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-md font-base text-sm leading-tight text-neutral-700"
                >
                  <span className={GLYPH_CLASS}>
                    <Icon name="minus" size="sm" />
                  </span>
                  <span className="min-w-[0] flex-1">{item}</span>
                </li>
              ))}
            </ul>
          </section>
          <form
            className="mt-section flex flex-col gap-md"
            action={act}
            aria-busy={pending}
            aria-label="アクセス許可の決定"
          >
            {error === null ? null : <FormError>{error}</FormError>}
            <DecisionButtons />
          </form>
        </>
      ) : (
        <div className="mt-section">
          <FormError>{INVALID_REQUEST_MESSAGE}</FormError>
        </div>
      )}
    </section>
  );
}
