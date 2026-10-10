function commonPrefix(names: string[]) {
  let prefix = Array.from(names[0] ?? "");
  for (const name of names.slice(1)) {
    const characters = Array.from(name);
    let length = 0;
    while (length < prefix.length && prefix[length] === characters[length]) length++;
    prefix = prefix.slice(0, length);
  }
  return prefix.join("");
}

/** Jump between meaningful name splits, skipping shared namespaces such as knowledge-. */
export function quickCommandNavigation<T>(
  items: readonly T[],
  prefix: string,
  name: (item: T) => string,
) {
  const matches = items.filter((item) => name(item).startsWith(prefix));
  const groups = new Map<string, T[]>();
  if (matches.length > 1) {
    for (const item of matches) {
      const letter = Array.from(name(item).slice(prefix.length))[0];
      if (!letter) continue;
      const group = groups.get(letter) ?? [];
      group.push(item);
      groups.set(letter, group);
    }
  }
  const branches = Array.from(groups, ([letter, entries]) => ({
    letter,
    count: entries.length,
    prefix: commonPrefix(entries.map(name)),
  })).sort((a, b) => b.count - a.count || a.letter.localeCompare(b.letter));
  const ranked = matches.sort((a, b) => {
    const aName = name(a);
    const bName = name(b);
    const aLetter = Array.from(aName.slice(prefix.length))[0] ?? "";
    const bLetter = Array.from(bName.slice(prefix.length))[0] ?? "";
    return (
      (groups.get(bLetter)?.length ?? 0) - (groups.get(aLetter)?.length ?? 0) ||
      aName.localeCompare(bName)
    );
  });
  return { matches: ranked, branches };
}
