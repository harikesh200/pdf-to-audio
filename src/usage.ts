// Published list prices; update them here if a provider changes its rates.
// GPT-6 Luna: developers.openai.com/api/docs/models/gpt-6-luna (prompts under 272K tokens).
// Sarvam: docs.sarvam.ai/api-reference-docs/pricing.
const chatPrices: Record<string, { currency: string; input: number; cachedInput: number; output: number }> = {
    "gpt-6-luna": { currency: "$", input: 0.10, cachedInput: 0.01, output: 0.50 },
    "sarvam-105b": { currency: "₹", input: 29.28, cachedInput: 29.28, output: 73.2 },
};
const speechRupeesPerTenThousandCharacters = 30;

export type ChatUsage = { input: number; cachedInput: number; output: number; reasoning: number };

type ChatTotals = ChatUsage & { calls: number; unreported: number };

export class UsageLog {
    private readonly chats = new Map<string, ChatTotals>();
    private speechRequests = 0;
    private speechCharacters = 0;

    recordChat(model: string, usage: ChatUsage | undefined): void {
        const totals = this.chats.get(model) ?? { calls: 0, unreported: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0 };
        totals.calls += 1;
        if (usage) {
            totals.input += usage.input;
            totals.cachedInput += usage.cachedInput;
            totals.output += usage.output;
            totals.reasoning += usage.reasoning;
        } else {
            totals.unreported += 1;
        }
        this.chats.set(model, totals);
    }

    recordSpeech(characters: number): void {
        this.speechRequests += 1;
        this.speechCharacters += characters;
    }

    summary(): string {
        if (!this.chats.size && !this.speechRequests) return "";
        const totals = new Map<string, number>();
        const add = (currency: string, amount: number) => totals.set(currency, (totals.get(currency) ?? 0) + amount);
        const lines = ["Cost of API calls made in this run (reused saved work is free):"];
        for (const [model, usage] of this.chats) {
            const price = chatPrices[model];
            const tokens = `${usage.calls} calls, ${usage.input.toLocaleString("en-IN")} input tokens (${usage.cachedInput.toLocaleString("en-IN")} cached), ${usage.output.toLocaleString("en-IN")} output tokens (${usage.reasoning.toLocaleString("en-IN")} reasoning)`;
            const missing = usage.unreported ? `; ${usage.unreported} calls reported no usage and are not counted` : "";
            if (!price) {
                lines.push(`  ${model}: ${tokens}; no price on file${missing}`);
                continue;
            }
            const cost = ((usage.input - usage.cachedInput) * price.input + usage.cachedInput * price.cachedInput + usage.output * price.output) / 1_000_000;
            add(price.currency, cost);
            lines.push(`  ${model}: ${tokens} = ${price.currency}${cost.toFixed(4)}${missing}`);
        }
        if (this.speechRequests) {
            const cost = (this.speechCharacters * speechRupeesPerTenThousandCharacters) / 10_000;
            add("₹", cost);
            lines.push(`  Sarvam Bulbul v3: ${this.speechRequests} requests, ${this.speechCharacters.toLocaleString("en-IN")} characters = ₹${cost.toFixed(2)}`);
        }
        lines.push(`  Total: ${[...totals].map(([currency, amount]) => `${currency}${amount.toFixed(currency === "$" ? 4 : 2)}`).join(" + ")}`);
        return `${lines.join("\n")}\n`;
    }
}
