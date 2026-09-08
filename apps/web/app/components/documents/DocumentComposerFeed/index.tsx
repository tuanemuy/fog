import { KnowledgeNotFound } from "@/components/knowledge/KnowledgeNotFound";
import { extractSerializedError } from "@/presentation/errorResponse";
import { guardStreamedRender } from "@/presentation/errorResponseMiddleware";
import { serverData } from "@/presentation/serverAction";
import { DocumentEditor } from "../DocumentEditor";

const loadTopicName = serverData(
  () => import("@repo/core/application/knowledge/getTopicName"),
  async ({ container }, { getTopicName }, userId: string, topicId: string) =>
    getTopicName({ container, input: { userId, topicId } }),
);

/**
 * The streamed leaf of `/topics/:id/documents/new` (P-09, create mode).
 * The topic name is also the check that the topic exists outside the trash.
 */
export async function DocumentComposerFeed({ topicId }: { topicId: string }) {
  let topic: Awaited<ReturnType<typeof loadTopicName>>;
  try {
    topic = await guardStreamedRender(async () => {
      const { requireUserId } = await import("@/presentation/currentUser");
      const userId = await requireUserId();
      return loadTopicName(userId, topicId);
    });
  } catch (error) {
    if (extractSerializedError(error).kind === "notFound") {
      return <KnowledgeNotFound subject="トピック" />;
    }
    throw error;
  }
  return (
    <DocumentEditor
      key={topic.topicId}
      mode="create"
      topicId={topic.topicId}
      topicName={topic.name}
    />
  );
}
