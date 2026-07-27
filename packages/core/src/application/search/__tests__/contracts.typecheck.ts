import type {
  SemanticTransactionCallback,
  SemanticTransactionRepositories,
} from "../contracts";

declare const repositories: SemanticTransactionRepositories;

const synchronousCallback: SemanticTransactionCallback = () => undefined;

// @ts-expect-error Promise-returning callbacks must not cross the sync boundary.
const asynchronousCallback: SemanticTransactionCallback = async () => undefined;

void repositories;
void synchronousCallback;
void asynchronousCallback;
