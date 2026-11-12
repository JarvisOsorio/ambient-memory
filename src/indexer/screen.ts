import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ScreenSnapshot {
  appName: string;
  windowTitle: string;
  provider: string;
  capturedAt: number;
}

export type ScreenProviderName = "auto" | "simulated" | "none" | "xdotool" | "osascript";

export interface ScreenProvider {
  name: string;
  capture(): Promise<ScreenSnapshot | null>;
}

export interface ScreenProbeResult {
  preference: ScreenProviderName;
  resolved: string;
  platform: NodeJS.Platform;
  display: string | undefined;
  tools: { xdotool: boolean; osascript: boolean };
  sample: ScreenSnapshot | null;
  note: string;
}

/** Deterministic simulated provider for headless CI / demos. */
export class SimulatedScreenProvider implements ScreenProvider {
  name = "simulated";
  private tick = 0;
  private readonly frames: Array<{ appName: string; windowTitle: string }>;

  constructor(
    frames: Array<{ appName: string; windowTitle: string }> = [
      { appName: "Cursor", windowTitle: "ambient-memory — README.md" },
      { appName: "Terminal", windowTitle: "npm test — ambient-memory" },
      { appName: "Firefox", windowTitle: "Model Context Protocol — docs" },
    ],
  ) {
    this.frames = frames.length > 0 ? frames : [{ appName: "Ambient", windowTitle: "idle" }];
  }

  async capture(): Promise<ScreenSnapshot> {
    const frame = this.frames[this.tick % this.frames.length]!;
    this.tick += 1;
    return {
      appName: frame.appName,
      windowTitle: frame.windowTitle,
      provider: this.name,
      capturedAt: Date.now(),
    };
  }
}

export class NoneScreenProvider implements ScreenProvider {
  name = "none";
  async capture(): Promise<null> {
    return null;
  }
}

export class XdotoolScreenProvider implements ScreenProvider {
  name = "xdotool";

  async capture(): Promise<ScreenSnapshot | null> {
    try {
      const { stdout: winId } = await execFileAsync("xdotool", ["getactivewindow"], {
        timeout: 2000,
      });
      const id = winId.trim();
      if (!id) return null;
      const [{ stdout: title }, { stdout: cls }] = await Promise.all([
        execFileAsync("xdotool", ["getwindowname", id], { timeout: 2000 }),
        execFileAsync("xdotool", ["getwindowclassname", id], { timeout: 2000 }).catch(() => ({
          stdout: "unknown",
        })),
      ]);
      const appName = (cls.trim() || "unknown").slice(0, 200);
      const windowTitle = (title.trim() || "untitled").slice(0, 500);
      return {
        appName,
        windowTitle,
        provider: this.name,
        capturedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }
}

export class OsascriptScreenProvider implements ScreenProvider {
  name = "osascript";

  async capture(): Promise<ScreenSnapshot | null> {
    const script = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set winTitle to ""
        try
          set winTitle to name of front window of frontApp
        end try
        return appName & "|||" & winTitle
      end tell
    `;
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 3000 });
      const [appName, windowTitle] = stdout.trim().split("|||");
      return {
        appName: (appName || "unknown").slice(0, 200),
        windowTitle: (windowTitle || "untitled").slice(0, 500),
        provider: this.name,
        capturedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

function hasDisplay(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Resolve a screen provider.
 * - simulated: always works (CI/demo)
 * - auto: xdotool (Linux+DISPLAY) → osascript (macOS) → none
 * - Forced xdotool/osascript keep the provider even if first capture fails (desktop may unlock later)
 */
export async function resolveScreenProvider(
  preference: ScreenProviderName = "auto",
  simulated?: SimulatedScreenProvider,
): Promise<ScreenProvider> {
  if (preference === "none") return new NoneScreenProvider();
  if (preference === "simulated") return simulated ?? new SimulatedScreenProvider();

  if (preference === "xdotool") {
    if (!(await commandExists("xdotool"))) return new NoneScreenProvider();
    return new XdotoolScreenProvider();
  }

  if (preference === "osascript") {
    if (process.platform !== "darwin" || !(await commandExists("osascript"))) {
      return new NoneScreenProvider();
    }
    return new OsascriptScreenProvider();
  }

  // auto
  if (process.platform === "linux" && hasDisplay() && (await commandExists("xdotool"))) {
    const p = new XdotoolScreenProvider();
    const sample = await p.capture();
    if (sample) return p;
    // Tool present but capture failed (e.g. brief race) — still prefer xdotool over none
    return p;
  }

  if (process.platform === "darwin" && (await commandExists("osascript"))) {
    return new OsascriptScreenProvider();
  }

  return new NoneScreenProvider();
}

/** Probe what screen capture would do on this machine (for status / docs / smoke). */
export async function probeScreen(preference: ScreenProviderName = "auto"): Promise<ScreenProbeResult> {
  const tools = {
    xdotool: await commandExists("xdotool"),
    osascript: await commandExists("osascript"),
  };
  const provider = await resolveScreenProvider(preference);
  const sample = await provider.capture();
  let note = "";
  if (provider.name === "none") {
    note =
      "No active-window helper available (install xdotool on X11 Linux, or use --screen simulated).";
  } else if (provider.name === "simulated") {
    note = "Using deterministic simulated frames (CI / headless).";
  } else if (!sample) {
    note = `Provider ${provider.name} selected but capture returned null (permissions or no focused window).`;
  } else {
    note = `Provider ${provider.name} captured actively.`;
  }
  return {
    preference,
    resolved: provider.name,
    platform: process.platform,
    display: process.env.DISPLAY || process.env.WAYLAND_DISPLAY,
    tools,
    sample,
    note,
  };
}
