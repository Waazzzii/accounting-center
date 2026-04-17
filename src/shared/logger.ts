/**
 * logger.ts — pino-based structured logger.
 *
 * Every log line is JSON in production (for ingestion into downstream tools)
 * and pretty-printed in development. Agents get a child logger keyed by
 * product + agent slug so logs are automatically tagged.
 */

import pino, { type Logger, type LoggerOptions } from "pino";
import { env, isProduction } from "./env.js";

const base: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: {
    service: "accounting-center",
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "*.password",
      "*.token",
      "*.apiKey",
      "*.api_key",
      "*.secret",
      "*.authorization",
      "*.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
};

const options: LoggerOptions = isProduction
  ? base
  : {
      ...base,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname,service,env",
        },
      },
    };

export const rootLogger: Logger = pino(options);

export function agentLogger(product: string, agent: string): Logger {
  return rootLogger.child({ product, agent });
}

export type { Logger };
