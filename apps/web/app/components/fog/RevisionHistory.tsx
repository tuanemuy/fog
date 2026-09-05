"use client";

import type {
  DocumentRevisionView,
  MemoRevisionView,
} from "@repo/core/application/fog/types";
import { diffLines } from "diff";
import { useMemo, useState, useTransition } from "react";
import { displayError } from "@/presentation/errorDisplay";
import { Markdown } from "./Markdown";

type Revision = MemoRevisionView | DocumentRevisionView;
const timestamp = (value: string) =>
  new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
const text = (revision: Revision) =>
  "title" in revision
    ? `# ${revision.title}\n\n${revision.body}`
    : revision.body;

export function RevisionHistory({
  kind,
  id: _id,
  revisions,
  currentVersion,
  onRollback,
  backHref,
}: {
  kind: "memo" | "document";
  id: string;
  revisions: Revision[];
  currentVersion: number;
  onRollback: (version: number, expectedVersion: number) => Promise<void>;
  backHref: string;
}) {
  const newest = revisions[0];
  const [selected, setSelected] = useState(newest?.version ?? 1);
  const [from, setFrom] = useState(
    revisions[1]?.version ?? newest?.version ?? 1,
  );
  const [to, setTo] = useState(newest?.version ?? 1);
  const [comparing, setComparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const active =
    revisions.find((revision) => revision.version === selected) ?? newest;
  const before = revisions.find((revision) => revision.version === from);
  const after = revisions.find((revision) => revision.version === to);
  const changes = useMemo(() => {
    if (!before || !after) return undefined;
    const difference = diffLines(text(before), text(after), { timeout: 1000 });
    let beforeLine = 0;
    let afterLine = 0;
    return difference?.map((change) => {
      const key = `${beforeLine}:${afterLine}`;
      if (!change.added) beforeLine += change.count;
      if (!change.removed) afterLine += change.count;
      return { ...change, key };
    });
  }, [before, after]);
  if (!active) return <p>履歴が見つかりません。</p>;
  return (
    <section
      className="fog-history"
      aria-label={`${kind === "memo" ? "メモ" : "ドキュメント"}の編集履歴`}
      aria-busy={pending}
    >
      <div className="fog-section-heading">
        <a href={backHref}>← 内容に戻る</a>
        <span>{revisions.length}件の履歴</span>
      </div>
      <ol className="fog-revision-list">
        {revisions.map((revision) => (
          <li key={revision.version}>
            <button
              type="button"
              onClick={() => {
                setSelected(revision.version);
                setComparing(false);
                setConfirming(false);
              }}
              className={
                selected === revision.version && !comparing
                  ? "fog-revision-selected"
                  : ""
              }
              aria-pressed={selected === revision.version && !comparing}
            >
              <strong>
                版 {revision.version}
                {revision.version === currentVersion ? " · 最新" : ""}
              </strong>
              <time dateTime={revision.createdAt}>
                {timestamp(revision.createdAt)}
              </time>
              <span>
                {revision.actor.kind === "ai" ? "AI · " : ""}
                {revision.actor.name}
              </span>
              {"reason" in revision && <span>{revision.reason}</span>}
            </button>
          </li>
        ))}
      </ol>
      {revisions.length > 1 && (
        <div className="fog-history-compare">
          <label>
            比較元
            <select
              value={from}
              onChange={(event) => setFrom(Number(event.target.value))}
            >
              {revisions.map((revision) => (
                <option value={revision.version} key={revision.version}>
                  版 {revision.version}
                </option>
              ))}
            </select>
          </label>
          <span aria-hidden="true">→</span>
          <label>
            比較先
            <select
              value={to}
              onChange={(event) => setTo(Number(event.target.value))}
            >
              {revisions.map((revision) => (
                <option value={revision.version} key={revision.version}>
                  版 {revision.version}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="fog-secondary"
            disabled={from === to}
            onClick={() => setComparing(true)}
          >
            差分を表示
          </button>
        </div>
      )}
      {comparing && before && after ? (
        <section className="fog-diff" aria-label={`版${from}と版${to}の差分`}>
          <h2>
            版 {from} → 版 {to}
          </h2>
          <p className="fog-hint">追加は＋、削除は−で表示しています。</p>
          {changes ? (
            <pre>
              {changes.map((change) =>
                change.added ? (
                  <ins key={change.key}>＋ {change.value}</ins>
                ) : change.removed ? (
                  <del key={change.key}>− {change.value}</del>
                ) : (
                  <span key={change.key}> {change.value}</span>
                ),
              )}
            </pre>
          ) : (
            <>
              <p>長い内容のため、比較元と比較先を表示します。</p>
              <pre>{text(before)}</pre>
              <pre>{text(after)}</pre>
            </>
          )}
        </section>
      ) : (
        <section
          className="fog-revision-preview"
          aria-label={`版${active.version}の内容`}
        >
          <h2>{"title" in active ? active.title : `版 ${active.version}`}</h2>
          <Markdown body={active.body} compact={kind === "memo"} />
        </section>
      )}
      {error && (
        <p role="alert" className="fog-error">
          {error}
        </p>
      )}
      {!comparing &&
        revisions.length > 1 &&
        active.version !== currentVersion && (
          <div className="fog-rollback">
            {confirming ? (
              <>
                <p>
                  版 {active.version}{" "}
                  の内容を新しい版として保存します。今までの履歴も残ります。
                </p>
                <button
                  type="button"
                  className="fog-primary"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      try {
                        await onRollback(active.version, currentVersion);
                      } catch (failure) {
                        setError(displayError(failure));
                        setConfirming(false);
                      }
                    })
                  }
                >
                  {pending ? "復元中…" : "この版に戻す"}
                </button>
                <button
                  type="button"
                  className="fog-text-button"
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                >
                  キャンセル
                </button>
              </>
            ) : (
              <button
                type="button"
                className="fog-secondary"
                onClick={() => setConfirming(true)}
              >
                この内容に戻す
              </button>
            )}
          </div>
        )}
    </section>
  );
}
