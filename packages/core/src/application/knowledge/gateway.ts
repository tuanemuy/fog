import type { ActorDto, UserActorDto } from "../identity/actorDto";
import type {
  CreateDocumentView,
  DocumentDiffView,
  DocumentRevisionsView,
  DocumentView,
  EditDocumentByAiView,
  EditDocumentView,
  ReferencingDocumentsView,
  RollbackDocumentView,
  SourceMemosView,
  TopicDetailView,
  TopicListView,
  TopicNameView,
  TopicView,
  TrashTopicView,
} from "./view";

export type { ActorDto, UserActorDto };

export type CreateTopicDto = Readonly<{
  name: string;
  description: string | null;
}>;

/** An absent field is "leave it"; `description: null` removes it. */
export type UpdateTopicDto = Readonly<{
  topicId: string;
  name?: string;
  description?: string | null;
  archived?: boolean;
}>;

export type ListTopicsDto = Readonly<{ includeArchived: boolean }>;

export type CreateDocumentDto = Readonly<{
  actor: ActorDto;
  topicId: string;
  title: string;
  body: string;
  sourceMemoIds: readonly string[];
  /** `null` lets the application supply 「作成」. */
  changeReason: string | null;
}>;

export type EditDocumentByAiDto = Readonly<{
  actor: ActorDto;
  documentId: string;
  edit:
    | Readonly<{
        mode: "patch";
        patches: readonly Readonly<{ oldText: string; newText: string }>[];
      }>
    | Readonly<{ mode: "replaceAll"; body: string }>;
  /** Already checked non-blank on the request side; the value object rules apply inside. */
  changeReason: string;
}>;

export type EditDocumentDto = Readonly<{
  actor: UserActorDto;
  documentId: string;
  title: string;
  body: string;
  /** `null` lets the application supply 「手動編集」. */
  changeReason: string | null;
  expectedVersion: number;
}>;

export type RollbackDocumentDto = Readonly<{
  actor: UserActorDto;
  documentId: string;
  revisionNumber: number;
  /** `null` lets the application supply 「リビジョン{n}の内容に戻す」. */
  changeReason: string | null;
}>;

export type DiffDocumentRevisionsDto = Readonly<{
  documentId: string;
  baseRevisionNumber: number;
  targetRevisionNumber: number;
}>;

/** The request Worker's entry to the knowledge side of the User Data DO. */
export interface KnowledgeGateway {
  createTopic(userId: string, input: CreateTopicDto): Promise<TopicView>;
  updateTopic(userId: string, input: UpdateTopicDto): Promise<TopicView>;
  listTopics(userId: string, input: ListTopicsDto): Promise<TopicListView>;
  getTopic(userId: string, topicId: string): Promise<TopicDetailView>;
  getTopicName(userId: string, topicId: string): Promise<TopicNameView>;
  trashTopic(userId: string, topicId: string): Promise<TrashTopicView>;
  createDocument(
    userId: string,
    input: CreateDocumentDto,
  ): Promise<CreateDocumentView>;
  editDocument(
    userId: string,
    input: EditDocumentDto,
  ): Promise<EditDocumentView>;
  /** MCP `edit_document`: patch or replaceAll, reason required. */
  editDocumentByAi(
    userId: string,
    input: EditDocumentByAiDto,
  ): Promise<EditDocumentByAiView>;
  rollbackDocument(
    userId: string,
    input: RollbackDocumentDto,
  ): Promise<RollbackDocumentView>;
  trashDocument(userId: string, documentId: string): Promise<void>;
  getDocument(userId: string, documentId: string): Promise<DocumentView>;
  listDocumentRevisions(
    userId: string,
    documentId: string,
  ): Promise<DocumentRevisionsView>;
  diffDocumentRevisions(
    userId: string,
    input: DiffDocumentRevisionsDto,
  ): Promise<DocumentDiffView>;
  listDocumentSourceMemos(
    userId: string,
    documentId: string,
  ): Promise<SourceMemosView>;
  listDocumentsReferencingMemo(
    userId: string,
    memoId: string,
  ): Promise<ReferencingDocumentsView>;
}
