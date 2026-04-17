/**
 * run-agent.ts — CLI entry for launching a single agent by slug.
 *
 *   pnpm agent trustsync/trust-balance-calculator
 *   pnpm agent center/accounting-orchestrator
 *
 * Loads the module, instantiates, calls start(), and hooks SIGINT/SIGTERM.
 */

import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "cli" });

async function main() {
  const target = process.argv[2];
  if (!target) {
    log.error("Usage: tsx src/cli/run-agent.ts <product>/<agent-slug>");
    process.exit(1);
  }

  const [product, slug] = target.split("/");
  if (!product || !slug) {
    log.error({ target }, "expected <product>/<agent-slug>");
    process.exit(1);
  }

  const modulePath = `../agents/${product}/${slug}/index.js`;
  let mod: { default: { start: () => Promise<void>; stop: () => Promise<void> } };
  try {
    mod = (await import(modulePath)) as typeof mod;
  } catch (err) {
    log.error({ err, modulePath }, "failed to load agent module");
    process.exit(1);
  }

  const agent = mod.default;
  await agent.start();

  const shutdown = async (sig: string) => {
    log.info({ sig }, "shutting down");
    try {
      await agent.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ err }, "agent crashed");
  process.exit(1);
});
