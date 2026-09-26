import { z } from "zod";
import { chatJson, chatUsage, postJson, ProviderError } from "./http.ts";
import type { ChatTask, TextModel } from "./script.ts";
import type { UsageLog } from "./usage.ts";

const API_ROOT = "https://api.sarvam.ai";
const speechResponseSchema = z.object({ audios: z.array(z.string().min(1)).min(1) });
// Every setting that changes the voiced audio; saved audio is keyed on these too.
export const VOICE = {
    language_code: "hi-IN",
    speaker: "shubh",
    model: "bulbul:v3",
    pace: 0.85,
    temperature: 0.75,
    speech_sample_rate: 24_000,
    output_audio_codec: "wav",
} as const;
const chatSettings = {
    extract: { temperature: 0.2, max_tokens: 8_000 },
    plan: { temperature: 0.2, max_tokens: 12_000 },
    narrate: { temperature: 0.5, max_tokens: 12_000 },
} satisfies Record<ChatTask, { temperature: number; max_tokens: number }>;

export class Sarvam implements TextModel {
    readonly id = "sarvam-105b";
    // Its context window is not confirmed to fit the whole report, so it writes without an episode plan.
    readonly readsWholeReport = false;
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly usage: UsageLog | undefined;

    constructor(apiKey: string, baseUrl = API_ROOT, usage?: UsageLog) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        this.usage = usage;
    }

    async request(path: string, body: unknown): Promise<unknown> {
        return postJson("Sarvam", new URL(path, this.baseUrl), { "api-subscription-key": this.apiKey }, body);
    }

    async chat(task: ChatTask, system: string, user: string, schema: Record<string, unknown>, name: string): Promise<unknown> {
        const result = await this.request("/v1/chat/completions", {
            model: this.id,
            ...chatSettings[task],
            reasoning_effort: null,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            response_format: {
                type: "json_schema",
                json_schema: { name, strict: true, schema },
            },
        });
        this.usage?.recordChat(this.id, chatUsage(result));
        return chatJson("Sarvam", result);
    }

    async synthesize(text: string): Promise<Buffer> {
        const result = await this.request("/text-to-speech", { text, ...VOICE });
        this.usage?.recordSpeech(text.length);
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
