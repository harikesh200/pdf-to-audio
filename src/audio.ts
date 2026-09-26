import { spawn } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

// Written by the narrator where the listener should stop and think; it becomes silence, never speech.
export const PAUSE_MARK = "[विराम]";

// Seconds of silence added after each kind of break. Bulbul has no SSML, so pauses are real silence.
export const PAUSE_SECONDS = { chunk: 0.35, paragraph: 0.9, thinking: 1.8, section: 2.2 };

export type Segment = { text: string; pauseAfter: number };

export function splitNarration(sections: string[], maxCharacters = 1_200): Segment[] {
    const segments: Segment[] = [];
    const pauseLast = (seconds: number) => {
        const last = segments.at(-1);
        if (last) last.pauseAfter = Math.max(last.pauseAfter, seconds);
    };
    for (const section of sections) {
        for (const paragraph of section.trim().split(/\n\s*\n/u).filter((text) => text.trim())) {
            const parts = paragraph.split(PAUSE_MARK);
            for (const [partIndex, part] of parts.entries()) {
                let current = "";
                for (const sentence of part.trim().split(/(?<=[।!?])\s+/u).filter(Boolean)) {
                    if (sentence.length > maxCharacters) {
                        throw new Error("A narration sentence exceeds the TTS character limit.");
                    }
                    if (current && current.length + 1 + sentence.length > maxCharacters) {
                        segments.push({ text: current, pauseAfter: PAUSE_SECONDS.chunk });
                        current = "";
                    }
                    current = current ? `${current} ${sentence}` : sentence;
                }
                if (current) segments.push({ text: current, pauseAfter: 0 });
                if (partIndex < parts.length - 1) pauseLast(PAUSE_SECONDS.thinking);
            }
            pauseLast(PAUSE_SECONDS.paragraph);
        }
        pauseLast(PAUSE_SECONDS.section);
    }
    const last = segments.at(-1);
    if (last) last.pauseAfter = 0;
    return segments;
}

// Builds silence in the same WAV format as the given audio so FFmpeg can join them without re-encoding.
export function silenceLike(wav: Buffer, seconds: number): Buffer {
    let offset = 12;
    while (offset + 8 <= wav.length) {
        const id = wav.toString("ascii", offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        if (id === "fmt ") {
            const format = wav.subarray(offset, offset + 8 + size + (size % 2));
            const sampleRate = wav.readUInt32LE(offset + 12);
            const blockAlign = wav.readUInt16LE(offset + 20);
            const bitsPerSample = wav.readUInt16LE(offset + 22);
            const dataSize = blockAlign * Math.round(sampleRate * seconds);
            const silence = Buffer.alloc(12 + format.length + 8 + dataSize, 0);
            silence.write("RIFF", 0, "ascii");
            silence.writeUInt32LE(silence.length - 8, 4);
            silence.write("WAVE", 8, "ascii");
            format.copy(silence, 12);
            silence.write("data", 12 + format.length, "ascii");
            silence.writeUInt32LE(dataSize, 16 + format.length);
            // Unsigned 8-bit PCM is silent at 128; every other PCM format is silent at zero.
            if (bitsPerSample === 8) silence.fill(0x80, 20 + format.length);
            return silence;
        }
        offset += 8 + size + (size % 2);
    }
    throw new Error("Speech audio has no WAV format header.");
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
    segments: Segment[],
    synthesize: (text: string, index: number, total: number) => Promise<Buffer>,
    output: string,
): Promise<void> {
    if (!segments.length) throw new Error("There is no narration to synthesize.");
    const destination = resolve(output);
    const temporaryOutput = join(
        dirname(destination),
        `.${basename(destination)}.${randomUUID()}.tmp.mp3`,
    );
    const directory = await mkdtemp(join(tmpdir(), "kundli-audio-"));
    try {
        const names: string[] = [];
        for (const [index, segment] of segments.entries()) {
            const name = `${String(index).padStart(4, "0")}.wav`;
            const audio = await synthesize(segment.text, index, segments.length);
            await writeFile(join(directory, name), audio);
            names.push(name);
            if (segment.pauseAfter > 0) {
                const pause = `${String(index).padStart(4, "0")}-pause.wav`;
                await writeFile(join(directory, pause), silenceLike(audio, segment.pauseAfter));
                names.push(pause);
            }
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
