import { createSerializationAdapter } from "@tanstack/react-router";
import {
  AppServerError,
  isAppServerError,
  type SerializedError,
} from "./errorResponse";

// Registered on the global start instance so `AppServerError` survives the
// Seroval roundtrip carrying its `kind`-tagged `serialized` payload. Without
// it the value falls through to Seroval's default `Error` handling, which
// keeps only `message` — the client then sees `kind: "unknown"`.
//
// `test` is deliberately structural (`isAppServerError`) rather than
// `instanceof`: this adapter is loaded from the SSR graph via `start.ts`
// while server functions throw from their own module graph, so the two hold
// different class objects built from the same file.
export const appServerErrorAdapter = createSerializationAdapter<
  AppServerError,
  SerializedError
>({
  key: "AppServerError",
  test: isAppServerError,
  toSerializable: (value) => value.serialized,
  fromSerializable: (value) => new AppServerError(value),
});
