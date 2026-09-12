# brief — fog を spec/ から実装する

- 元の指示: ユーザーの `/spec-implement`（引数なし。2026-09-08 01:20 JST 開始）。`spec/` 全体を対象に、実装から動作検証まで Manager Loop で完了させる
- 作業ディレクトリ: `.spec-implement/`（初回の実行。別依頼の記録なし）
- ブランチ: `feat/spec-implement`（`main` から分岐。完了候補ごとにコミット）

## 対象範囲

`spec/index.md` が列挙する成果物のうち、実装対象は次のとおり。`spec/` の本文は複製しない。

| 領域 | 参照先 | 内容 |
|---|---|---|
| 要件 | `spec/requirements.md` | 4.1〜4.5 機能要件、5.1〜5.3 非機能要件 |
| シナリオ | `spec/scenario/*.md` | S-AC-01〜07 / S-TL-01〜07 / S-DT-01〜09 / S-SE-01〜03 / S-TR-01〜05 / S-AI-01〜06 / S-ST-01〜02 の 39 シナリオ |
| 画面 | `spec/pages/index.md`, `spec/design/` | P-01〜P-14 の 14 画面。デザインは `spec/design/pages/*.html` と `spec/design/tokens.md` に従う |
| ドメイン | `spec/domains/*.md` | identity / memo / knowledge / search / trash / export |
| ユースケース | `spec/usecases/*.md` | 55 ユースケース（★ = 人間 UI 専用、AI API 用は MCP / REST） |
| 永続化 | `spec/database/index.md` | User Data DO 17 表、Identity Directory DO 7 表、lazy migration、OCC、FTS5 |
| 非同期 | `spec/async/index.md` | 同期実行 / Outbox event / local job の全数表（jobs 11 種、event 1 種） |
| 鍵ローテーション | `spec/rotation/index.md` | 写像鍵の移送とメール暗号鍵の再暗号化 |
| 回収 | `spec/recovery/index.md` | cross-DO saga の終端モードと後始末 |
| テスト | `spec/testcases/**`, `spec/manual-tests/*.md` | 984 ケース、マニュアルテスト 208 ケース |
| ADR | `spec/adr/*.md` | 001 / 002 / 003 / 004 / 006 |

### 対象外

- 退会（withdrawal）の開始ユースケース: `spec/async/index.md` が「退会 saga 自身が `operations` に手続きを記録するかどうかは本 spec の範囲外」と述べ、シナリオ・ユースケースに退会が無い。`finalize-withdrawal` ジョブは新規登録 saga の放棄経路（`spec/recovery/index.md` 段 S2）としてのみ実装する
- 本番 / ステージングへのデプロイと Pulumi の適用（自走の指示は公開・デプロイの許可を増やさない）
- AI の振る舞い（プロンプト・エージェント設計）と会話ログ（requirements スコープ外）
- 共有・コラボレーション（requirements 5.1）

### 優先度と譲れない業務ルール

- 先に主要シナリオを端から端まで動かす: 登録 → ログイン → メモ投稿 → タイムライン表示（walking skeleton）
- 譲れないルール（`spec/requirements.md` 4.3 / 4.5, `spec/domains/identity.md` TokenScope）: ハードデリート・ゴミ箱操作・履歴閲覧は AI スコープに存在しない。二層（`UserActor` 型限定 + 配線分離／許可リスト）で構造的に保証する
- 全ドメインポートは同期契約。非同期は `PasswordHasher` / `MailSender` の 2 つだけ（`spec/domains/index.md`）
- 書き込みは 1 つの `transactionSync`。本体・FTS5 projection・outbox 行が同時に確定する
- OCC 競合は再試行しない。`jobs.kind` / `event.type` は `spec/async/index.md` の全数表にしか現れない

## プロジェクトの制約

- `CLAUDE.md` のアーキテクチャ（Hexagonal + DDD、レイヤー境界、エラー契約、Cross-layer catch policy、非同期実行契約）に従う
- 完成を確かめる実行環境: ローカル。`pnpm dev`（vite + workerd、`http://localhost:3000`）と `pnpm preview`、`pnpm typecheck && pnpm lint:fix && pnpm format`、`pnpm test`（unit / dom / integration = Miniflare の DO）
- `README.md` によると `pnpm start`（`wrangler dev`）は TanStack Start の仮想モジュール未解決で起動しない（#73）。ブラウザ検証は `pnpm dev` を用いる
- 既存コード: `packages/core` の DO 基盤（`durableObjectBase` / `jobRunner` / `outboxRelay` / `migrationGate` / stores / crypto）、`application/{errors,ports,delivery,execution,di}`、`domain/{error,common}`、`lib/`、`apps/web/app/presentation/*` を前提に再利用する。集約ストア・ゲートウェイ・DO クラス・ユースケース・ドメイン層は未実装で、それらを名指すインポートは未解決（コミット 3f7c501）
- `docs/test.md` / `docs/*.md` は前回ビルドの状態を記述しており、存在しないファイルを参照する箇所がある。実装が追いついた時点で docs を現状に合わせる（`CLAUDE.md`「gap は docs に記録しない」）

## 外部依存と検証段階

利用者の回答は得られない前提で進める（自律実行）。回答が来た依存は段階を更新する。

| 依存 | 段階 | 根拠・条件 |
|---|---|---|
| SSO（Google / Apple 等の IdP） | 契約検証 | `SsoProvider` ポートに対する開発用アダプター（ローカルで認可コード往復を模擬）でシナリオを通す。実 IdP のクライアント ID / secret があるときだけ動く契約テストを実アダプターに置く |
| メール送信（`MAIL_PROVIDER_API_KEY`） | 契約検証 | `MailSender` の開発用アダプター（送信内容をログ / ローカルファイルへ出す）で S-AC-07 を通す。provider 実アダプターは資格情報がある場合のみ実行する契約テスト |
| AI クライアント（LLM アプリ。OAuth 2.1 + MCP / REST） | 契約検証 | 外部の LLM アプリは接続できない。ローカルのテストクライアント（スクリプト）で認可コードフロー → トークン → MCP / REST 呼び出しを実行して S-AI-* / S-SE-03 を通す |
| Cloudflare Queue / DO / Alarm | 実接続（ローカル） | Miniflare（`pnpm dev` / vitest-pool-workers）が実装を提供する。本番環境は対象外 |
| Cloudflare 本番デプロイ | 対象外 | 上記のとおり |

## 採用する仮定

- A-01: 実装対象は `spec/` の全域。ユーザーは範囲を限定していない
- A-02: SSO / メール / AI クライアントは契約検証で受け入れる。実接続の検証手順は `plan.md` に残す
- A-03: 検証環境はローカル（`pnpm dev` + ブラウザ、`pnpm test`）。ブラウザ操作は Verifier が agent-browser 等で行う
- A-04: 前回ビルドの `docs/` に書かれた実装済みファイル名は今回の実装の指示ではなく、`spec/` と `CLAUDE.md` を優先する
- A-05: `.spec-implement/` と `.claude/` はコミットしない（進捗記録は Git 外の作業ファイル）。コミットは触ったパスを明示して行う

## 未決事項

- Q-01: SSO の実 IdP / メール provider / 本番デプロイの実接続検証を行うか（資格情報の提供が要る）。回答があるまで契約検証で進める
