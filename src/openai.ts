import { chatJson, chatUsage, postJson } from "./http.ts";
import type { ChatTask, TextModel } from "./script.ts";
import type { UsageLog } from "./usage.ts";

const API_ROOT = "https://api.openai.com";
// Luna rejects temperature when reasoning is on; reasoning tokens count toward the completion limit.
const chatSettings = {
    extract: { reasoning_effort: "low", max_completion_tokens: 16_000 },
    plan: { reasoning_effort: "high", max_completion_tokens: 32_000 },
    narrate: { reasoning_effort: "medium", max_completion_tokens: 32_000 },
} satisfies Record<ChatTask, { reasoning_effort: string; max_completion_tokens: number }>;

export class OpenAI implements TextModel {
    readonly id = "gpt-6-luna";
    readonly readsWholeReport = true;
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly usage: UsageLog | undefined;

    constructor(apiKey: string, baseUrl = API_ROOT, usage?: UsageLog) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        this.usage = usage;
    }

    async chat(task: ChatTask, system: string, user: string, schema: Record<string, unknown>, name: string): Promise<unknown> {
        const result = await postJson("OpenAI", new URL("/v1/chat/completions", this.baseUrl), { authorization: `Bearer ${this.apiKey}` }, {
            model: this.id,
            ...chatSettings[task],
            messages: [
                { role: "developer", content: system },
                { role: "user", content: user },
            ],
            response_format: {
                type: "json_schema",
                json_schema: { name, strict: true, schema },
            },
        });
        this.usage?.recordChat(this.id, chatUsage(result));
        return chatJson("OpenAI", result);
    }
}
