import type { UserRepository } from "@repo/core/domain/identity/ports/userRepository";

export interface UnitOfWorkContext {
  userRepository: UserRepository;
}

export interface UnitOfWorkProvider {
  run<T>(fn: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T>;
}
