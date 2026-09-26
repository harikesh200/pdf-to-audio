import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function cached<T>(path: string, input: unknown, generate: () => Promise<T>): Promise<T> {
    const key = createHash("sha256")
        .update(JSON.stringify({ version: 1, input }))
        .digest("hex");
    try {
        const entry = JSON.parse(await readFile(path, "utf8")) as { key: string; value: T };
        if (entry?.key === key) return entry.value;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
            throw error;
        }
    }
    const value = await generate();
    await writeFile(path, JSON.stringify({ key, value }), "utf8");
    return value;
}

// Saves binary results, such as voiced audio, under a name derived from their input.
// A missing or invalid file is generated again, so a failed run only pays for what it lost.
export async function cachedBuffer(
    directory: string,
    input: unknown,
    generate: () => Promise<Buffer>,
    isValid: (data: Buffer) => boolean,
): Promise<{ data: Buffer; reused: boolean }> {
    const key = createHash("sha256").update(JSON.stringify({ version: 1, input })).digest("hex").slice(0, 32);
    const path = join(directory, `${key}.bin`);
    try {
        const data = await readFile(path);
        if (isValid(data)) return { data, reused: true };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const data = await generate();
    const partial = `${path}.${process.pid}.tmp`;
    await writeFile(partial, data);
    await rename(partial, path);
    return { data, reused: false };
}
