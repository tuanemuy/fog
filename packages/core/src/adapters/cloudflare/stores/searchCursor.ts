import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import { BusinessRuleError } from "@repo/core/domain/error";
import { SearchErrorCode } from "@repo/core/domain/search/errorCode";
import type { SearchCursor } from "@repo/core/domain/search/valueObject";
import { fromBase64Url, toBase64Url } from "../../webcrypto/encoding";

/**
 * The snapshot a search cursor carries (decision △-1 of PH-04): the ranked
 * set itself, so reading on from it needs no table and no second ranking.
 * Rows added after the first page never join the set, an edited row keeps
 * its place, and a trashed one is skipped when its page is read.
 */
export type SearchSnapshotKey = Readonly<{
  type: "memo" | "document";
  id: string;
}>;

export type SearchCursorPayload = Readonly<{
  /** The normalized keyword the set was ranked for. */
  keyword: string;
  topicId: string | null;
  /** Epoch ms after which the whole snapshot is refused. */
  expiresAt: number;
  offset: number;
  ids: readonly SearchSnapshotKey[];
}>;

const VERSION = 1;
const KEY_BYTES = 17;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Meta = Readonly<{
  v: number;
  k: string;
  t: string | null;
  x: number;
  o: number;
}>;

function invalidCursor(): BusinessRuleError<SearchErrorCode> {
  return new BusinessRuleError<SearchErrorCode>(
    SearchErrorCode.InvalidCursor,
    "The search cursor is invalid or has expired",
  );
}

function packKey(key: SearchSnapshotKey, out: Uint8Array, at: number): void {
  if (!UUID.test(key.id)) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "A search entry id is not a UUID",
    );
  }
  out[at] = key.type === "memo" ? 0 : 1;
  const hex = key.id.replace(/-/g, "");
  for (let i = 0; i < 16; i += 1) {
    out[at + 1 + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
}

function unpackKey(bytes: Uint8Array, at: number): SearchSnapshotKey {
  const typeByte = bytes[at];
  if (typeByte !== 0 && typeByte !== 1) throw invalidCursor();
  let hex = "";
  for (let i = 0; i < 16; i += 1) {
    hex += (bytes[at + 1 + i] as number).toString(16).padStart(2, "0");
  }
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { type: typeByte === 0 ? "memo" : "document", id };
}

/** `[u32 meta length][meta JSON][17 bytes per key]`, base64url. */
export function encodeSearchCursor(payload: SearchCursorPayload): SearchCursor {
  const meta: Meta = {
    v: VERSION,
    k: payload.keyword,
    t: payload.topicId,
    x: payload.expiresAt,
    o: payload.offset,
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(
    4 + metaBytes.length + payload.ids.length * KEY_BYTES,
  );
  new DataView(out.buffer).setUint32(0, metaBytes.length);
  out.set(metaBytes, 4);
  payload.ids.forEach((key, index) => {
    packKey(key, out, 4 + metaBytes.length + index * KEY_BYTES);
  });
  return toBase64Url(out) as SearchCursor;
}

/** Form and structure only; the lifetime and the query match are the caller's checks. */
export function decodeSearchCursor(cursor: SearchCursor): SearchCursorPayload {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(cursor);
  } catch {
    throw invalidCursor();
  }
  if (bytes.length < 4) throw invalidCursor();
  const metaLength = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0);
  const idsAt = 4 + metaLength;
  if (idsAt > bytes.length || (bytes.length - idsAt) % KEY_BYTES !== 0) {
    throw invalidCursor();
  }
  let meta: Partial<Meta>;
  try {
    meta = JSON.parse(
      new TextDecoder().decode(bytes.subarray(4, idsAt)),
    ) as Partial<Meta>;
  } catch {
    throw invalidCursor();
  }
  if (
    meta.v !== VERSION ||
    typeof meta.k !== "string" ||
    !(meta.t === null || typeof meta.t === "string") ||
    typeof meta.x !== "number" ||
    !Number.isFinite(meta.x) ||
    typeof meta.o !== "number" ||
    !Number.isInteger(meta.o) ||
    meta.o < 0
  ) {
    throw invalidCursor();
  }
  const ids: SearchSnapshotKey[] = [];
  for (let at = idsAt; at < bytes.length; at += KEY_BYTES) {
    ids.push(unpackKey(bytes, at));
  }
  if (meta.o > ids.length) throw invalidCursor();
  return {
    keyword: meta.k,
    topicId: meta.t,
    expiresAt: meta.x,
    offset: meta.o,
    ids,
  };
}
