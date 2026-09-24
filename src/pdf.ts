import { readFile } from "node:fs/promises";
import type { PathLike } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Chapter, Page } from "./source.ts";

function pageText(items: unknown[]): string {
    return items
        .map((item) => {
            if (typeof item !== "object" || item === null || !("str" in item)) return "";
            return `${typeof item.str === "string" ? item.str : ""}${"hasEOL" in item && item.hasEOL ? "\n" : ""}`;
        })
        .join("")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function contents(pages: Page[]): Array<Omit<Chapter, "endPage">> {
    const entries: Array<Omit<Chapter, "endPage">> = [];
    for (const page of pages.slice(0, Math.min(5, pages.length))) {
        if (!/^CONTENTS\b/m.test(page.text)) continue;
        for (const line of page.text.split("\n")) {
            const match = line.trim().match(/^(\d+)\.\s+(.+?)\s+(\d{1,4})$/);
            if (match?.[2]) {
                entries.push({
                    number: Number(match[1]),
                    title: match[2],
                    startPage: Number(match[3]),
                });
            }
        }
    }
    entries.sort((first, second) => first.number - second.number);
    const valid =
        entries.length > 1 &&
        entries.every((entry, index) => entry.number === index + 1) &&
        entries.every(
            (entry, index) =>
                index === 0 || entry.startPage > (entries[index - 1]?.startPage ?? 0),
        ) &&
        entries.every((entry) => entry.startPage <= pages.length);
    return valid ? entries : [];
}

export async function extractPdf(path: PathLike): Promise<{ pages: Page[]; chapters: Chapter[]; cover: string }> {
    const bytes = new Uint8Array(await readFile(path));
    const task = getDocument({ data: bytes, useSystemFonts: true });
    try {
        const document = await task.promise;
        const pages: Page[] = [];
        for (let number = 1; number <= document.numPages; number += 1) {
            const page = await document.getPage(number);
            const content = await page.getTextContent();
            pages.push({ number, text: pageText(content.items), chapter: null });
            page.cleanup();
        }
        if (
            pages.filter((page) => page.text.length > 40).length <
            pages.length / 2
        ) {
            throw new Error(
                "This PDF has too little extractable text; OCR is needed before narration.",
            );
        }

        const entries = contents(pages);
        const chapters = entries.length
            ? entries.map((entry, index) => ({
                  ...entry,
                  endPage: (entries[index + 1]?.startPage ?? pages.length + 1) - 1,
              }))
            : pages.filter((page) => page.text).map((page) => ({
                  number: page.number,
                  title: `Page ${page.number}`,
                  startPage: page.number,
                  endPage: page.number,
              }));

        for (const page of pages) {
            page.chapter =
                chapters.find(
                    (chapter) =>
                        page.number >= chapter.startPage &&
                        page.number <= chapter.endPage,
                )?.number ?? null;
        }
        return { pages, chapters, cover: pages[0]?.text ?? "" };
    } finally {
        await task.destroy();
    }
}
