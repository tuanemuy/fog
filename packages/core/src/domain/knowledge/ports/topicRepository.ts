import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import type { TrashRetentionDays } from "@repo/core/domain/identity/valueObject";
import type { ActiveTopic, LiveTopic, Topic, TrashedTopic } from "../entity";
import type { TopicId } from "../valueObject";

/**
 * What name resolution draws of a topic (a read projection). `status` stays
 * as the discriminant so a broader, trash-inclusive projection cannot stand
 * in for it. No description, no OCC token: it cannot reach a `save`.
 */
type TopicSummaryFields = "id" | "name" | "status";
export type LiveTopicSummary = Pick<LiveTopic, TopicSummaryFields>;

/**
 * The topic aggregate. Same OCC contract as `TransactionalRepository`
 * without extending it. Synchronous throughout. `userId` is never an
 * argument: the Durable Object was chosen by it (`spec/domains/index.md`).
 */
export interface TopicRepository {
  insert(topic: ActiveTopic): void;
  save(topic: Topic, expectedVersion: ExpectedVersion<Topic>): void;
  /** Hard delete of the row; the documents below it are the usecase's. */
  delete(id: TopicId, expectedVersion: ExpectedVersion<Topic>): void;

  /** Outside the trash only; trashed is `null`. */
  findById(id: TopicId): Versioned<LiveTopic> | null;
  /** Any state. Human UI and trash usecases only. */
  findByIdIncludingTrashed(id: TopicId): Versioned<Topic> | null;

  /** Outside the trash, by name then id. */
  listByUser(
    options: Readonly<{ includeArchived: boolean }>,
  ): readonly LiveTopic[];
  /** Trash listing material for the `TrashQueryPort` adapter; not for usecases. */
  listTrashedByUser(): readonly Versioned<TrashedTopic>[];

  /** Live topics among `ids`, in no promised order; absent and trashed ids are dropped. */
  listSummariesByIds(ids: readonly TopicId[]): readonly LiveTopicSummary[];

  /** Bulk `purgeAfter` recalculation after a retention change; no OCC, no `version` bump. */
  recalculatePurgeAfter(
    retentionDays: TrashRetentionDays,
    limit: number,
  ): Readonly<{ updatedCount: number; hasMore: boolean }>;
}
