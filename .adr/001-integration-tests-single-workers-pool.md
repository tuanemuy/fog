# 001. 統合テストを Workers プール1本に集約する

## ステータス

承認済み

## コンテキスト

このリポジトリの統合テストは、長らく2つの vitest プールに分かれていた。

- `vitest.config.integration.ts` — `@cloudflare/vitest-pool-workers` による Workers プール。Miniflare の `env.DB`（インメモリ D1）を使う。
- `vitest.config.integration.node.ts` — Node プール。include は libSQL アダプター / Node アダプター / Node worker runner の3ディレクトリのみ。

分割の理由は libSQL 固有の事情だった。`@libsql/client` は Node のネイティブモジュール（`libsql`）を要求するため、workerd のアイソレート内では動かせない。両者は `*.integration.test.ts` というファイル名サフィックスを共有していたので、Workers 側の設定には「libSQL / Node のサブツリーを exclude する」という打ち消しの記述も必要だった。

本番構成を Cloudflare Workers 単独へ集約する方針に伴い、Node / AWS / GCP ランタイムと libSQL アダプターを撤去した。これにより Node プール設定の include 対象が全滅し、設定ファイルが空の器として残る状態になった。ここで「空の設定ファイルを将来の受け皿として温存するか、消すか」を決める必要が生じた。

## 決定

`vitest.config.integration.node.ts` を削除し、統合テストのプールを Workers プール1本にする。

- `pnpm test:integration` は `vitest.config.integration.ts`（Workers プール）だけを実行する。
- `vitest.config.integration.ts` の `exclude` から libSQL / Node サブツリーの打ち消し3行と、その理由を説明するコメントブロックを削除する。`exclude` は `node_modules` / `dist` / `.direnv` の汎用3件に戻す。
- CI の integration ジョブと build ジョブから、ランタイムを回していた matrix を撤去して単一ジョブにする。
- ユニットテスト用の `vitest.config.ts`（Node プール、`*.integration.test.ts` を exclude）は無変更で残す。

「将来 Workers アイソレートで動かせない統合テストが出るかもしれない」という理由で、空の Node プール設定を先回りで残すことはしない。

## 検討した代替案

**空の Node プール統合設定を残す** — include が空のまま `vitest.config.integration.node.ts` を温存し、Workers アイソレートで動かせない統合テストが必要になったときの受け皿にする案。採らなかった理由は次の3点。

1. 分割の理由（libSQL のネイティブモジュール）が消えたのに設定だけ残ると、「なぜあるのか」を説明できない死んだ設定になる。理由が消えたら設定も消す、という対応関係を保つほうが読み手に対して誠実である。
2. 永続化は今後さらに Cloudflare 側（Workers プール + DO SQLite）へ寄っていくため、Node プールの統合テストが再び必要になる見込みが薄い。
3. 退路がある。ユニットテスト用の `vitest.config.ts` が Node プール設定として現役なので、必要になった時点でそれを雛形に再作成すればよい。実コストは設定ファイル1本分にとどまる。

**Workers 設定の `exclude` だけ残す** — 打ち消しの exclude 行を保険として残す案も、同様に「何を打ち消しているのか」を説明できるコードが消えるため採らなかった。

## 影響

- 統合テストの実行経路が1本になり、`docs/test.md` の「2つのプール」という説明も1本に単純化された。CI の integration matrix / build matrix も畳めた。
- Workers 設定から打ち消しの `exclude` が消えた代わりに、`include` を「ディレクトリの明示的な許可リスト」として運用する方針が前面に出た。サフィックスだけでは拾われないため、新しいディレクトリに統合テストを置くときは同じ変更で `include` に追記する必要がある（この運用ルールは `vitest.config.integration.ts` 冒頭のコメントと `docs/test.md` に記載）。
- Workers アイソレートで動かせない統合テストが将来必要になった場合、Node プール設定を書き直す必要がある。`vitest.config.ts` が雛形になるため実コストは小さい。
- `pnpm test:integration` と `pnpm test:integration:cf` が同義になり、名前としては冗長な状態が残る。スクリプト名の整理は Cloudflare 向けスクリプト再編（Issue #37）に委ねている。**#37 で解消済み** — `test:integration:cf` を削除し、`pnpm test:integration` の1本にした。
- **本 ADR の射程は統合テストであり、その後に第3のスイートが加わった。** #37 が起動スモークテスト（`vitest.config.smoke.ts` / `pnpm test:smoke`）を別レイヤーとして置いている。これは Node プールで miniflare に `scriptPath` を渡し、**ビルド成果物**が workerd で起動するかだけを問うもので、「アイソレートへ import したコードを検証する」統合テストとは問いが違う。したがって本 ADR の「Workers プール1本」は破られていない — スモークは統合テストではない。`docs/test.md` は3スイート構成として記述してある。
