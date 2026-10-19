import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_PREFERENCES, validatePreferences } from "./state.js";

export async function loadPreferences(path) {
  try { return validatePreferences(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) return { ...DEFAULT_PREFERENCES };
    throw error;
  }
}

/** Serialize writes so a fast slider cannot let an older value overwrite a newer one. */
export function createPreferenceWriter(path) {
  let queue = Promise.resolve();
  return function save(value) {
    const validated = validatePreferences(value);
    const operation = queue.catch(() => {}).then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(validated, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(() => {}); }
    });
    queue = operation;
    return operation;
  };
}
