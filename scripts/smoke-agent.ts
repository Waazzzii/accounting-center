/**
 * smoke-agent.ts — bounded smoke test for one agent.
 *
 *   npx tsx scripts/smoke-agent.ts center/audit-log-reader [holdMs=3000]
 *
 * Exercises: module load, start(), N ms of runtime, stop(), clean exit.
 * Returns non-zero on any thrown error so CI can gate on it.
 */
import { rootLogger } from "@shared/logger.js";

const log = rootLogger.child({ component: "smoke" });

async function main() {
  const target = process.argv[2];
  const holdMs = parseInt(process.argv[3] ?? "3000", 10);
  if (!target) {
    log.error("usage: smoke-agent.ts <product>/<slug> [holdMs]");
    process.exit(1);
  }
  const [product, slug] = target.split("/");
  const modulePath = `../src/agents/${product}/${slug}/index.ts`;

  log.info({ target, modulePath, holdMs }, "smoke: loading module");
  const mod = (await import(modulePath)) as {
    default: { start: () => Promise<void>; stop: () => Promise<void> };
  };
  const agent = mod.default;

  log.info("smoke: calling start()");
  await agent.start();

  log.info({ holdMs }, "smoke: running");
  await new Promise((r) => setTimeout(r, holdMs));

  log.info("smoke: calling stop()");
  await agent.stop();

  log.info("smoke: OK");
  process.exit(0);
}

main().catch((err) => {
  log.fatal({ err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, "smoke: failed");
  process.exit(1);
});
