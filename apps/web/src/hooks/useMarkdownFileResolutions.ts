import { useEffect, useMemo, useState } from "react";
import type { EnvironmentId, ProjectResolvedFilePath } from "@t3tools/contracts";
import {
  collectMarkdownFilePaths,
  type MarkdownFileResolutions,
} from "@t3tools/client-runtime/markdown-file-resolution";
import { projectEnvironment } from "~/state/projects";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

const EMPTY: MarkdownFileResolutions = new Map();

/** Queries are scoped to the environment and workspace, never written back to messages. */
export function useMarkdownFileResolutions(
  text: string,
  environmentId: EnvironmentId | null,
  cwd?: string,
  baseDir?: string,
) {
  const pathsKey = JSON.stringify(useMemo(() => collectMarkdownFilePaths(text), [text]));
  const key = JSON.stringify([environmentId, cwd, baseDir, pathsKey]);
  const resolve = useAtomQueryRunner(projectEnvironment.resolveFilePaths, { reportFailure: false });
  const [state, setState] = useState<{ key: string; paths: MarkdownFileResolutions } | null>(null);
  useEffect(() => {
    if (!environmentId || !cwd) return;
    const paths: string[] = JSON.parse(pathsKey);
    if (paths.length === 0) return;
    let current = true;
    void (async () => {
      const entries: ProjectResolvedFilePath[] = [];
      // Bound each request and process batches sequentially, including long reports.
      for (let start = 0; start < paths.length; start += 128) {
        if (!current) return;
        const result = await resolve({
          environmentId,
          input: { cwd, ...(baseDir ? { baseDir } : {}), paths: paths.slice(start, start + 128) },
        });
        if (result._tag === "Success") entries.push(...result.value);
      }
      if (current) setState({ key, paths: new Map(entries.map((entry) => [entry.path, entry])) });
    })();
    return () => {
      current = false;
    };
  }, [environmentId, cwd, baseDir, key, pathsKey, resolve]);
  return state?.key === key ? state.paths : EMPTY;
}
