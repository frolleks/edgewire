import type { MessagePayload } from "@edgewire/types";

export const dedupeChronological = (
  messages: MessagePayload[],
): MessagePayload[] => {
  const seen = new Set<string>();
  const next: MessagePayload[] = [];

  for (const item of [...messages].reverse()) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    next.push(item);
  }

  return next;
};

export const dedupeById = <T extends { id: string }>(items: T[]): T[] => {
  const indexById = new Map<string, number>();
  const next: T[] = [];

  for (const item of items) {
    const existingIndex = indexById.get(item.id);
    if (existingIndex === undefined) {
      indexById.set(item.id, next.length);
      next.push(item);
      continue;
    }

    next[existingIndex] = item;
  }

  return next;
};
