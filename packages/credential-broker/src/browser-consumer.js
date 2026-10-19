import { readFile } from "node:fs/promises";

// Only this supervised process reads the lease; delivery stays on the private loopback bridge.
// Output is discarded by the broker. A lost connection aborts the private sign-in page.
const endpoint = process.env.CB_BROWSER_ENDPOINT;
const file = process.env.CB_CREDENTIAL_FILE;
if (!endpoint || !file) process.exitCode = 1;
else {
  try {
    const url = new URL(endpoint);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error();
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await readFile(file, "utf8"),
    });
    if (!response.ok || (await response.text()) !== "ok") process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}
