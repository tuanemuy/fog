import type { JobKind } from "@repo/core/application/delivery/types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  EnqueueJobInput,
  IdentityDirectoryUnitOfWorkContext,
  IdentityDirectoryUnitOfWorkProvider,
  UnitOfWorkProvider,
  UserDataUnitOfWorkContext,
  UserDataUnitOfWorkProvider,
} from "@repo/core/application/execution/unitOfWork";
import type { Clock } from "@repo/core/application/ports/clock";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import { EventId } from "@repo/core/domain/common/event";
import { isRehydrationError } from "@repo/core/domain/error";
import { isCodedError } from "@repo/core/lib/error";
import { createAccountStore } from "./stores/accountStore";
import { createCredentialLocatorStore } from "./stores/credentialLocatorStore";
import {
  createCredentialAttemptRecorder,
  createCredentialMappingReader,
  createCredentialMappingWriter,
} from "./stores/credentialMappingStore";
import { createDocumentRepository } from "./stores/documentRepository";
import { writeEnqueuedJob } from "./stores/jobWriter";
import { createMemoRepository } from "./stores/memoRepository";
import {
  writeRecordedOperation,
  writeUpdatedOperation,
} from "./stores/operationsStore";
import { writeEnqueuedEvents } from "./stores/outboxWriter";
import { createSearchIndex } from "./stores/searchIndex";
import { createTopicRepository } from "./stores/topicRepository";
import { createTrashQueryPort } from "./stores/trashQueryPort";
import { createUserSettingsRepository } from "./stores/userSettingsRepository";

export type UnitOfWorkDeps = Readonly<{
  storage: DurableObjectStorage;
  clock: Clock;
  idGenerator: IdGenerator;
  /** `_meta.self_locator`: the `userId` of a User Data DO, the bucket name of a directory bucket. */
  selfLocator: string;
}>;

/**
 * Translates whatever escapes `transactionSync` into the shared error contract:
 * business and application errors pass through, a broken row is
 * `DataIntegrityError`, and anything else the driver threw is `DatabaseError`.
 */
function translate(error: unknown): never {
  if (isCodedError(error)) throw error;
  if (isRehydrationError(error)) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "A stored row cannot be rebuilt into a domain object",
      error,
    );
  }
  throw new SystemError(
    SystemErrorCode.DatabaseError,
    "Durable Object storage failed",
    error,
  );
}

function createProvider<TCtx>(
  deps: UnitOfWorkDeps,
  buildContext: (
    sql: SqlStorage,
    common: CommonMembers,
    nowMs: () => number,
  ) => TCtx,
): UnitOfWorkProvider<TCtx> {
  let rearmRequested = false;
  const nowMs = () => deps.clock.now().getTime();
  return {
    run(fn) {
      rearmRequested = false;
      const sql = deps.storage.sql;
      const common: CommonMembers = {
        enqueueJob(input) {
          writeEnqueuedJob(sql, input);
          rearmRequested = true;
        },
        enqueueEvent(drafts) {
          if (drafts.length === 0) return;
          writeEnqueuedEvents(
            sql,
            drafts,
            () => EventId.create(deps.idGenerator.next()),
            nowMs(),
          );
          rearmRequested = true;
        },
      };
      const ctx = buildContext(sql, common, nowMs);
      try {
        return deps.storage.transactionSync(() => fn(ctx));
      } catch (error) {
        rearmRequested = false;
        return translate(error);
      }
    },
    takeRearmRequest() {
      const requested = rearmRequested;
      rearmRequested = false;
      return requested;
    },
  };
}

// Typed on the whole `JobKind` union: each class's context narrows the
// parameter to its own roster when it takes the member.
type CommonMembers = {
  enqueueJob(input: EnqueueJobInput<JobKind>): void;
  enqueueEvent(
    drafts: Parameters<IdentityDirectoryUnitOfWorkContext["enqueueEvent"]>[0],
  ): void;
};

export function createUserDataUnitOfWorkProvider(
  deps: UnitOfWorkDeps,
): UserDataUnitOfWorkProvider {
  return createProvider<UserDataUnitOfWorkContext>(
    deps,
    (sql, common, nowMs) => ({
      enqueueJob: common.enqueueJob,
      enqueueEvent: common.enqueueEvent,
      userSettingsRepository: createUserSettingsRepository(sql),
      memoRepository: createMemoRepository(sql, deps.selfLocator),
      topicRepository: createTopicRepository(sql, deps.selfLocator),
      documentRepository: createDocumentRepository(sql, deps.selfLocator),
      searchIndex: createSearchIndex(sql, nowMs),
      trashQueryPort: createTrashQueryPort(sql),
      accountStore: createAccountStore(sql, nowMs),
      credentialLocatorStore: createCredentialLocatorStore(sql, nowMs),
      recordOperation(input) {
        writeRecordedOperation(sql, input, nowMs());
      },
      updateOperation(input) {
        writeUpdatedOperation(sql, input);
      },
    }),
  );
}

export function createIdentityDirectoryUnitOfWorkProvider(
  deps: UnitOfWorkDeps,
): IdentityDirectoryUnitOfWorkProvider {
  return createProvider<IdentityDirectoryUnitOfWorkContext>(
    deps,
    (sql, common, nowMs) => ({
      enqueueJob: common.enqueueJob,
      enqueueEvent: common.enqueueEvent,
      credentialMappingReader: createCredentialMappingReader(sql),
      credentialMappingWriter: createCredentialMappingWriter(sql, nowMs),
      credentialAttemptRecorder: createCredentialAttemptRecorder(sql, nowMs),
    }),
  );
}
