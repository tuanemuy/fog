import type { RpcEnvelope } from "@repo/core/application/delivery/types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { UserDataUnitOfWorkContext } from "@repo/core/application/execution/unitOfWork";
import type { ExportSourceDto } from "@repo/core/application/export/gateway";
import {
  type AbandonAccountDto,
  type AbandonAccountResult,
  abandonAccountProcedure,
} from "@repo/core/application/identity/abandonAccount";
import { approveAiClientAuthorizationProcedure } from "@repo/core/application/identity/approveAiClientAuthorization";
import { findActiveAiClientProcedure } from "@repo/core/application/identity/authorizeAiClient";
import { changeTrashRetentionDaysProcedure } from "@repo/core/application/identity/changeTrashRetentionDays";
import { applyCredentialChangeProcedure } from "@repo/core/application/identity/credentialChangeProcedures";
import type {
  ApplyCredentialChangeDto,
  ApplyCredentialChangeResult,
  ApproveAiClientAuthorizationDto,
  BeginLinkDto,
  BeginLinkResult,
  BeginUnlinkDto,
  BeginUnlinkResult,
  CompleteLinkDto,
  ConsumeAuthorizationCodeDto,
  ConsumeAuthorizationCodeResult,
  CredentialLocatorDto,
  CurrentUserDto,
  FinishUnlinkDto,
  InitializeAccountDto,
  OperationRefDto,
  RecordSignupLocatorDto,
  RevokeAllAiClientConnectionsResult,
} from "@repo/core/application/identity/gateway";
import { initializeAccountProcedure } from "@repo/core/application/identity/initializeAccount";
import {
  beginLinkProcedure,
  completeLinkProcedure,
  finishLinkProcedure,
} from "@repo/core/application/identity/linkSsoCredential";
import { listAiClientConnectionsProcedure } from "@repo/core/application/identity/listAiClientConnections";
import { readCurrentUserProcedure } from "@repo/core/application/identity/readCurrentUser";
import { fromCredentialLocator } from "@repo/core/application/identity/rebuild";
import { recordSignupLocatorProcedure } from "@repo/core/application/identity/recordSignupLocator";
import { revokeAiClientConnectionProcedure } from "@repo/core/application/identity/revokeAiClientConnection";
import { revokeAllAiClientConnectionsSteps } from "@repo/core/application/identity/revokeAllAiClientConnections";
import {
  type RecordRemappedLocatorDto,
  type RecordRemappedLocatorResult,
  recordRemappedLocatorProcedure,
} from "@repo/core/application/identity/rotation/recordRemappedLocator";
import {
  beginUnlinkProcedure,
  finishUnlinkProcedure,
} from "@repo/core/application/identity/unlinkSsoCredential";
import type { AiClientConnectionView } from "@repo/core/application/identity/view";
import { createDocumentProcedure } from "@repo/core/application/knowledge/createDocument";
import { createTopicProcedure } from "@repo/core/application/knowledge/createTopic";
import { diffDocumentRevisionsProcedure } from "@repo/core/application/knowledge/diffDocumentRevisions";
import { editDocumentProcedure } from "@repo/core/application/knowledge/editDocument";
import { editDocumentByAiProcedure } from "@repo/core/application/knowledge/editDocumentByAi";
import type {
  CreateDocumentDto,
  CreateTopicDto,
  DiffDocumentRevisionsDto,
  EditDocumentByAiDto,
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
} from "@repo/core/application/knowledge/view";
import { diffMemoRevisionsProcedure } from "@repo/core/application/memo/diffMemoRevisions";
import { editMemoProcedure } from "@repo/core/application/memo/editMemo";
import type {
  DiffRevisionsDto,
  EditMemoDto,
  JumpToDateDto,
  PostMemoDto,
  RecentMemosDto,
  RollbackMemoDto,
  ShowMemoDto,
  TimelineQueryDto,
  UpdateMemoByAiDto,
} from "@repo/core/application/memo/gateway";
import { getMemoProcedure } from "@repo/core/application/memo/getMemo";
import { getTimelineProcedure } from "@repo/core/application/memo/getTimeline";
import { jumpToDateProcedure } from "@repo/core/application/memo/jumpToDate";
import { listMemoRevisionsProcedure } from "@repo/core/application/memo/listMemoRevisions";
import { postMemoProcedure } from "@repo/core/application/memo/postMemo";
import { recentMemosProcedure } from "@repo/core/application/memo/recentMemos";
import { rollbackMemoProcedure } from "@repo/core/application/memo/rollbackMemo";
import { showMemoInTimelineProcedure } from "@repo/core/application/memo/showMemoInTimeline";
import { softDeleteMemoProcedure } from "@repo/core/application/memo/softDeleteMemo";
import { updateMemoByAiProcedure } from "@repo/core/application/memo/updateMemoByAi";
import type {
  EditMemoView,
  MemoRevisionsView,
  MemoView,
  MemoWindowView,
  RecentMemosView,
  RevisionDiffView,
  RollbackMemoView,
  TimelinePageView,
  TimelineWindowView,
  UpdateMemoByAiView,
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
import {
  AiClientConnectionId,
  CredentialId,
} from "@repo/core/domain/identity/valueObject";
import { rearm } from "./alarmSchedule";
import {
  AsyncWorkDurableObject,
  type StateWorkerEnv,
} from "./durableObjectBase";
import type { JobHandlerRegistry } from "./jobRunner";
import { createLinkCleanupHandler } from "./jobs/cleanup/linkCleanup";
import { createFinalizeWithdrawalHandler } from "./jobs/finalizeWithdrawal";
import { createMigrateBulkHandler } from "./jobs/migrateBulk";
import { createPurgeTrashHandler } from "./jobs/purgeTrash";
import { createReindexHandler } from "./jobs/reindex";
import { createResumeLinkHandler } from "./jobs/resumeLink";
import { createSweepOrphanMappingHandler } from "./jobs/sweepOrphanMapping";
import { isInitialized } from "./migrationGate";
import { USER_DATA_PLAN } from "./schema/userDataPlan";
import { readCallerToken } from "./stores/accountStore";
import { createAiClientConnectionRepository } from "./stores/aiClientConnectionRepository";
import {
  EXPORT_MAX_SOURCE_BYTES,
  readExportSourceDto,
} from "./stores/exportSourceReader";
import { consumeCodeJti } from "./stores/oauthConsumedCodes";
import { readTargetLocators } from "./stores/operationsStore";
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
    const linkCleanup = createLinkCleanupHandler({ env });
    super(ctx, env, {
      plan: USER_DATA_PLAN,
      allowInitialize: false,
      clock: SystemClock,
      idGenerator: UuidV7Generator,
      logger: ConsoleLogger,
      jobRegistry,
      // The one cleanup this class owns (`spec/recovery/index.md`): a
      // link's roll-back. Withdrawal and the orphan sweep are forward only.
      terminalStage: (row) => (row.kind === "resume-link" ? linkCleanup : null),
    });
    jobRegistry["finalize-withdrawal"] = createFinalizeWithdrawalHandler({
      env,
      userId: () => this.requireSelfLocator(),
      provider: () => this.createUnitOfWorkProvider(),
      now: () => this.config.clock.now(),
    });
    // Filled after `super`: the handler needs this object's unit of work.
    jobRegistry["purge-trash"] = createPurgeTrashHandler({
      provider: () => this.createUnitOfWorkProvider(),
      logger: this.config.logger,
    });
    jobRegistry["resume-link"] = createResumeLinkHandler({
      env,
      userId: () => this.requireSelfLocator(),
      provider: () => this.createUnitOfWorkProvider(),
      now: () => this.config.clock.now(),
    });
    jobRegistry["sweep-orphan-mapping"] = createSweepOrphanMappingHandler({
      env,
      userId: () => this.requireSelfLocator(),
      provider: () => this.createUnitOfWorkProvider(),
      logger: this.config.logger,
    });
    // Seeded by the migration gate, never by a usecase. The plan is read
    // through the instance so a test may hand it a later version.
    jobRegistry.reindex = createReindexHandler({
      runUnitOfWork: (fn) => this.runUnitOfWork(fn),
    });
    jobRegistry["migrate-bulk"] = createMigrateBulkHandler({
      plan: () => this.migrationPlan,
      runUnitOfWork: (fn) => this.runUnitOfWork(fn),
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
            credentials: input.credentials,
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

  /**
   * Stage S2 of the signup cleanup (`spec/recovery/index.md`). Step (1)
   * of its evaluation — an object that was never initialised — is
   * answered here **before the gate**, so that a cleanup for a saga whose
   * phase 2 never ran neither creates an empty object nor fails: there is
   * nothing to abandon. Every other step runs inside the unit of work.
   */
  async abandonAccount(
    dto: AbandonAccountDto,
  ): Promise<RpcEnvelope<AbandonAccountResult>> {
    return this.envelope(async () => {
      if (!isInitialized(this.ctx.storage.sql)) return "nothing-to-abandon";
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) =>
        abandonAccountProcedure(ctx, this.ctx.storage.sql, dto, now),
      );
    });
  }

  /**
   * s3 of the mapping-key transfer (`spec/rotation/index.md`,
   * `record-remapped-locator`): the new generation's reverse-index row,
   * written before the copy exists, or the one-valued `skipped`.
   */
  async recordRemappedLocator(
    dto: RecordRemappedLocatorDto,
  ): Promise<RpcEnvelope<RecordRemappedLocatorResult>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) =>
        recordRemappedLocatorProcedure(ctx, this.ctx.storage.sql, dto),
      ),
    );
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

  /** Credential-change saga phase 2. */
  async applyCredentialChange(
    dto: ApplyCredentialChangeDto,
  ): Promise<RpcEnvelope<ApplyCredentialChangeResult>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) =>
        applyCredentialChangeProcedure(ctx, dto, now),
      );
    });
  }

  /** Link phase 0: the operation record and its `resume-link`; answers the caller token the bucket reservation needs. */
  async beginLink(input: {
    dto: BeginLinkDto;
    resumeAt: Date;
  }): Promise<RpcEnvelope<BeginLinkResult>> {
    return this.envelope(async () => {
      await this.runUnitOfWork((ctx) => {
        beginLinkProcedure(ctx, input.dto, input.resumeAt);
        return undefined;
      });
      const callerToken = readCallerToken(this.ctx.storage.sql);
      if (callerToken === null) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "The account has no caller binding",
        );
      }
      return { callerToken };
    });
  }

  async completeLink(dto: CompleteLinkDto): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      const now = this.config.clock.now();
      await this.runUnitOfWork((ctx) => {
        completeLinkProcedure(ctx, dto, now);
        return undefined;
      });
    });
  }

  async finishLink(dto: OperationRefDto): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      await this.runUnitOfWork((ctx) => {
        finishLinkProcedure(ctx, dto.operationId);
        return undefined;
      });
    });
  }

  /** Unlink phase 1: the User Data side, final in one transaction. */
  async beginUnlink(input: {
    dto: BeginUnlinkDto;
    resumeAt: Date;
  }): Promise<RpcEnvelope<BeginUnlinkResult>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      const callerToken = readCallerToken(this.ctx.storage.sql);
      return this.runUnitOfWork((ctx) =>
        beginUnlinkProcedure(ctx, input.dto, now, input.resumeAt, callerToken),
      );
    });
  }

  async finishUnlink(dto: FinishUnlinkDto): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      const noopSince = dto.noopSince;
      const deferral =
        noopSince === undefined
          ? undefined
          : {
              noopSince,
              targetLocators: readTargetLocators(
                this.ctx.storage.sql,
                dto.operationId,
              ),
            };
      await this.runUnitOfWork((ctx) => {
        finishUnlinkProcedure(ctx, dto.operationId, deferral);
        return undefined;
      });
    });
  }

  /** P-03: one transaction per connection; a conflict is counted, not fatal. */
  async revokeAllAiClientConnections(): Promise<
    RpcEnvelope<RevokeAllAiClientConnectionsResult>
  > {
    return this.envelope(async () => {
      const now = this.config.clock.now();
      const ids = await this.runUnitOfWork((ctx) =>
        ctx.aiClientConnectionRepository
          .listByUserId()
          .filter((c) => c.status === "active")
          .map((c) => c.id),
      );
      return revokeAllAiClientConnectionsSteps(
        (fn) => this.runUnitOfWork(fn),
        ids,
        now,
        this.config.logger,
      );
    });
  }

  /** S-AC-05 「許可する」. */
  async approveAiClientAuthorization(
    dto: ApproveAiClientAuthorizationDto,
  ): Promise<RpcEnvelope<{ connectionId: string }>> {
    return this.envelope(() => {
      const userId = this.requireSelfLocator();
      const now = this.config.clock.now();
      const id = this.config.idGenerator.next();
      return this.runUnitOfWork((ctx) =>
        approveAiClientAuthorizationProcedure(
          ctx,
          { userId, clientName: dto.clientName },
          id,
          now,
        ),
      );
    });
  }

  async listAiClientConnections(): Promise<
    RpcEnvelope<{ connections: readonly AiClientConnectionView[] }>
  > {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => listAiClientConnectionsProcedure(ctx)),
    );
  }

  async revokeAiClientConnection(
    connectionId: string,
  ): Promise<RpcEnvelope<void>> {
    return this.envelope(async () => {
      const now = this.config.clock.now();
      await this.runUnitOfWork((ctx) => {
        revokeAiClientConnectionProcedure(ctx, connectionId, now);
        return undefined;
      });
    });
  }

  /**
   * The AI API's guard (PH-07 △-4): the active read inside the unit of
   * work, then `recordUsage` as the best-effort single UPDATE it is —
   * outside the transaction, failure logged and swallowed by the store.
   */
  async authorizeAiClient(input: {
    connectionId: string;
  }): Promise<RpcEnvelope<{ clientName: string } | null>> {
    return this.envelope(async () => {
      const now = this.config.clock.now();
      const client = await this.runUnitOfWork((ctx) =>
        findActiveAiClientProcedure(ctx, input.connectionId),
      );
      if (client === null) return null;
      createAiClientConnectionRepository(
        this.ctx.storage.sql,
        this.requireSelfLocator(),
        this.config.logger,
      ).recordUsage(AiClientConnectionId.create(input.connectionId), now);
      return client;
    });
  }

  /** The token endpoint's one write: the code's `jti` and the connection's liveness, one transaction. */
  async consumeAuthorizationCode(
    dto: ConsumeAuthorizationCodeDto,
  ): Promise<RpcEnvelope<ConsumeAuthorizationCodeResult>> {
    return this.envelope(async () => {
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) => {
        const client = findActiveAiClientProcedure(ctx, dto.connectionId);
        if (client === null) return { ok: false } as const;
        const fresh = consumeCodeJti(
          this.ctx.storage.sql,
          dto.jti,
          dto.expiresAt.getTime(),
          now.getTime(),
        );
        return fresh
          ? ({ ok: true, clientName: client.clientName } as const)
          : ({ ok: false } as const);
      });
    });
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

  /**
   * S-ST-02's read: the whole live snapshot in one `transactionSync`, no
   * write, no job, no event — it works on an object that has no room left
   * to write. Over the cap it is `SystemError(ExportTooLarge)` before any
   * body is read.
   */
  async readExportSource(): Promise<RpcEnvelope<ExportSourceDto>> {
    return this.envelope(() =>
      this.runUnitOfWork(() =>
        readExportSourceDto(
          this.ctx.storage.sql,
          this.config.exportMaxSourceBytes ?? EXPORT_MAX_SOURCE_BYTES,
          this.config.logger,
        ),
      ),
    );
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

  async updateMemoByAi(
    input: UpdateMemoByAiDto,
  ): Promise<RpcEnvelope<UpdateMemoByAiView>> {
    return this.envelope(() => {
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) =>
        updateMemoByAiProcedure(ctx, input, now),
      );
    });
  }

  async recentMemos(
    input: RecentMemosDto,
  ): Promise<RpcEnvelope<RecentMemosView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => recentMemosProcedure(ctx, input)),
    );
  }

  async getMemo(memoId: string): Promise<RpcEnvelope<MemoView>> {
    return this.envelope(() =>
      this.runUnitOfWork((ctx) => getMemoProcedure(ctx, memoId)),
    );
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

  async editDocumentByAi(
    input: EditDocumentByAiDto,
  ): Promise<RpcEnvelope<EditDocumentByAiView>> {
    return this.envelope(() => {
      const revisionId = this.config.idGenerator.next();
      const now = this.config.clock.now();
      return this.runUnitOfWork((ctx) =>
        editDocumentByAiProcedure(ctx, input, revisionId, now),
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
