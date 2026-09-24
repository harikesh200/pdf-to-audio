import { z } from "zod";
import type { Fact, Section, SourcePage } from "./source.ts";

const API_ROOT = "https://api.sarvam.ai";
const factSchema = z.strictObject({
    page: z.number().int().positive(),
    chapter: z.number().int().positive(),
    quote: z.string().min(6),
    hindi: z.string().min(1),
});
const factsResponseSchema = z.strictObject({ facts: z.array(factSchema).min(1) });
const sectionResponseSchema = z.strictObject({
    text: z.string().min(1),
    covered_ids: z.array(z.string().regex(/^F\d{4,}$/)),
});
const chatResponseSchema = z.object({
    choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});
const speechResponseSchema = z.object({ audios: z.array(z.string().min(1)).min(1) });

export class ProviderError extends Error {
    readonly status: number | undefined;

    constructor(message: string, status?: number) {
        super(message);
        this.name = "ProviderError";
        this.status = status;
    }
}

const factsSchema = {
    type: "object",
    properties: {
        facts: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    page: { type: "integer" },
                    chapter: { type: "integer" },
                    quote: { type: "string" },
                    hindi: { type: "string" },
                },
                required: ["page", "chapter", "quote", "hindi"],
                additionalProperties: false,
            },
        },
    },
    required: ["facts"],
    additionalProperties: false,
};

const sectionSchema = {
    type: "object",
    properties: {
        text: { type: "string" },
        covered_ids: { type: "array", items: { type: "string" } },
    },
    required: ["text", "covered_ids"],
    additionalProperties: false,
};

async function pause(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class Sarvam {
    private readonly apiKey: string;
    private readonly baseUrl: string;

    constructor(apiKey: string, baseUrl = API_ROOT) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
    }

    async request(path: string, body: unknown): Promise<unknown> {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            let response;
            try {
                response = await fetch(new URL(path, this.baseUrl), {
                    method: "POST",
                    headers: {
                        "api-subscription-key": this.apiKey,
                        "content-type": "application/json",
                        accept: "application/json",
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(120_000),
                });
            } catch (error) {
                if (attempt === 3) throw new ProviderError(`Sarvam request failed: ${error instanceof Error ? error.message : String(error)}`);
                await pause(1_000 * 2 ** attempt);
                continue;
            }
            if (response.ok) {
                try {
                    return await response.json();
                } catch {
                    throw new ProviderError("Sarvam returned malformed JSON.", response.status);
                }
            }
            const detail = (await response.text()).slice(0, 500);
            if (
                attempt === 3 ||
                ![429, 500, 502, 503, 504].includes(response.status)
            ) {
                throw new ProviderError(`Sarvam HTTP ${response.status}: ${detail}`, response.status);
            }
            await pause(1_000 * 2 ** attempt);
        }
        throw new ProviderError("Sarvam request failed after retries.");
    }

    async chat(system: string, user: string, schema: Record<string, unknown>, name: string, maxTokens = 5_000): Promise<unknown> {
        const result = await this.request("/v1/chat/completions", {
            model: "sarvam-105b",
            temperature: 0.2,
            max_tokens: maxTokens,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            response_format: {
                type: "json_schema",
                json_schema: { name, strict: true, schema },
            },
        });
        const parsed = chatResponseSchema.safeParse(result);
        if (!parsed.success) throw new ProviderError("Sarvam chat returned an invalid response.");
        const choice = parsed.data.choices[0];
        if (!choice) throw new ProviderError("Sarvam chat returned no choice.");
        const content = choice.message.content;
        try {
            const parsedContent: unknown = JSON.parse(content);
            return parsedContent;
        } catch {
            throw new ProviderError("Sarvam chat returned malformed JSON.");
        }
    }

    async extractFacts(unit: SourcePage[]): Promise<Array<Omit<Fact, "id">>> {
        const chapters = [...new Set(unit.map((page) => page.chapter))];
        const source = unit
            .map(
                (page) =>
                    `PDF PAGE ${page.page} | CHAPTER ${page.chapter}: ${page.title}\n${page.text}`,
            )
            .join("\n\n");
        const result = await this.chat(
            "You extract source-grounded facts for a Hindi spoken summary. Never add astrology or infer results. Return only material chart facts, numbers, dates, cautions, cancellations, and report limitations. Ignore page footers, advertisements, prices, URLs, and repeated generic Green shoots/Needs attention boilerplate. For every fact, quote a contiguous excerpt exactly as printed on one source page, and give a faithful Hindi paraphrase. Include at least one fact for each chapter represented in this batch. Keep about 2–5 facts per chapter and preserve the unit of every number. If the source is internally contradictory, state that in Hindi rather than choosing a side.",
            `Required chapters: ${chapters.join(", ")}. Source:\n${source}`,
            factsSchema,
            "source_facts",
            5_000,
        );
        const parsed = factsResponseSchema.safeParse(result);
        if (!parsed.success) throw new ProviderError("Sarvam returned invalid source facts.");
        return parsed.data.facts;
    }

    async writeSection(section: Section, facts: Fact[], cover: string): Promise<string> {
        const targetWords = section.minutes * 115;
        const entries = facts
            .map(
                (fact) =>
                    `${fact.id} | chapter ${fact.chapter} | PDF p.${fact.page} | ${fact.hindi}`,
            )
            .join("\n");
        const result = await this.chat(
            "You are writing a single-voice Hindi narration from a verified fact list. Write natural, warm Devanagari Hindi, with short sentences and respectful pauses expressed through punctuation. No dialogue, markdown, invented predictions, new remedies, or claims absent from the facts. Preserve dates, numerical units, negatives, cancellations, and qualifications. Explain technical terms briefly. Do not read fact IDs aloud. A score is not a probability. Time-sensitive facts must be framed using the report date, not presented as current forever.",
            `Section: ${section.title}. Aim for ${targetWords} spoken Hindi words, within 20%. Cover EVERY listed fact at least briefly, combining related points without losing its meaning. List each fact ID in covered_ids exactly once. Report cover: ${cover}. Facts:\n${entries}`,
            sectionSchema,
            "narration_section",
            7_000,
        );
        const parsed = sectionResponseSchema.safeParse(result);
        if (!parsed.success) throw new ProviderError(`Sarvam returned an invalid narration for ${section.title}.`);
        if (!/[\u0900-\u097f]/u.test(parsed.data.text)) {
            throw new Error(
                `Sarvam returned no Hindi narration for ${section.title}.`,
            );
        }
        const expected = new Set(facts.map((fact) => fact.id));
        const covered = new Set(parsed.data.covered_ids);
        if (
            expected.size !== covered.size ||
            parsed.data.covered_ids.length !== covered.size ||
            [...expected].some((id) => !covered.has(id))
        ) {
            throw new Error(
                `Narration omitted source fact IDs in ${section.title}.`,
            );
        }
        return parsed.data.text.trim();
    }

    async synthesize(text: string): Promise<Buffer> {
        const result = await this.request("/text-to-speech", {
            text,
            language_code: "hi-IN",
            speaker: "shubh",
            model: "bulbul:v3",
            pace: 0.9,
            temperature: 0.6,
            speech_sample_rate: 24_000,
            output_audio_codec: "wav",
        });
        const parsed = speechResponseSchema.safeParse(result);
        if (!parsed.success) throw new ProviderError("Sarvam TTS returned no audio.");
        const encoded = parsed.data.audios[0];
        if (!encoded) throw new ProviderError("Sarvam TTS returned no audio.");
        const audio = Buffer.from(encoded, "base64");
        if (
            audio.toString("ascii", 0, 4) !== "RIFF" ||
            audio.toString("ascii", 8, 12) !== "WAVE"
        ) {
            throw new Error("Sarvam TTS returned invalid WAV audio.");
        }
        return audio;
    }
}
