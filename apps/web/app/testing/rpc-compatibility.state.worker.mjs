const operations = new Map();

function configuredVersions(env) {
  return new Set(
    env.ACCEPTED_RPC_VERSIONS.split(",").map((version) => Number(version)),
  );
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      const operationId = new URL(request.url).searchParams.get("operationId");
      return Response.json({
        value:
          operationId === null ? null : (operations.get(operationId) ?? null),
      });
    }
    const input = await request.json();
    if (
      typeof input !== "object" ||
      input === null ||
      !("version" in input) ||
      !("operationId" in input) ||
      !("value" in input) ||
      typeof input.version !== "number" ||
      typeof input.operationId !== "string" ||
      typeof input.value !== "string"
    ) {
      return Response.json({ error: "RPC_PAYLOAD_INVALID" }, { status: 400 });
    }
    if (!configuredVersions(env).has(input.version)) {
      return Response.json(
        { error: "RPC_VERSION_UNSUPPORTED", retryable: false },
        { status: 409 },
      );
    }
    operations.set(input.operationId, input.value);
    return Response.json({ ok: true, value: input.value });
  },
};
