import { describe, expect, it } from "vitest";
import { inUserDataStorage } from "../../__tests__/helpers";
import {
  expectIndexSeek,
  expectKeySeek,
  expectOrderedIndexWalk,
  queryPlan,
} from "../../__tests__/planAssertions";
import {
  createTestContainer,
  registerTestUser,
} from "../../__tests__/testContainer";
import { pivotStatement, timelinePageStatement } from "../memoRepository";

const INDEX = "memos_timeline_idx";
const DIRECTIONS = ["older", "newer"] as const;

// `spec/database/index.md` (the index table and the access-path table):
// `findTimelinePage` and `findTimelineAround` read through
// `memos_timeline_idx`, and a `keyword` is applied inside that index range
// (`body LIKE`), never by a scan of the table. The statements are the ones
// the repository runs. The plan is measured on an empty object with no
// `sqlite_stat1`, and it is SQLite's, hence version-dependent.
describe("memo timeline reads: the plans spec/database declares", () => {
  it("a first page walks the index in order and stops at LIMIT", async () => {
    const { userId } = await registerTestUser(createTestContainer());
    await inUserDataStorage(userId, (sql) => {
      for (const direction of DIRECTIONS) {
        for (const keyword of [false, true]) {
          expectOrderedIndexWalk(
            queryPlan(
              sql,
              timelinePageStatement({
                positioned: false,
                direction,
                inclusive: false,
                keyword,
              }),
            ),
            INDEX,
          );
        }
      }
    });
  });

  it("a page after a cursor seeks the index from the cursor, both ways, with or without a keyword", async () => {
    const { userId } = await registerTestUser(createTestContainer());
    await inUserDataStorage(userId, (sql) => {
      for (const direction of DIRECTIONS) {
        for (const inclusive of [false, true]) {
          for (const keyword of [false, true]) {
            expectIndexSeek(
              queryPlan(
                sql,
                timelinePageStatement({
                  positioned: true,
                  direction,
                  inclusive,
                  keyword,
                }),
              ),
              INDEX,
            );
          }
        }
      }
    });
  });

  it("the anchors: a date seeks the index on posted_at, a memo is a key seek", async () => {
    const { userId } = await registerTestUser(createTestContainer());
    await inUserDataStorage(userId, (sql) => {
      for (const keyword of [false, true]) {
        expectIndexSeek(
          queryPlan(sql, pivotStatement("before", keyword)),
          INDEX,
        );
        expectIndexSeek(
          queryPlan(sql, pivotStatement("after", keyword)),
          INDEX,
        );
        expectKeySeek(queryPlan(sql, pivotStatement("memo", keyword)), "memos");
      }
    });
  });

  // The negative control for the cursor statement: spelled as the
  // equivalent `posted_at < ? OR (posted_at = ? AND id < ?)`, SQLite walks
  // the index from its newest row instead of seeking — which is why the
  // repository compares row values.
  it("catches the walk the row-value comparison exists to prevent", async () => {
    const { userId } = await registerTestUser(createTestContainer());
    await inUserDataStorage(userId, (sql) => {
      const plan = queryPlan(
        sql,
        `SELECT id FROM memos WHERE status = 'active' AND (posted_at < ? OR (posted_at = ? AND id < ?))
         ORDER BY posted_at DESC, id DESC LIMIT ?`,
      );
      expect(() => expectIndexSeek(plan, INDEX)).toThrow();
    });
  });
});
