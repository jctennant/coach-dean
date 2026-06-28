const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

export interface LogContext {
  agentName: string;
  correlationId: string;
  userId?: string;
  trigger?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(extra: Partial<LogContext>): Logger;
}

function getMinLevel(): Level {
  const env = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (env in LEVELS ? env : "info") as Level;
}

function emit(level: Level, ctx: LogContext, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[getMinLevel()]) return;
  const line = JSON.stringify({ level, message: msg, ts: new Date().toISOString(), ...ctx, ...meta });
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function createLogger(ctx: LogContext): Logger {
  return {
    debug: (msg, meta) => emit("debug", ctx, msg, meta),
    info:  (msg, meta) => emit("info",  ctx, msg, meta),
    warn:  (msg, meta) => emit("warn",  ctx, msg, meta),
    error: (msg, meta) => {
      emit("error", ctx, msg, meta);
      // Fire-and-forget Sentry capture — never throws
      import("@sentry/nextjs")
        .then(({ captureException }) => {
          const err = meta?.error instanceof Error ? meta.error : new Error(msg);
          captureException(err, { tags: { agentName: ctx.agentName, correlationId: ctx.correlationId, trigger: ctx.trigger } });
        })
        .catch(() => {});
    },
    child: (extra) => createLogger({ ...ctx, ...extra }),
  };
}
