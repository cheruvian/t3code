import { type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import { assetEnvironment } from "~/state/assets";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { toastManager } from "~/components/ui/toast";

function startFileDownload(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** Downloads a host file through the destination environment's signed asset route. */
export function useHostFileDownload(environmentId: EnvironmentId | null) {
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(
    async (absolutePath: string) => {
      if (environmentId === null) return;
      try {
        const connection = readPreparedConnection(environmentId);
        if (connection === null) throw new Error("Reconnect to this environment and try again.");
        const resource = { _tag: "host-file-download" as const, path: absolutePath };
        const result = await createAssetUrl({ environmentId, input: { resource } });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
        if (url === null) throw new Error("The environment returned an invalid download URL.");
        startFileDownload(url, absolutePath.split(/[\\/]/).at(-1) ?? "download");
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not download file",
          description: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [createAssetUrl, environmentId],
  );
}
