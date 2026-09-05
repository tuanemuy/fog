# フロントエンド実装

`timeline.tsx` の loader は `renderFogTimeline` が返す server component promise を待たずに渡し、`Suspense` と `Deferred` で fragment を配信する。URL の形は `validateSearch`、server function の入力は `inputValidator` で検査する。内部の `serverData` に未検証 HTTP 入力を渡さない。

`TimelineBoard` がメモ一覧を所有し、追加・削除を `useOptimistic` と `useTransition` で処理する。削除で unmount する `MemoItem` に一覧 membership と失敗表示を持たせない。項目内の編集は item owner が保持する。成功後は `router.invalidate()` で最新 loader と同期する。

`DocumentEditor`・`PasswordChangeForm` は `useActionState` の pending / error を表示する。入力を送る server function だけを form に直結してフィードバックを省かない。確認を伴う不可逆操作は `ConfirmDialog` と親の状態で処理する。

共通 navigation は `FogShell`、fragment skeleton は `TimelineSkeleton`、block する navigation の fallback は `RoutePendingFallback`。SSR の streaming と mutation 後の pending は異なる役割を持つ。

server function は `.handler(...)` を入口に宣言し、core/adapter への import を handler の動的 import に置く。framework が client RPC に変換する境界を保ち、秘密設定と Node adapter を browser bundle に流さない。
