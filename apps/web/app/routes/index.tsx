import { createFileRoute } from "@tanstack/react-router";
import { sanitizeRouteError } from "@/presentation/errorDisplay";
import { buildHead } from "@/presentation/head";

export const Route = createFileRoute("/")({
  head: ({ match }) => {
    const config = match.context?.config;
    if (!config) return {};
    const { meta, links } = buildHead(config, { path: "/" });
    return { meta, links };
  },
  component: LandingPage,
  errorComponent: ({ error }) => (
    <div role="alert">
      <h1>エラーが発生しました</h1>
      <pre>{sanitizeRouteError(error)}</pre>
    </div>
  ),
});

function LandingPage() {
  return (
    <main>
      <h1>fog</h1>
      <p>雑に記録し、AIが整理するメモアプリ。</p>
    </main>
  );
}
