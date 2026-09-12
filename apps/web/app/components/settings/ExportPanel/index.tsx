"use client";

import { Link } from "@tanstack/react-router";
import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { Icon } from "@/components/ui/Icon";
import { Row } from "@/components/ui/Row";
import { RowError } from "@/components/ui/RowError";
import { renderErrorMessage } from "@/presentation/errorDisplay";
import type { SerializedError } from "@/presentation/errorResponse";
import { isRecord } from "@/presentation/serverFnResult";
import { ItemDescription, ItemName } from "../SettingsSection";

export const EXPORT_ACTION = "/export";
export const EXPORT_DESCRIPTION = "Markdown形式。ゴミ箱・履歴は含まれません";
export const UNAUTHENTICATED_MESSAGE =
  "ログインし直してください。セッションが切れています";

type Phase =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "generating" }>
  | Readonly<{ kind: "done"; url: string; filename: string }>
  | Readonly<{ kind: "error"; message: string; unauthenticated: boolean }>;

/** The browser's own zone; `UTC` on the server so the markup hydrates unchanged. */
function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function filenameOf(response: Response, fallback: string): string {
  const header = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? fallback;
}

async function failureOf(response: Response): Promise<SerializedError> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.error)) {
      const error = body.error;
      if (typeof error.kind === "string" && typeof error.message === "string") {
        return {
          kind: error.kind,
          code: typeof error.code === "string" ? error.code : null,
          message: error.message,
          retryable: false,
        } as SerializedError;
      }
    }
  } catch {
    // not JSON: fall through to the generic wording
  }
  return {
    kind: "system",
    code: null,
    message: "System error",
    retryable: false,
  };
}

/** Hands the zip to the browser's own save through a throwaway `<a download>`. */
function save(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
}

/**
 * P-13's export row (S-ST-02, `spec/design/pages/settings.html`): idle →
 * 生成中 → the zip. The form posts to `/export` on its own with scripting
 * off; with it, the submit is a `fetch` so the row can show 「生成中…」, the
 * response becomes a Blob that is saved once and stays offered as
 * 「ダウンロード」 while the screen is open. A failure stays under the row
 * with 「リトライ」; a lost session instead names the login that brings the
 * user back here. The zone travels as a hidden input.
 */
export function ExportPanel() {
  const form = useRef<HTMLFormElement>(null);
  const [timezone, setTimezone] = useState("UTC");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [, startTransition] = useTransition();

  useEffect(() => {
    setTimezone(browserTimezone());
  }, []);

  useEffect(() => {
    if (phase.kind !== "done") return;
    const { url } = phase;
    return () => URL.revokeObjectURL(url);
  }, [phase]);

  const run = (target: HTMLFormElement) => {
    setPhase({ kind: "generating" });
    startTransition(async () => {
      try {
        const response = await fetch(target.action, {
          method: "POST",
          body: new FormData(target),
          credentials: "same-origin",
        });
        if (!response.ok) {
          const failure = await failureOf(response);
          setPhase({
            kind: "error",
            message:
              response.status === 401
                ? UNAUTHENTICATED_MESSAGE
                : renderErrorMessage(failure),
            unauthenticated: response.status === 401,
          });
          return;
        }
        const blob = await response.blob();
        const filename = filenameOf(response, "fog-export.zip");
        const url = URL.createObjectURL(blob);
        save(url, filename);
        setPhase({ kind: "done", url, filename });
      } catch {
        setPhase({
          kind: "error",
          message: "システムエラーが発生しました",
          unauthenticated: false,
        });
      }
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(event.currentTarget);
  };

  return (
    <form
      ref={form}
      method="post"
      action={EXPORT_ACTION}
      onSubmit={onSubmit}
      aria-label="データのエクスポート"
      aria-busy={phase.kind === "generating"}
    >
      <input type="hidden" name="timezone" value={timezone} />
      <Row
        actions={
          phase.kind === "generating" ? (
            <span
              role="status"
              className="flex items-center gap-sm whitespace-nowrap text-sm text-neutral-600"
            >
              <Icon name="spinner" size="sm" />
              生成中…
            </span>
          ) : phase.kind === "done" ? (
            <Button
              variant="fill-sm"
              onClick={() => save(phase.url, phase.filename)}
            >
              ダウンロード
            </Button>
          ) : (
            <Button variant="fill-sm" type="submit">
              エクスポート
            </Button>
          )
        }
        error={
          phase.kind !== "error" ? undefined : phase.unauthenticated ? (
            <FormError>
              {phase.message}{" "}
              <Link to="/login" search={{ redirect: "/settings" }}>
                ログインする
              </Link>
            </FormError>
          ) : (
            <RowError
              message={phase.message}
              retry={{
                label: "リトライ",
                onRetry: () => {
                  if (form.current !== null) run(form.current);
                },
              }}
            />
          )
        }
      >
        <ItemName>エクスポート</ItemName>
        <ItemDescription>{EXPORT_DESCRIPTION}</ItemDescription>
      </Row>
    </form>
  );
}
