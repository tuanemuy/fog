import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";

const renderSettings = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .handler(async () => {
    const { CurrentUserPanel } = await import(
      "@/components/settings/CurrentUserPanel"
    );
    return { Panel: await renderServerComponent(<CurrentUserPanel />) };
  });

export const Route = createFileRoute("/_app/settings")({
  loader: () => renderSettings(),
  component: SettingsPage,
});

function SettingsPage() {
  const { Panel } = Route.useLoaderData();
  return Panel;
}
