export function createStaticAssets(
  directory: string,
): (request: Request) => Promise<Response | null>;
