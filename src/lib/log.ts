import type { FlueLogger } from "@flue/runtime";

// Flue routes ctx.log.* to the durable run-store (queryable by runId in
// DATABASE_URL), NOT to stdout — so those events are invisible in plain
// container logs (docker/Dokploy). console.log goes to stdout. logEvent emits
// both: the structured run-store event AND a human-readable stdout line, so
// observability (cost, escalation decisions) shows up where operators look
// without querying SQLite.
type LogAttributes = Parameters<FlueLogger["info"]>[1];

export function logEvent(log: FlueLogger, message: string, attributes: LogAttributes): void {
  log.info(message, attributes);
  console.log(`[mimir] ${message}`, attributes);
}
