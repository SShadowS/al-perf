import { readdir } from "fs/promises";

let counter = 0;
const FOLDER_PATTERN = /^(\d+)_/;

export async function initIdCounter(debugDir: string): Promise<void> {
  let maxId = 0;
  try {
    const entries = await readdir(debugDir);
    for (const entry of entries) {
      const match = entry.match(FOLDER_PATTERN);
      if (match) {
        const id = parseInt(match[1], 10);
        if (id > maxId) maxId = id;
      }
    }
  } catch {
    // Directory doesn't exist yet
  }
  counter = maxId;
}

export function nextId(): number {
  return ++counter;
}
