import { dirname, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { extractPdf } from "./pdf.ts";
import {
    acceptFacts,
    planSections,
    sourceUnits,
    spokenChapters,
} from "./source.ts";
import type { Fact } from "./source.ts";
import { Sarvam } from "./sarvam.ts";
import { checkFfmpeg, renderMp3, splitNarration } from "./audio.ts";

async function main() {
    const args = process.argv.slice(2);
    const inputArgument = args[0];
    const outputArgument = args[1];
    if (
        args.length !== 2 ||
        !inputArgument ||
        !outputArgument ||
        !/\.pdf$/i.test(inputArgument) ||
        !/\.mp3$/i.test(outputArgument)
    ) {
        throw new Error("Usage: npm start -- <report.pdf> <output.mp3>");
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
    const apiKey = config.data.SARVAM_API_KEY;
    await checkFfmpeg();

    const document = await extractPdf(input);
    const activeChapters = spokenChapters(document.chapters);
    const units = sourceUnits(document.pages, document.chapters);
    const client = new Sarvam(apiKey);
    const facts: Fact[] = [];
    process.stdout.write(
        `Extracted ${document.pages.length} pages and ${activeChapters.length} report chapters.\n`,
    );
    for (let index = 0; index < units.length; index += 1) {
        process.stdout.write(
            `Reading source batch ${index + 1}/${units.length}...\n`,
        );
        const unit = units[index];
        if (!unit) throw new Error('Source batch is missing.');
        const rawFacts = await client.extractFacts(unit);
        facts.push(...acceptFacts(rawFacts, unit, facts.length + 1));
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

    const narration: string[] = [];
    const sections = planSections(document.chapters);
    for (const [index, section] of sections.entries()) {
        const sectionFacts = facts.filter(
            (fact) =>
                fact.chapter >= section.first && fact.chapter <= section.last,
        );
        process.stdout.write(
            `Writing Hindi section ${index + 1}/${sections.length}...\n`,
        );
        narration.push(
            await client.writeSection(section, sectionFacts, document.cover),
        );
    }
    const chunks = splitNarration(narration.join("\n\n"));
    process.stdout.write(
        `Synthesizing ${chunks.length} single-voice audio segments...\n`,
    );
    await renderMp3(
        chunks,
        async (text, index, total) => {
            process.stdout.write(`Voice ${index + 1}/${total}...\n`);
            return client.synthesize(text);
        },
        output,
    );
    process.stdout.write(`Saved ${resolve(output)}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
