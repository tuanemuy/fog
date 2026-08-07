import { createSerializationAdapter } from "@tanstack/react-router";
import {
  AppServerError,
  asSerializedError,
  isAppServerError,
  type SerializedError,
  UNVERIFIED_SERIALIZED_ERROR,
} from "./errorResponse";

// Registered on the global start instance so `AppServerError` survives the
// Seroval roundtrip carrying its `kind`-tagged `serialized` payload; without
// it Seroval's default `Error` handling keeps only `message` and the client
// sees `kind: "unknown"`. `test` is structural rather than `instanceof` —
// see `isAppServerError` for the two-module-graph reason.
//
// This adapter is symmetric and therefore runs on **incoming** requests too:
// `getDefaultSerovalPlugins` builds it with `makeSerovalPlugin`, whose
// `deserialize` calls `fromSerializable`, and `handleServerAction` parses the
// request body with that plugin list — so a client-posted node tagged
// `$TSR/t/AppServerError` reaches `fromSerializable` before `inputValidator`
// runs. `asSerializedError` is what keeps that node from choosing its own
// payload: this is the transport boundary CLAUDE.md names, not a third
// validation point.
//
// The two legs stay guarded by different halves of the adapter rather than by
// the same call: outbound, `test` already rejects a value whose payload fails
// `asSerializedError`, which sends it to Seroval's default `Error` handling
// instead of this tag; inbound there is no `test`, so the check has to sit in
// `fromSerializable`. Rejecting fails closed to `unknown` rather than throwing,
// because throwing here aborts the whole payload parse — on the outbound leg
// that would turn one unrepresentable error into a client-side parse failure.
export const appServerErrorAdapter = createSerializationAdapter<
  AppServerError,
  SerializedError
>({
  key: "AppServerError",
  test: isAppServerError,
  toSerializable: (value) => value.serialized,
  fromSerializable: (value) =>
    new AppServerError(asSerializedError(value) ?? UNVERIFIED_SERIALIZED_ERROR),
});
