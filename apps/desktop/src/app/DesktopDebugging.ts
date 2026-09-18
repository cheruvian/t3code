interface DebugCommandLine {
  readonly hasSwitch: (name: string) => boolean;
  readonly appendSwitch: (name: string, value: string) => void;
}

/** Configure renderer debugging before Electron is ready. Explicit CLI ports take precedence. */
export function configureDesktopDebugging(
  commandLine: DebugCommandLine,
  portValue: string | undefined,
): void {
  const port = portValue?.trim();
  if (!port || commandLine.hasSwitch("remote-debugging-port")) return;

  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("T3CODE_DESKTOP_DEBUG_PORT must be an integer between 1 and 65535.");
  }

  commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  commandLine.appendSwitch("remote-debugging-port", String(Number(port)));
}
