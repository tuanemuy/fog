import { createSerializationAdapter } from "@tanstack/react-router";
import {
  AppServerError,
  isAppServerError,
  type SerializedError,
} from "./errorResponse";

// SSR and RSC load separate class identities; match the validated envelope across both graphs.
export const appServerErrorAdapter = createSerializationAdapter<
  AppServerError,
  SerializedError
>({
  key: "AppServerError",
  test: isAppServerError,
  toSerializable: (value) => value.serialized,
  fromSerializable: (value) => new AppServerError(value),
});
