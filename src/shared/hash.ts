/**
 * hash.ts — client-side mirror of the Postgres `sha256_hex` function.
 *
 * Used to compute idempotency keys before inserting. The server-side
 * audit-log chain is computed by the DB trigger; this is only for
 * application-level idempotency.
 */

import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Build an idempotency key from ordered parts. Null/undefined are
 * rendered as empty strings so identical logical inputs always produce
 * identical keys regardless of which field was missing.
 */
export function idempotencyKey(...parts: (string | number | null | undefined)[]): string {
  const canonical = parts.map((p) => (p === null || p === undefined ? "" : String(p))).join("|");
  return sha256Hex(canonical);
}
