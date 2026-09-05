"use client";
import type { CredentialView } from "@repo/core/application/fog/accountTypes";
import type { AiConnectionView } from "@repo/core/application/fog/aiTypes";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useOptimistic, useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { exportFogData, saveFogRetention } from "@/presentation/fogDataActions";
import { AiConnectionsPanel } from "./AiConnectionsPanel";
import { CredentialsPanel } from "./CredentialsPanel";
import { PasswordChangeForm } from "./PasswordChangeForm";

export function SettingsPanel({
  settings,
  connections,
  credentials,
  googleEnabled,
}: {
  settings: { retentionDays: number };
  connections: AiConnectionView[];
  credentials: CredentialView;
  googleEnabled: boolean;
}) {
  const router = useRouter();
  const save = useServerFn(saveFogRetention);
  const download = useServerFn(exportFogData);
  const [days, setDays] = useState(String(settings.retentionDays));
  const [shown, optimistic] = useOptimistic(settings.retentionDays);
  const [result, action, pending] = useActionState<
    { error: string | null; saved: boolean },
    FormData
  >(
    async () => {
      const retentionDays = Number(days);
      if (
        !Number.isInteger(retentionDays) ||
        retentionDays < 1 ||
        retentionDays > 3650
      )
        return {
          error: "保持期限は1〜3650日の整数で入力してください。",
          saved: false,
        };
      optimistic(retentionDays);
      try {
        await save({ data: { retentionDays } });
        await router.invalidate();
        return { error: null, saved: true };
      } catch (failure) {
        return { error: displayError(failure), saved: false };
      }
    },
    { error: null, saved: false },
  );
  const [exporting, startExport] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  return (
    <section className="fog-content" aria-label="設定とデータ管理">
      <h2>設定とデータ管理</h2>
      <CredentialsPanel
        credentials={credentials}
        googleEnabled={googleEnabled}
      />
      {credentials.hasPassword && <PasswordChangeForm />}
      <AiConnectionsPanel connections={connections} />
      <form
        action={action}
        className="fog-settings-section"
        aria-busy={pending}
      >
        <h3>ゴミ箱の保持期限</h3>
        <p className="fog-hint">
          現在の保持期限は{shown}
          日です。変更はゴミ箱にある項目にも適用されます。期限を短くすると、次の自動削除で対象の項目が完全に消えます。
        </p>
        <label htmlFor="retention-days">削除から保持する日数</label>
        <div className="fog-actions">
          <input
            id="retention-days"
            type="number"
            min={1}
            max={3650}
            step={1}
            required
            value={days}
            onChange={(event) => setDays(event.target.value)}
            disabled={pending}
          />
          <span>日</span>
          <button type="submit" className="fog-primary" disabled={pending}>
            {pending ? "保存中…" : "保存"}
          </button>
        </div>
        {result.error && (
          <p className="fog-error" role="alert">
            {result.error}
          </p>
        )}
        <p role="status" className="fog-hint">
          {result.saved && !pending ? "保持期限を保存しました。" : ""}
        </p>
      </form>
      <section className="fog-settings-section" aria-busy={exporting}>
        <h3>データのエクスポート</h3>
        <p>
          メモ・ドキュメント・トピックの最新データをJSONファイルで保存します。完了済みのトピックを含み、ゴミ箱とリビジョン履歴は含みません。
        </p>
        <button
          type="button"
          className="fog-secondary"
          disabled={exporting}
          onClick={() =>
            startExport(async () => {
              setExportError(null);
              setDownloaded(false);
              try {
                const data = await download({ data: {} });
                const blob = new Blob([JSON.stringify(data, null, 2)], {
                  type: "application/json;charset=utf-8",
                });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `fog-export-${data.exportedAt.slice(0, 10)}.json`;
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 60000);
                setDownloaded(true);
              } catch (failure) {
                setExportError(displayError(failure));
              }
            })
          }
        >
          {exporting ? "生成中…" : "データをエクスポート"}
        </button>
        {exportError && (
          <p className="fog-error" role="alert">
            {exportError}
          </p>
        )}
        <p role="status" className="fog-hint">
          {downloaded ? "ダウンロードを開始しました。" : ""}
        </p>
      </section>
    </section>
  );
}
