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
// Both legs run the same structural rebuild. Inbound there is no `test`, so the
// check has to sit in `fromSerializable`. Outbound, `test` already rejects a
// value whose payload fails `asSerializedError` (sending it to Seroval's
// default `Error` handling instead of this tag) — but valid is not minimal: a
// hand-built `AppServerError` carrying an undeclared key passes `test`, so
// `toSerializable` rebuilds too rather than trusting every `AppServerError`
// construction site to hand it a clean payload. Its `??` arm is unreachable
// while `test` gates this leg; it exists so the guarantee stays structural
// instead of an invariant spanning two functions. Rejecting fails closed to
// `unknown` rather than throwing, because throwing here aborts the whole
// payload parse — on the outbound leg that would turn one unrepresentable
// error into a client-side parse failure.
export const appServerErrorAdapter = createSerializationAdapter<
  AppServerError,
  SerializedError
>({
  key: "AppServerError",
  test: isAppServerError,
  toSerializable: (value) =>
    asSerializedError(value.serialized) ?? UNVERIFIED_SERIALIZED_ERROR,
  fromSerializable: (value) =>
    new AppServerError(asSerializedError(value) ?? UNVERIFIED_SERIALIZED_ERROR),
});
