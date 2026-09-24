const MAX_SOURCE_CHARACTERS = 10_000;

export type Chapter = { number: number; title: string; startPage: number; endPage: number };
export type Page = { number: number; text: string; chapter: number | null };
export type SourcePage = { page: number; chapter: number; title: string; text: string };
export type Fact = { id: string; chapter: number; page: number; quote: string; hindi: string };
export type Section = { title: string; first: number; last: number; minutes: number };

export function spokenChapters(chapters: Chapter[]): Chapter[] {
    return chapters.filter(
        (chapter) =>
            !/^(premium reports?|catalog(?:ue)?)$/i.test(chapter.title),
    );
}

export function sourceUnits(pages: Page[], chapters: Chapter[]): SourcePage[][] {
    const allowed = new Map(
        spokenChapters(chapters).map((chapter) => [chapter.number, chapter]),
    );
    const units: SourcePage[][] = [];
    let current: SourcePage[] = [];
    let size = 0;
    for (const page of pages) {
        if (page.chapter === null) continue;
        const chapter = allowed.get(page.chapter);
        if (!chapter || !page.text) continue;
        const item = {
            page: page.number,
            chapter: chapter.number,
            title: chapter.title,
            text: page.text,
        };
        const length = page.text.length + 80;
        if (length > MAX_SOURCE_CHARACTERS) {
            throw new Error(
                `PDF page ${page.number} is too long for the current extractor.`,
            );
        }
        if (size + length > MAX_SOURCE_CHARACTERS && current.length) {
            units.push(current);
            current = [];
            size = 0;
        }
        current.push(item);
        size += length;
    }
    if (current.length) units.push(current);
    return units;
}

export function normaliseQuote(value: string): string {
    return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function acceptFacts(rawFacts: Array<Omit<Fact, "id">>, unit: SourcePage[], nextId: number): Fact[] {
    if (!Array.isArray(rawFacts))
        throw new Error("Sarvam did not return a facts array.");
    const facts: Fact[] = [];
    for (const raw of rawFacts) {
        const source = unit.find(
            (page) => page.page === raw.page && page.chapter === raw.chapter,
        );
        if (
            !source ||
            typeof raw.quote !== "string" ||
            typeof raw.hindi !== "string"
        ) {
            throw new Error(
                "Sarvam returned a fact with an invalid page, chapter, or text.",
            );
        }
        const quote = normaliseQuote(raw.quote);
        if (quote.length < 6 || !normaliseQuote(source.text).includes(quote)) {
            throw new Error(
                `Sarvam returned an unverified quote for PDF page ${raw.page}.`,
            );
        }
        if (!/[\u0900-\u097f]/u.test(raw.hindi)) {
            throw new Error(
                `Sarvam returned a non-Hindi fact for PDF page ${raw.page}.`,
            );
        }
        facts.push({
            id: `F${String(nextId + facts.length).padStart(4, "0")}`,
            chapter: raw.chapter,
            page: raw.page,
            quote: raw.quote.trim(),
            hindi: raw.hindi.trim(),
        });
    }
    return facts;
}

const kundliSections = [
    { title: "जन्म और मुख्य आधार", first: 1, last: 6, minutes: 4 },
    { title: "ग्रह और भाव", first: 7, last: 11, minutes: 4 },
    { title: "बल और अष्टकवर्ग", first: 12, last: 19, minutes: 4 },
    { title: "जैमिनी और पारंपरिक संकेत", first: 20, last: 23, minutes: 3 },
    { title: "दशाएँ और समय", first: 24, last: 31, minutes: 5 },
    { title: "योग और सावधानियाँ", first: 32, last: 36, minutes: 3 },
    {
        title: "जीवन के क्षेत्र और वर्ग कुंडलियाँ",
        first: 37,
        last: 42,
        minutes: 5,
    },
    { title: "वर्तमान संदर्भ और समापन", first: 43, last: 47, minutes: 2 },
];

export function planSections(chapters: Chapter[]): Section[] {
    const active = spokenChapters(chapters);
    if (active.length === 47 && active[0]?.title === "How to read this report") {
        return kundliSections;
    }
    const count = Math.min(8, active.length);
    if (!count) throw new Error("The PDF has no chapters to narrate.");
    return Array.from({ length: count }, (_, index) => {
        const firstIndex = Math.floor((index * active.length) / count);
        const endIndex = Math.floor(((index + 1) * active.length) / count) - 1;
        return {
            title: `भाग ${index + 1}`,
            first: active[firstIndex]?.number ?? 1,
            last: active[endIndex]?.number ?? 1,
            minutes: 30 / count,
        };
    });
}
