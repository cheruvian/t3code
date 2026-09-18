import { describe, expect, it, vi } from "vite-plus/test";

import { configureDesktopDebugging } from "./DesktopDebugging.ts";

describe("configureDesktopDebugging", () => {
  it.each([undefined, "", "   "])("leaves debugging disabled for %s", (value) => {
    const commandLine = { hasSwitch: () => false, appendSwitch: vi.fn() };
    configureDesktopDebugging(commandLine, value);
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it.each(["1", " 9222 ", "65535"])("configures a loopback port for %s", (value) => {
    const commandLine = { hasSwitch: () => false, appendSwitch: vi.fn() };
    configureDesktopDebugging(commandLine, value);
    expect(commandLine.appendSwitch.mock.calls).toEqual([
      ["remote-debugging-address", "127.0.0.1"],
      ["remote-debugging-port", value.trim()],
    ]);
  });

  it.each(["0", "-1", "65536", "9222.5", "1e3", "9222junk", "localhost:9222"])(
    "rejects invalid ports without enabling debugging: %s",
    (value) => {
      const commandLine = { hasSwitch: () => false, appendSwitch: vi.fn() };
      expect(() => configureDesktopDebugging(commandLine, value)).toThrow(
        "T3CODE_DESKTOP_DEBUG_PORT must be an integer between 1 and 65535.",
      );
      expect(commandLine.appendSwitch).not.toHaveBeenCalled();
    },
  );

  it("preserves an explicit command-line debugging port", () => {
    const commandLine = {
      hasSwitch: (name: string) => name === "remote-debugging-port",
      appendSwitch: vi.fn(),
    };
    configureDesktopDebugging(commandLine, "9222");
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});
