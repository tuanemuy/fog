import type { RpcEnvelope } from "@repo/core/application/delivery/types";
import type { UserDataUnitOfWorkContext } from "@repo/core/application/execution/unitOfWork";
import { changeTrashRetentionDaysProcedure } from "@repo/core/application/identity/changeTrashRetentionDays";
import type {
  CredentialLocatorDto,
  CurrentUserDto,
  InitializeAccountDto,
  RecordSignupLocatorDto,
} from "@repo/core/application/identity/gateway";
import { initializeAccountProcedure } from "@repo/core/application/identity/initializeAccount";
import { readCurrentUserProcedure } from "@repo/core/application/identity/readCurrentUser";
import { fromCredentialLocator } from "@repo/core/application/identity/rebuild";
import { recordSignupLocatorProcedure } from "@repo/core/application/identity/recordSignupLocator";
import { createDocumentProcedure } from "@repo/core/application/knowledge/createDocument";
import { createTopicProcedure } from "@repo/core/application/knowledge/createTopic";
import { diffDocumentRevisionsProcedure } from "@repo/core/application/knowledge/diffDocumentRevisions";
import { editDocumentProcedure } from "@repo/core/application/knowledge/editDocument";
import type {
  CreateDocumentDto,
  CreateTopicDto,
  DiffDocumentRevisionsDto,
  EditDocumentDto,
  ListTopicsDto,
  RollbackDocumentDto,
  UpdateTopicDto,
} from "@repo/core/application/knowledge/gateway";
import { getDocumentProcedure } from "@repo/core/application/knowledge/getDocument";
import { getTopicProcedure } from "@repo/core/application/knowledge/getTopic";
import { getTopicNameProcedure } from "@repo/core/application/knowledge/getTopicName";
import { listDocumentRevisionsProcedure } from "@repo/core/application/knowledge/listDocumentRevisions";
import { listDocumentSourceMemosProcedure } from "@repo/core/application/knowledge/listDocumentSourceMemos";
import { listDocumentsReferencingMemoProcedure } from "@repo/core/application/knowledge/listDocumentsReferencingMemo";
import { listTopicsProcedure } from "@repo/core/application/knowledge/listTopics";
import { rollbackDocumentProcedure } from "@repo/core/application/knowledge/rollbackDocument";
import { trashDocumentProcedure } from "@repo/core/application/knowledge/trashDocument";
import { trashTopicProcedure } from "@repo/core/application/knowledge/trashTopic";
import { updateTopicProcedure } from "@repo/core/application/knowledge/updateTopic";
import type {
  CreateDocumentView,
  DocumentDiffView,
  DocumentRevisionsView,
  DocumentView,
  EditDocumentView,
  ReferencingDocumentsView,
  RollbackDocumentView,
  SourceMemosView,
  TopicDetailView,
  TopicListView,
  TopicNameView,
  TopicView,
  TrashTopicView,
} from "@repo/core/application/knowledge/view";
import { diffMemoRevisionsProcedure } from "@repo/core/application/memo/diffMemoRevisions";
import { editMemoProcedure } from "@repo/core/application/memo/editMemo";
import type {
  DiffRevisionsDto,
  EditMemoDto,
  JumpToDateDto,
  PostMemoDto,
  RollbackMemoDto,
  ShowMemoDto,
  TimelineQueryDto,
} from "@repo/core/application/memo/gateway";
import { getTimelineProcedure } from "@repo/core/application/memo/getTimeline";
import { jumpToDateProcedure } from "@repo/core/application/memo/jumpToDate";
import { listMemoRevisionsProcedure } from "@repo/core/application/memo/listMemoRevisions";
import { postMemoProcedure } from "@repo/core/application/memo/postMemo";
import { rollbackMemoProcedure } from "@repo/core/application/memo/rollbackMemo";
import { showMemoInTimelineProcedure } from "@repo/core/application/memo/showMemoInTimeline";
import { softDeleteMemoProcedure } from "@repo/core/application/memo/softDeleteMemo";
import type {
  EditMemoView,
  MemoRevisionsView,
  MemoView,
  MemoWindowView,
  RevisionDiffView,
  RollbackMemoView,
  TimelinePageView,
  TimelineWindowView,
} from "@repo/core/application/memo/view";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import type { SearchQueryDto } from "@repo/core/application/search/gateway";
import { searchProcedure } from "@repo/core/application/search/search";
import type { SearchOutputView } from "@repo/core/application/search/view";
import { emptyTrashInDurableObject } from "@repo/core/application/trash/emptyTrash";
import type {
  ListTrashDto,
  RestoreDocumentDto,
  TrashItemRefDto,
} from "@repo/core/application/trash/gateway";
import { hardDeleteTrashItemProcedure } from "@repo/core/application/trash/hardDeleteTrashItem";
import { listTrashProcedure } from "@repo/core/application/trash/listTrash";
import { restoreDocumentProcedure } from "@repo/core/application/trash/restoreDocument";
import { restoreMemoProcedure } from "@repo/core/application/trash/restoreMemo";
import { restoreTopicProcedure } from "@repo/core/application/trash/restoreTopic";
import type {
  EmptyTrashView,
  RestoreDocumentView,
  RestoreMemoView,
  RestoreTopicView,
  TrashListView,
} from "@repo/core/application/trash/view";
import type { AccountState } from "@repo/core/domain/identity/ports/accountStore";
import { CredentialId } from "@repo/core/domain/identity/valueObject";
import { rearm } from "./alarmSchedule";
import {
  AsyncWorkDurableObject,
  type StateWorkerEnv,
} from "./durableObjectBase";
import type { JobHandlerRegistry } from "./jobRunner";
import { createPurgeTrashHandler } from "./jobs/purgeTrash";
import { USER_DATA_PLAN } from "./schema/userDataPlan";
import { createUserDataUnitOfWorkProvider } from "./unitOfWork";

/**
 * One user's data. Every entry takes primitives, rebuilds the value objects
 * inside its unit of work and answers through the envelope. Only
 * `initializeAccount` may bring the object into existence
 * (`runInitializingUnitOfWork`); every other entry fails closed on an
 * uninitialised object.
 */
export class UserDataDurableObject extends AsyncWorkDurableObject<UserDataUnitOfWorkContext> {
  constructor(ctx: DurableObjectState, env: StateWorkerEnv) {
    const jobRegistry: JobHandlerRegistry = {};
    super(ctx, env, {
      plan: USER_DATA_PLAN,
      allowInitialize: false,
      clock: SystemClock,
      idGenerator: UuidV7Generator,
      logger: ConsoleLogger,
      jobRegistry,
    });
    // Filled after `super`: the handler needs this object's unit of work.
    jobRegistry["purge-trash"] = createPurgeTrashHandler({
      provider: () => this.createUnitOfWorkProvider(),
      logger: this.config.logger,
    });
  }

  protected createUnitOfWorkProvider() {
    return createUserDataUnitOfWorkProvider({
      storage: this.ctx.storage,
      clock: this.config.clock,
      idGenerator: this.config.idGenerator,
      selfLocator: this.requireSelfLocator(),
    });
  }

  /** Registration saga phase 2. The schema and the first rows commit together. */
  async initializeAccount(
    input: InitializeAccountDto,
  ): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      const userId = this.requireSelfLocator();
      const now = this.config.clock.now();
      await this.runInitializingUnitOfWork((ctx) => {
        initializeAccountProcedure(
          ctx,
          {
            userId,
            operationId: input.operationId,
            callerToken: input.callerToken,
            credentials: [input.credential],
            locators: input.locators,
          },
          now,
        );
        return undefined;
      });
    });
  }

  /** Registration saga phase 4. */
  async recordSignupLocator(
    input: RecordSignupLocatorDto,
  ): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      await this.runUnitOfWork((ctx) => {
        recordSignupLocatorProcedure(ctx, input);
        return undefined;
      });
    });
  }

  async readAccountState(): Promise<RpcEnvelope<AccountState | null>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => ctx.accountStore.find()),
    );
  }

  async findCredentialLocator(
    credentialId: string,
  ): Promise<RpcEnvelope<CredentialLocatorDto | null>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => {
        const locator = ctx.credentialLocatorStore.findByCredentialId(
          CredentialId.create(credentialId),
        );
        return locator === null ? null : fromCredentialLocator(locator);
      }),
    );
  }

  async readCurrentUser(): Promise<RpcEnvelope<CurrentUserDto | null>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => readCurrentUserProcedure(ctx)),
    );
  }

  async changeTrashRetentionDays(input: {
    retentionDays: number;
  }): Promise<RpcEnvelope<void>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      const tuning = this.tuning();
      return this.runUnitOfWork((ctx) => {
        changeTrashRetentionDaysProcedure(ctx, input.retentionDays, now, {
          chunkLimit: tuning.jobsMaxRowsPerChunk,
          maxChunks: tuning.jobsMaxChunkIterations,
        });
        return undefined;
      });
    });
  }

  async listTrash(input: ListTrashDto): Promise<RpcEnvelope<TrashListView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => listTrashProcedure(ctx, input)),
    );
  }

  async restoreMemo(memoId: string): Promise<RpcEnvelope<RestoreMemoView>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) =>
        restoreMemoProcedure(ctx, memoId, now),
      );
    });
  }

  async restoreDocument(
    input: RestoreDocumentDto,
  ): Promise<RpcEnvelope<RestoreDocumentView>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      const ids = {
        userId: this.requireSelfLocator(),
        newTopicId: this.config.idGenerator.next(),
      };
      return this.runUnitOfWork((ctx) =>
        restoreDocumentProcedure(ctx, input, ids, now),
      );
    });
  }

  async restoreTopic(topicId: string): Promise<RpcEnvelope<RestoreTopicView>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) =>
        restoreTopicProcedure(ctx, topicId, now),
      );
    });
  }

  async hardDeleteTrashItem(ref: TrashItemRefDto): Promise<RpcEnvelope<void>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => {
        hardDeleteTrashItemProcedure(ctx, ref);
        return undefined;
      }),
    );
  }

  /** One transaction per item (never nested), so a failure rolls back that item alone. */
  async emptyTrash(): Promise<RpcEnvelope<EmptyTrashView>> {
    return this.envelope(async () => {
      await this.enterRpc();
      const provider = this.createUnitOfWorkProvider();
      const result = emptyTrashInDurableObject(
        (fn) => provider.run(fn),
        this.config.logger,
      );
      if (provider.takeRearmRequest()) await rearm(this.ctx.storage);
      return result;
    });
  }

  async postMemo(input: PostMemoDto): Promise<RpcEnvelope<MemoView>> {
    return this.envelope(() => {
      const id = this.config.idGenerator.next();
      const now = this.config.clock.now();
      const userId = this.requireSelfLocator();
      return this.runUnitOfWork((ctx) =>
        postMemoProcedure(ctx, { ...input, userId }, id, now),
      );
    });
  }

  async getTimeline(
    query: TimelineQueryDto,
  ): Promise<RpcEnvelope<TimelinePageView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => getTimelineProcedure(ctx, query)),
    );
  }

  async jumpToDate(
    input: JumpToDateDto,
  ): Promise<RpcEnvelope<TimelineWindowView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => jumpToDateProcedure(ctx, input)),
    );
  }

  async showMemoInTimeline(
    input: ShowMemoDto,
  ): Promise<RpcEnvelope<MemoWindowView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => showMemoInTimelineProcedure(ctx, input)),
    );
  }

  async editMemo(input: EditMemoDto): Promise<RpcEnvelope<EditMemoView>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) => editMemoProcedure(ctx, input, now));
    });
  }

  async listMemoRevisions(
    memoId: string,
  ): Promise<RpcEnvelope<MemoRevisionsView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => listMemoRevisionsProcedure(ctx, memoId)),
    );
  }

  async diffMemoRevisions(
    input: DiffRevisionsDto,
  ): Promise<RpcEnvelope<RevisionDiffView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => diffMemoRevisionsProcedure(ctx, input)),
    );
  }

  async rollbackMemo(
    input: RollbackMemoDto,
  ): Promise<RpcEnvelope<RollbackMemoView>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) =>
        rollbackMemoProcedure(ctx, input, now),
      );
    });
  }

  async softDeleteMemo(memoId: string): Promise<RpcEnvelope<void>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) => {
        softDeleteMemoProcedure(ctx, memoId, now);
        return undefined;
      });
    });
  }

  async createTopic(input: CreateTopicDto): Promise<RpcEnvelope<TopicView>> {
    return this.envelope(() => {
      const id = this.config.idGenerator.next();
      const now = this.config.clock.now();
      const userId = this.requireSelfLocator();
      return this.runUnitOfWork((ctx) =>
        createTopicProcedure(ctx, { ...input, userId }, id, now),
      );
    });
  }

  async updateTopic(input: UpdateTopicDto): Promise<RpcEnvelope<TopicView>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) => updateTopicProcedure(ctx, input, now));
    });
  }

  async listTopics(input: ListTopicsDto): Promise<RpcEnvelope<TopicListView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => listTopicsProcedure(ctx, input)),
    );
  }

  async getTopic(topicId: string): Promise<RpcEnvelope<TopicDetailView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => getTopicProcedure(ctx, topicId)),
    );
  }

  async getTopicName(topicId: string): Promise<RpcEnvelope<TopicNameView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => getTopicNameProcedure(ctx, topicId)),
    );
  }

  async search(input: SearchQueryDto): Promise<RpcEnvelope<SearchOutputView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => searchProcedure(ctx, input)),
    );
  }

  async trashTopic(topicId: string): Promise<RpcEnvelope<TrashTopicView>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) =>
        trashTopicProcedure(ctx, topicId, now),
      );
    });
  }

  async createDocument(
    input: CreateDocumentDto,
  ): Promise<RpcEnvelope<CreateDocumentView>> {
    return this.envelope(() => {
      const ids = {
        documentId: this.config.idGenerator.next(),
        revisionId: this.config.idGenerator.next(),
      };
      const now = this.config.clock.now();
      const userId = this.requireSelfLocator();
      return this.runUnitOfWork((ctx) =>
        createDocumentProcedure(ctx, { ...input, userId }, ids, now),
      );
    });
  }

  async editDocument(
    input: EditDocumentDto,
  ): Promise<RpcEnvelope<EditDocumentView>> {
    return this.envelope(() => {
      const revisionId = this.config.idGenerator.next();
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) =>
        editDocumentProcedure(ctx, input, revisionId, now),
      );
    });
  }

  async rollbackDocument(
    input: RollbackDocumentDto,
  ): Promise<RpcEnvelope<RollbackDocumentView>> {
    return this.envelope(() => {
      const revisionId = this.config.idGenerator.next();
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) =>
        rollbackDocumentProcedure(ctx, input, revisionId, now),
      );
    });
  }

  async trashDocument(documentId: string): Promise<RpcEnvelope<void>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) => {
        trashDocumentProcedure(ctx, documentId, now);
        return undefined;
      });
    });
  }

  async getDocument(documentId: string): Promise<RpcEnvelope<DocumentView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => getDocumentProcedure(ctx, documentId)),
    );
  }

  async listDocumentRevisions(
    documentId: string,
  ): Promise<RpcEnvelope<DocumentRevisionsView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) =>
        listDocumentRevisionsProcedure(ctx, documentId),
      ),
    );
  }

  async diffDocumentRevisions(
    input: DiffDocumentRevisionsDto,
  ): Promise<RpcEnvelope<DocumentDiffView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => diffDocumentRevisionsProcedure(ctx, input)),
    );
  }

  async listDocumentSourceMemos(
    documentId: string,
  ): Promise<RpcEnvelope<SourceMemosView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) =>
        listDocumentSourceMemosProcedure(ctx, documentId),
      ),
    );
  }

  async listDocumentsReferencingMemo(
    memoId: string,
  ): Promise<RpcEnvelope<ReferencingDocumentsView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) =>
        listDocumentsReferencingMemoProcedure(ctx, memoId),
      ),
    );
  }
}
