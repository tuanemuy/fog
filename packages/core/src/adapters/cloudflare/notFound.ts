import { NotFoundError } from "@repo/core/application/errors";

/**
 * The "not found" every read and write inside the user's Durable Object
 * answers with, one factory per aggregate.
 *
 * They sit outside any one feature's module because the rule they carry is
 * the object's and not a feature's: absent, in the trash and somebody
 * else's are one answer, and a caller must not be able to tell them apart.
 * Written once each, the three cannot drift into three messages — which is
 * exactly what would let a caller separate them.
 */

/** The one answer for "absent", "in the trash" and "somebody else's". */
export function topicNotFound(): NotFoundError {
  return new NotFoundError("TOPIC_NOT_FOUND", "The topic was not found");
}

/** The same one answer, for documents. */
export function documentNotFound(): NotFoundError {
  return new NotFoundError("DOCUMENT_NOT_FOUND", "The document was not found");
}

/**
 * The same one answer, for memos.
 *
 * It never names an id, which matters most where several were asked for at
 * once: telling a caller *which* of the memos it cited was refused would
 * leak the existence of a trashed one as surely as accepting it would
 * (S-AI-03).
 */
export function memoNotFound(): NotFoundError {
  return new NotFoundError("MEMO_NOT_FOUND", "The memo was not found");
}
