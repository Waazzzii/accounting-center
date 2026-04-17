/**
 * validate-events.ts — lint config/events.yaml.
 *
 * Checks:
 *   - each event has a unique `type`
 *   - `type` follows `<product>.<entity>.<verb>` convention
 *   - `source` is a known product_code
 *   - version is >= 1
 */

import { eventsCatalog } from "@shared/config.js";
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "validate-events" });

const KNOWN_PRODUCTS = new Set([
  "trustsync",
  "otaauditor",
  "revpost",
  "chargeback",
  "utility",
  "center",
]);

function main() {
  const catalog = eventsCatalog();
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const ev of catalog.events) {
    if (seen.has(ev.type)) issues.push(`duplicate event_type: ${ev.type}`);
    seen.add(ev.type);

    if (!/^[a-z_]+\.[a-z_]+\.[a-z_]+$/.test(ev.type)) {
      issues.push(`event_type "${ev.type}" does not match <product>.<entity>.<verb>`);
    }

    if (!KNOWN_PRODUCTS.has(ev.source)) {
      issues.push(`event "${ev.type}" has unknown source "${ev.source}"`);
    }

    if (!ev.version || ev.version < 1) {
      issues.push(`event "${ev.type}" has invalid version`);
    }

    if (!ev.description || ev.description.length < 5) {
      issues.push(`event "${ev.type}" has missing/short description`);
    }
  }

  if (issues.length === 0) {
    log.info({ count: catalog.events.length }, "events catalog is valid");
    return;
  }

  for (const issue of issues) log.error(issue);
  log.fatal({ issueCount: issues.length }, "events catalog has issues");
  process.exit(1);
}

main();
