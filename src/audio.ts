import { spawn } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export function splitNarration(text: string, maxCharacters = 2_200): string[] {
    const sentences = text
        .trim()
        .split(/(?<=[।!?])\s+|\n+/u)
        .filter(Boolean);
    const chunks: string[] = [];
    let current = "";
    for (const sentence of sentences) {
        if (sentence.length > maxCharacters) {
            throw new Error(
                "A narration sentence exceeds the TTS character limit.",
            );
        }
        if (current && current.length + sentence.length + 1 > maxCharacters) {
            chunks.push(current);
            current = "";
        }
        current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) chunks.push(current);
    return chunks;
}

async function runFfmpeg(arguments_: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
        const process = spawn("ffmpeg", arguments_, { cwd, windowsHide: true });
        let errorOutput = "";
        process.stderr.on("data", (chunk) => {
            errorOutput = `${errorOutput}${chunk}`.slice(-4_000);
        });
        process.on("error", rejectPromise);
        process.on("close", (code) => {
      if (code === 0) resolvePromise();
            else
                rejectPromise(
                    new Error(`ffmpeg failed (${code}): ${errorOutput}`),
                );
        });
    });
}

export async function checkFfmpeg() {
    await runFfmpeg(["-version"]);
}

export async function renderMp3(
    chunks: string[],
    synthesize: (text: string, index: number, total: number) => Promise<Buffer>,
    output: string,
): Promise<void> {
    if (!chunks.length) throw new Error("There is no narration to synthesize.");
    const destination = resolve(output);
    const temporaryOutput = join(
        dirname(destination),
        `.${basename(destination)}.${randomUUID()}.tmp.mp3`,
    );
    const directory = await mkdtemp(join(tmpdir(), "kundli-audio-"));
    try {
        const names: string[] = [];
        for (let index = 0; index < chunks.length; index += 1) {
            const name = `${String(index).padStart(4, "0")}.wav`;
            const chunk = chunks[index];
            if (!chunk) throw new Error("Narration chunk is empty.");
            const audio = await synthesize(chunk, index, chunks.length);
            await writeFile(join(directory, name), audio);
            names.push(name);
        }
        await writeFile(
            join(directory, "files.txt"),
            names.map((name) => `file '${name}'`).join("\n"),
        );
        await runFfmpeg(
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                "files.txt",
                "-ac",
                "1",
                "-ar",
                "24000",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "128k",
                temporaryOutput,
            ],
            directory,
        );
        await rename(temporaryOutput, destination);
    } finally {
        await rm(temporaryOutput, { force: true });
        const root = resolve(tmpdir());
        if (
            directory.startsWith(`${root}${sep}`) &&
            basename(directory).startsWith("kundli-audio-")
        ) {
            await rm(directory, { recursive: true, force: true });
        }
    }
}
