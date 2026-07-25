import { createSerializationAdapter } from "@tanstack/react-router";
import {
  AppServerError,
  isAppServerError,
  type SerializedError,
} from "./errorResponse";

// Registered on the global start instance so `AppServerError` survives the
// Seroval roundtrip carrying its `kind`-tagged `serialized` payload; without
// it Seroval's default `Error` handling keeps only `message` and the client
// sees `kind: "unknown"`. `test` is structural rather than `instanceof` —
// see `isAppServerError` for the two-module-graph reason.
export const appServerErrorAdapter = createSerializationAdapter<
  AppServerError,
  SerializedError
>({
  key: "AppServerError",
  test: isAppServerError,
  toSerializable: (value) => value.serialized,
  fromSerializable: (value) => new AppServerError(value),
});
