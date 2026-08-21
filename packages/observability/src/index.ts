export type LogContext = Readonly<Record<string, string | number | boolean | undefined>>;

export function createLogger(service: string) {
  const write = (level: string, message: string, context: LogContext = {}) => {
    const safeContext = Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, service, message, ...safeContext }));
  };
  return {
    debug: (message: string, context?: LogContext) => write("debug", message, context),
    info: (message: string, context?: LogContext) => write("info", message, context),
    warn: (message: string, context?: LogContext) => write("warn", message, context),
    error: (message: string, context?: LogContext) => write("error", message, context),
  };
}
