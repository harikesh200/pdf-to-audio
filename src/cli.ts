import { dirname, join, resolve } from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { extractPdf } from "./pdf.ts";
import {
    acceptFacts,
    planSections,
    sourceUnits,
    spokenChapters,
} from "./source.ts";
import type { Fact } from "./source.ts";
import { ProviderError } from "./http.ts";
import { OpenAI } from "./openai.ts";
import { Sarvam, VOICE } from "./sarvam.ts";
import { EXTRACTION_PROMPT, extractFacts, NARRATION_PROMPT, planEpisode, PLANNING_PROMPT, ScriptRejected, writeSection } from "./script.ts";
import type { EpisodePlan, SectionGuide, TextModel } from "./script.ts";
import { checkFfmpeg, renderMp3, splitNarration } from "./audio.ts";
import { cached, cachedBuffer } from "./cache.ts";
import { UsageLog } from "./usage.ts";

const usage = new UsageLog();

async function main() {
    const args = process.argv.slice(2);
    const [inputArgument, outputArgument, ...flags] = args;
    let preview = false;
    let llm = "luna";
    let validFlags = true;
    for (let index = 0; index < flags.length; index += 1) {
        const flag = flags[index];
        if (flag === "--preview" && !preview) preview = true;
        else if (flag === "--llm" && ["sarvam", "luna"].includes(flags[index + 1] ?? "")) llm = flags[++index] ?? llm;
        else validFlags = false;
    }
    if (
        !validFlags ||
        !inputArgument ||
        !outputArgument ||
        !/\.pdf$/i.test(inputArgument) ||
        !/\.mp3$/i.test(outputArgument)
    ) {
        throw new Error("Usage: npm start -- <report.pdf> <output.mp3> [--preview] [--llm luna|sarvam]");
    }
    const input = resolve(inputArgument);
    const output = resolve(outputArgument);
    if (input === output)
        throw new Error("Input and output paths must differ.");
    const inputFile = await stat(input);
    if (!inputFile.isFile()) throw new Error("The PDF input must be a file.");
    const outputDirectory = await stat(dirname(output));
    if (!outputDirectory.isDirectory()) throw new Error("The MP3 output directory must exist.");
    const config = z
        .object({ SARVAM_API_KEY: z.string().min(1) })
        .safeParse(process.env);
    if (!config.success)
        throw new Error("Set SARVAM_API_KEY before generating audio.");
    const client = new Sarvam(config.data.SARVAM_API_KEY, undefined, usage);
    let writer: TextModel = client;
    if (llm === "luna") {
        const openAiKey = z.string().min(1).safeParse(process.env.OPENAI_API_KEY);
        if (!openAiKey.success) throw new Error("Set OPENAI_API_KEY to write the script with GPT-6 Luna.");
        writer = new OpenAI(openAiKey.data, undefined, usage);
    }
    await checkFfmpeg();
    const workDirectory = `${output}.work`;
    await mkdir(workDirectory, { recursive: true });

    const document = await extractPdf(input);
    const plannedSections = planSections(document.chapters);
    const sections = preview ? plannedSections.slice(0, 1) : plannedSections;
    const activeChapters = spokenChapters(document.chapters).filter((chapter) =>
        sections.some((section) => chapter.number >= section.first && chapter.number <= section.last),
    );
    const units = sourceUnits(document.pages, activeChapters);
    const facts: Fact[] = [];
    process.stdout.write(
        `Extracted ${document.pages.length} pages and ${activeChapters.length} report chapters. Writing with ${writer.id}.\n`,
    );
    for (let index = 0; index < units.length; index += 1) {
        process.stdout.write(
            `Reading source batch ${index + 1}/${units.length}...\n`,
        );
        const unit = units[index];
        if (!unit) throw new Error('Source batch is missing.');
        const verifiedFacts = await cached(
            join(workDirectory, `facts-${index + 1}.json`),
            { model: writer.id, prompt: EXTRACTION_PROMPT, unit },
            async () => {
                for (let attempt = 1; attempt <= 3; attempt += 1) {
                    let rawFacts;
                    try {
                        rawFacts = await extractFacts(writer, unit);
                    } catch (error) {
                        if (!(error instanceof ProviderError) || !error.message.includes("token limit") || unit.length < 2) throw error;
                        process.stdout.write(`Splitting source batch ${index + 1} after response limit...\n`);
                        rawFacts = (await Promise.all(unit.map((page) => extractFacts(writer, [page])))).flat();
                    }
                    const accepted = acceptFacts(rawFacts, unit, 1);
                    if (accepted.length < rawFacts.length) {
                        process.stdout.write(`Skipped ${rawFacts.length - accepted.length} unverified source facts.\n`);
                    }
                    const covered = new Set(accepted.map((fact) => fact.chapter));
                    if (unit.every((page) => covered.has(page.chapter))) {
                        return accepted.map(({ chapter, page, quote, hindi }) => ({ chapter, page, quote, hindi }));
                    }
                    if (attempt < 3) {
                        process.stdout.write(`Retrying source batch ${index + 1} (${attempt}/3)...\n`);
                    }
                }
                throw new Error(`No verified facts in source batch ${index + 1}.`);
            },
        );
        facts.push(...acceptFacts(verifiedFacts, unit, facts.length + 1));
    }

    const coveredChapters = new Set(facts.map((fact) => fact.chapter));
    const missing = activeChapters.filter(
        (chapter) => !coveredChapters.has(chapter.number),
    );
    if (missing.length) {
        throw new Error(
            `No verified facts for chapters: ${missing.map((chapter) => chapter.number).join(", ")}.`,
        );
    }

    let plan: EpisodePlan | undefined;
    const reportPages = sourceUnits(document.pages, spokenChapters(document.chapters)).flat();
    if (writer.readsWholeReport) {
        process.stdout.write("Planning the episode from the whole report...\n");
        plan = await cached(
            join(workDirectory, "plan.json"),
            { model: writer.id, prompt: PLANNING_PROMPT, sections: plannedSections, reportPages, cover: document.cover },
            async () => {
                for (let attempt = 1; attempt <= 3; attempt += 1) {
                    try {
                        return await planEpisode(writer, reportPages, plannedSections, document.cover);
                    } catch (error) {
                        if (attempt === 3 || !(error instanceof ScriptRejected)) throw error;
                        process.stdout.write(`${error.message} Retrying (${attempt}/3)...\n`);
                    }
                }
                throw new Error("Could not plan the episode.");
            },
        );
    }
    // Plan evidence gets fact IDs after the extracted facts so both can be cited in covered_ids.
    let nextId = facts.length + 1;
    const threadFacts = (plan?.threads ?? []).map((thread) => {
        const accepted = acceptFacts(thread.evidence, reportPages, nextId);
        nextId += accepted.length;
        return accepted;
    });

    const narration: string[] = [];
    for (const [index, section] of sections.entries()) {
        const sectionFacts = facts.filter(
            (fact) =>
                fact.chapter >= section.first && fact.chapter <= section.last,
        );
        process.stdout.write(
            `Writing Hindi section ${index + 1}/${sections.length}...\n`,
        );
        const previous = narration.join("\n\n");
        const part = plan?.sections[index];
        const guide: SectionGuide | undefined = plan && part
            ? {
                arc: plan.arc,
                focus: part.focus,
                threads: part.threads.flatMap((thread) => plan.threads[thread] ?? []),
                evidence: part.threads.flatMap((thread) => threadFacts[thread] ?? []),
            }
            : undefined;
        narration.push(await cached(
            join(workDirectory, `section-${index + 1}.json`),
            { model: writer.id, prompt: NARRATION_PROMPT, section, index, total: sections.length, sectionFacts, cover: document.cover, previous, guide },
            async () => {
                for (let attempt = 1; attempt <= 3; attempt += 1) {
                    try {
                        return await writeSection(writer, section, sectionFacts, document.cover, index, sections.length, previous, guide);
                    } catch (error) {
                        if (attempt === 3 || !(error instanceof ScriptRejected)) throw error;
                        process.stdout.write(`${error.message} Retrying Hindi section ${index + 1} (${attempt}/3)...\n`);
                    }
                }
                throw new Error(`Could not write Hindi section ${index + 1}.`);
            },
        ));
    }
    const script = narration.join("\n\n");
    const segments = splitNarration(narration);
    const pauseSeconds = segments.reduce((total, segment) => total + segment.pauseAfter, 0);
    const transcript = output.replace(/\.mp3$/i, ".txt");
    await writeFile(transcript, `${script}\n`, "utf8");
    process.stdout.write(`Saved narration script ${transcript}\n`);
    process.stdout.write(
        `Synthesizing ${segments.length} single-voice audio segments with ${Math.round(pauseSeconds)} seconds of pauses...\n`,
    );
    const voiceDirectory = join(workDirectory, "voice");
    await mkdir(voiceDirectory, { recursive: true });
    await renderMp3(
        segments,
        async (text, index, total) => {
            const { data, reused } = await cachedBuffer(
                voiceDirectory,
                { voice: VOICE, text },
                () => client.synthesize(text),
                (audio) => audio.length > 44 && audio.toString("ascii", 0, 4) === "RIFF" && audio.toString("ascii", 8, 12) === "WAVE",
            );
            process.stdout.write(`Voice ${index + 1}/${total}${reused ? " (saved)" : ""}\n`);
            return data;
        },
        output,
    );
    process.stdout.write(`Saved ${resolve(output)}\n`);
}

main()
    .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    })
    .finally(() => process.stdout.write(usage.summary()));
