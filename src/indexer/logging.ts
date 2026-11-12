import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_BACKUPS = 3;

export interface LoggerOptions {
  logPath: string;
  maxBytes?: number;
  backups?: number;
}

export class RotatingLogger {
  private readonly logPath: string;
  private readonly maxBytes: number;
  private readonly backups: number;

  constructor(options: LoggerOptions) {
    this.logPath = options.logPath;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.backups = options.backups ?? DEFAULT_BACKUPS;
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true, mode: 0o700 });
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("INFO", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("WARN", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("ERROR", message, fields);
  }

  private write(level: string, message: string, fields?: Record<string, unknown>): void {
    try {
      this.rotateIfNeeded();
      const entry = {
        ts: new Date().toISOString(),
        level,
        msg: message,
        ...(fields ?? {}),
      };
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch {
      /* never throw from logger */
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.logPath)) return;
      const stat = fs.statSync(this.logPath);
      if (stat.size < this.maxBytes) return;

      for (let i = this.backups - 1; i >= 1; i--) {
        const src = `${this.logPath}.${i}`;
        const dest = `${this.logPath}.${i + 1}`;
        if (fs.existsSync(src)) {
          try {
            fs.renameSync(src, dest);
          } catch {
            /* ignore */
          }
        }
      }
      try {
        fs.renameSync(this.logPath, `${this.logPath}.1`);
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }
}
