declare const __T3CODE_BUILD_COMMIT__: string | undefined;

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

export function normalizeT3CodeCommit(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return COMMIT_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function getEmbeddedT3CodeCommit(): string | null {
  return normalizeT3CodeCommit(
    typeof __T3CODE_BUILD_COMMIT__ === "undefined" ? null : __T3CODE_BUILD_COMMIT__,
  );
}

export function t3CodeCommitsMatch(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && (left.startsWith(right) || right.startsWith(left));
}
