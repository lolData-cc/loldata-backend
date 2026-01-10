// src/server/logger.ts
type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// es: LOG_LEVEL=debug / info / warn / error
const CURRENT_LEVEL: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[CURRENT_LEVEL];
}

function ts() {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function fmtMeta(meta?: Record<string, unknown>) {
  if (!meta) return "";
  const entries = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return entries.length ? " " + entries.join(" ") : "";
}

function baseLog(
  level: LogLevel,
  code: string,
  message: string,
  meta?: Record<string, unknown>
) {
  if (!shouldLog(level)) return;

  const emoji =
    level === "debug"
      ? "🔍"
      : level === "info"
      ? "ℹ️"
      : level === "warn"
      ? "⚠️"
      : "❌";

  const line = `[${ts()}] ${emoji} ${code} - ${message}${fmtMeta(meta)}`;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (code: string, msg: string, meta?: Record<string, unknown>) =>
    baseLog("debug", code, msg, meta),
  info: (code: string, msg: string, meta?: Record<string, unknown>) =>
    baseLog("info", code, msg, meta),
  warn: (code: string, msg: string, meta?: Record<string, unknown>) =>
    baseLog("warn", code, msg, meta),
  error: (code: string, msg: string, meta?: Record<string, unknown>) =>
    baseLog("error", code, msg, meta),

  request: (req: Request, pathname: string) => {
    baseLog("info", "HTTP_REQ", `${req.method} ${pathname}`);
  },

  response: (
    req: Request,
    pathname: string,
    status: number,
    ms: number
  ) => {
    baseLog("info", "HTTP_RES", `${req.method} ${pathname} -> ${status}`, {
      ms,
    });
  },

  supabaseError: (context: string, err: any) => {
    baseLog(
      "error",
      "SUPABASE_ERR",
      `${context}: ${err?.message ?? "Supabase error"}`,
      {
        code: err?.code,
        details: err?.details,
        hint: err?.hint,
      }
    );
  },

  riot429: (context: string, url: string, retryAfterMs?: number) => {
    baseLog(
      "warn",
      "RIOT_429",
      `${context}: rate limit Riot API`,
      { url, retryAfterMs }
    );
  },
};
