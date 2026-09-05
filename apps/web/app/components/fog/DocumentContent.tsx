import type { HumanActor } from "@repo/core/application/fog/types";
import { serverData } from "@/presentation/serverAction";
import { DocumentEditor } from "./DocumentEditor";
import { DocumentHistoryContent } from "./DocumentHistoryContent";
import { DocumentView } from "./DocumentView";

const loadDocument = serverData(
  () => import("@repo/core/application/fog/runtime"),
  async (_context, { getFogServices }, actor: HumanActor, id: string) =>
    getFogServices().getDocument(actor, id),
);
const loadTopic = serverData(
  () => import("@repo/core/application/fog/runtime"),
  async (_context, { getFogServices }, actor: HumanActor, id: string) =>
    getFogServices().getTopic(actor, id),
);
const loadHistory = serverData(
  () => import("@repo/core/application/fog/runtime"),
  async (_context, { getFogServices }, actor: HumanActor, id: string) =>
    getFogServices().documentHistory(actor, id),
);

export async function DocumentContent({
  actor,
  id,
  mode,
}: {
  actor: HumanActor;
  id: string;
  mode: "new" | "view" | "edit" | "history";
}) {
  if (mode === "new") {
    const { topic } = await loadTopic(actor, id);
    return <DocumentEditor context={{ mode: "new", topic }} />;
  }
  const document = await loadDocument(actor, id);
  if (mode === "history")
    return (
      <DocumentHistoryContent
        document={document}
        revisions={await loadHistory(actor, id)}
      />
    );
  if (mode === "edit")
    return <DocumentEditor context={{ mode: "edit", document }} />;
  return <DocumentView document={document} />;
}
