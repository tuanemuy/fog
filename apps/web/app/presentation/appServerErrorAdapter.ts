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
// `handleServerAction` parses the request body with this plugin, so a
// client-posted node tagged `$TSR/t/AppServerError` reaches `fromSerializable`
// before `inputValidator` runs. `asSerializedError` is what keeps that node
// from choosing its own payload — the transport boundary CLAUDE.md names, not
// a third validation point.
//
// Both legs rebuild. Inbound there is no `test`, so the check sits in
// `fromSerializable`. Outbound `test` has already run, but it proves the
// payload valid, not minimal — a hand-built `AppServerError` carrying an
// undeclared key passes it — so `toSerializable` rebuilds rather than trusting
// every construction site. Its `??` arm is unreachable while `test` gates the
// leg; it keeps the guarantee structural instead of spanning two functions.
// Both fail closed to `unknown` rather than throwing, which would abort the
// whole payload parse. See `.adr/016`.
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
