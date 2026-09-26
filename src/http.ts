import { z } from "zod";
import type { ChatUsage } from "./usage.ts";

const chatResponseSchema = z.object({
    choices: z.array(z.object({
        message: z.object({
            content: z.string().nullable(),
            refusal: z.string().nullable().optional(),
        }),
        finish_reason: z.string().nullable().optional(),
    })).min(1),
});

const usageSchema = z.object({
    usage: z.object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).nullable().optional(),
        completion_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).nullable().optional(),
    }),
});

export class ProviderError extends Error {
    readonly status: number | undefined;

    constructor(message: string, status?: number) {
        super(message);
        this.name = "ProviderError";
        this.status = status;
    }
}

async function pause(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function postJson(provider: string, url: URL, headers: Record<string, string>, body: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        let response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: {
                    ...headers,
                    "content-type": "application/json",
                    accept: "application/json",
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(300_000),
            });
        } catch (error) {
            if (attempt === 3) throw new ProviderError(`${provider} request failed: ${error instanceof Error ? error.message : String(error)}`);
            await pause(1_000 * 2 ** attempt);
            continue;
        }
        if (response.ok) {
            try {
                return await response.json();
            } catch {
                throw new ProviderError(`${provider} returned malformed JSON.`, response.status);
            }
        }
        const detail = (await response.text()).slice(0, 500);
        if (
            attempt === 3 ||
            ![429, 500, 502, 503, 504].includes(response.status)
        ) {
            throw new ProviderError(`${provider} HTTP ${response.status}: ${detail}`, response.status);
        }
        await pause(1_000 * 2 ** attempt);
    }
    throw new ProviderError(`${provider} request failed after retries.`);
}

export function chatUsage(result: unknown): ChatUsage | undefined {
    const parsed = usageSchema.safeParse(result);
    if (!parsed.success) return undefined;
    const usage = parsed.data.usage;
    return {
        input: usage.prompt_tokens,
        cachedInput: usage.prompt_tokens_details?.cached_tokens ?? 0,
        output: usage.completion_tokens,
        reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    };
}

export function chatJson(provider: string, result: unknown): unknown {
    const parsed = chatResponseSchema.safeParse(result);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) =>
            `${issue.path.join(".")}: ${issue.message}`,
        ).join("; ");
        throw new ProviderError(`${provider} chat returned an invalid response: ${issues}`);
    }
    const choice = parsed.data.choices[0];
    if (!choice) throw new ProviderError(`${provider} chat returned no choice.`);
    if (choice.message.refusal) {
        throw new ProviderError(`${provider} refused the request: ${choice.message.refusal}`);
    }
    const content = choice.message.content;
    if (content === null) {
        throw new ProviderError(`${provider} chat returned no text (finish reason: ${choice.finish_reason ?? "unknown"}).`);
    }
    if (choice.finish_reason === "length") {
        throw new ProviderError(`${provider} chat response exceeded the token limit.`);
    }
    try {
        const parsedContent: unknown = JSON.parse(content);
        return parsedContent;
    } catch {
        throw new ProviderError(`${provider} chat returned malformed JSON (finish reason: ${choice.finish_reason ?? "unknown"}).`);
    }
}
