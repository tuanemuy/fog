import { describe, expect, it } from "vitest";
import { bindChunks, SQL_MAX_BIND_PARAMETERS } from "../bindChunks";

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `id-${index}`);

describe("bindChunks", () => {
  it("yields no chunk at all for an empty list, so the caller issues nothing", () => {
    expect(bindChunks([])).toEqual([]);
  });

  it("keeps a list at the bind ceiling in one chunk", () => {
    const all = ids(SQL_MAX_BIND_PARAMETERS);

    expect(bindChunks(all)).toEqual([all]);
  });

  it("splits one past the ceiling and loses nothing", () => {
    const all = ids(SQL_MAX_BIND_PARAMETERS + 1);

    const chunks = bindChunks(all);

    expect(chunks.map((chunk) => chunk.length)).toEqual([
      SQL_MAX_BIND_PARAMETERS,
      1,
    ]);
    expect(chunks.flat()).toEqual(all);
  });

  // The JSDoc's guarantee. Callers collect ids from rows that repeat them
  // — `readTopicDetail` passes one `memoId` per source link — so a chunk
  // count that followed `ids.length` would bill a shared source twice.
  it("makes the chunk count a function of the distinct ids", () => {
    const distinct = ids(SQL_MAX_BIND_PARAMETERS);

    expect(bindChunks([...distinct, ...distinct, ...distinct])).toEqual([
      distinct,
    ]);
  });

  it("drops a repetition without moving the first occurrence", () => {
    expect(bindChunks(["a", "b", "a", "c", "b", "d"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});
