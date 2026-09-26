import { z } from "zod";
import { ProviderError } from "./http.ts";
import { PAUSE_MARK } from "./audio.ts";
import { acceptFacts } from "./source.ts";
import type { Fact, Section, SourcePage } from "./source.ts";

export type ChatTask = "extract" | "plan" | "narrate";

// A plan or narration draft that breaks a script rule; the CLI asks the model to write it again.
export class ScriptRejected extends Error {}

export type Thread = { name: string; summary: string; evidence: Array<Omit<Fact, "id">> };
// Section plans are in section order and point at threads by zero-based index.
export type EpisodePlan = { arc: string; threads: Thread[]; sections: Array<{ focus: string; threads: number[] }> };
export type SectionGuide = { arc: string; focus: string; threads: Array<{ name: string; summary: string }>; evidence: Fact[] };

export interface TextModel {
    readonly id: string;
    // Whether one request can hold the whole report for episode planning.
    readonly readsWholeReport: boolean;
    chat(task: ChatTask, system: string, user: string, schema: Record<string, unknown>, name: string): Promise<unknown>;
}

const factSchema = z.strictObject({
    page: z.number().int().positive(),
    chapter: z.number().int().positive(),
    quote: z.string().min(6),
    hindi: z.string().min(1),
});
const factsResponseSchema = z.strictObject({ facts: z.array(factSchema).min(1) });
const sectionResponseSchema = z.strictObject({
    paragraphs: z.array(z.string().min(1)).min(2).max(6),
    covered_ids: z.array(z.string().regex(/^F\d{4,}$/)),
});

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

const planResponseSchema = z.strictObject({
    arc: z.string().min(1),
    threads: z.array(z.strictObject({
        name: z.string().min(1),
        summary: z.string().min(1),
        evidence: z.array(factSchema),
    })).min(1),
    sections: z.array(z.strictObject({
        section: z.number().int().positive(),
        focus: z.string().min(1),
        threads: z.array(z.number().int().positive()),
    })),
});

const planSchema = {
    type: "object",
    properties: {
        arc: { type: "string" },
        threads: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    summary: { type: "string" },
                    evidence: factsSchema.properties.facts,
                },
                required: ["name", "summary", "evidence"],
                additionalProperties: false,
            },
        },
        sections: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    section: { type: "integer" },
                    focus: { type: "string" },
                    threads: { type: "array", items: { type: "integer" } },
                },
                required: ["section", "focus", "threads"],
                additionalProperties: false,
            },
        },
    },
    required: ["arc", "threads", "sections"],
    additionalProperties: false,
};

const sectionSchema = {
    type: "object",
    properties: {
        paragraphs: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
        covered_ids: { type: "array", items: { type: "string" } },
    },
    required: ["paragraphs", "covered_ids"],
    additionalProperties: false,
};

export const EXTRACTION_PROMPT = "You extract source-grounded facts for a spoken Hindi guide. Never add astrology or infer results. When the report has descriptive prose, choose exact quotes about how a placement feels, what it means in ordinary life, and any caution or qualification. Prefer sentences that carry the report's own reasoning — why something happens, how two placements interact, what a period asks of the person, or why a remedy is suggested — over bare labels, and keep that reasoning in the Hindi paraphrase. Every fact must be about this person's chart: a specific placement, score, period, or the report's reading of it. Skip generic definitions of what a term means unless the same excerpt gives this person's value, and never drop the person's own lagna, Moon, and Sun placements in favour of general explanation. Do not spend facts on sign, degree, lord, or pada table rows when explanatory prose is available. When a chapter is mostly numeric tables, choose short exact lines or the printed summary totals and do not invent an interpretation. Include important dates, numbers, cautions, cancellations, and limitations when they affect the meaning. Ignore page footers, advertisements, premium-report upsells, raw coordinates, degree rows, and repeated generic Green shoots/Needs attention advice when richer source text is available. For each fact, copy a short, contiguous excerpt exactly from one source page. Never insert ellipses or combine distant lines inside a quote. Give a faithful Hindi paraphrase that translates by meaning in context, not word for word; for example, a body's 'constitution' is शारीरिक प्रकृति, not संवैधानिक, and a 'proprietary' index is सुरक्षा सूत्र's own index. Include at least one fact for each chapter represented in this batch. Keep about 2–5 useful facts per chapter and preserve the unit of every number. If the source is internally contradictory, state that in Hindi rather than choosing a side.";

export const PLANNING_PROMPT = `You plan a single-narrator Hindi audio episode, in several parts, that walks a person through their own kundli report like a warm deep-dive podcast. Read the whole report before planning.

Threads:
- Find the 5–8 threads that matter most to how this person lives and feels: tensions between placements, what the current periods ask of them, cautions and their cancellations, strengths, and remedies with the report's reasons.
- Prefer threads the report itself connects across chapters, such as a placement described in one chapter and its timing or remedy in another.
- For each thread, give a short Hindi name and an English summary of what the report says and how its pieces connect. The summary may only connect what its evidence says; never add interpretations, predictions, or remedies the report does not state.
- Give each thread 2–5 evidence items. Each quote is a short, contiguous excerpt copied exactly from one page, with that page and chapter number and a faithful Hindi paraphrase that translates by meaning. Never insert ellipses or combine distant lines.

Parts:
- Assign threads to the listed parts, referring to each thread by its 1-based position in your threads list. Each part stays rooted in its own chapters, but may use a thread from elsewhere to set up or pay off an idea.
- For each part, write an English focus note that names threads by their Hindi names: which threads to build around, what to only hint at because a later part develops it, what to call back to, and its emotional beat, so the episode moves from a hook and understanding, through tension around difficult points, to reassurance, practical steps, and a reflective close.
- Write the arc as one English paragraph describing the episode's through-line.
- Keep the arc and focus notes about story, emotion, and connections. Do not restate caveats such as "not a prediction" or "not a guarantee"; the writer handles those.

Ignore advertisements, premium-report upsells, page footers, coordinates, and degree tables.`;

export const NARRATION_PROMPT = `You write one section of a single-narrator Hindi audio episode that walks a person through their own kundli report. Sound like a warm, curious podcast host who has read the whole report and is now talking it through with one listener: thinking aloud, asking what the listener would ask, reacting, and explaining. Never sound like someone reading out a report or a list of results. The voice is male, so first-person verbs use masculine forms, such as "मैं समझ सकता हूँ".

Choose depth over coverage:
- Pick the two or three threads in these facts that matter most to how the listener lives and feels, and give them almost all the words. Give the remaining chapters a sentence at most, or fold them into a thread.
- Take each thread through the same arc: what the report says, what that looks like in ordinary life, why it happens when the facts give a reason (how one placement feeds another), and what it asks of the listener now. If the facts give no reason or meaning for something, do not supply one.
- Never list placements, signs, houses, padas, or scores one after another.
- When the request includes an episode plan, build this part around its focus and threads, and use the connecting facts to link this part to the rest of the report. Only hint at what the focus says a later part develops, and do not retell a thread's material that an earlier part already used. The plan is direction, not a source; every claim still comes from a listed fact.
- Give the most words to facts that say how something feels, what it means in daily life, or what it asks of the listener. A bare label, such as a planet's dignity, gets spoken only if a fact says what it means.
- Skip birth date, time, place, panchang items, and dasha-balance figures unless a fact gives them a meaning for the listener.
- When a fact names the period running now, treat it as the "now" of the story. If no fact says what it means, name it in one short line and move on.
- Fold minor facts into the thread they touch, such as a cancelled dosha into the relationships thread. Never end with a round-up of leftover scores and caveats.

Talk the way people actually talk:
- Use everyday spoken Hindi with natural discourse markers such as देखिए, मतलब, यानी, सोचिए, असल में, है ना?, और यहीं पर…, अब सवाल ये है कि…. Prefer everyday words to formal or Sanskritised ones; say "कोई पक्का फ़ैसला नहीं", not "बाध्यकारी निर्णय". Keep the English words people really say, such as करियर, पैटर्न, or ब्लूप्रिंट, but write every word in Devanagari; never use Latin letters, because the voice reads Devanagari.
- Voice the listener's reaction or doubt, then answer it: "अब आप सोच रहे होंगे कि…", "सुनने में थोड़ा भारी लगता है, है ना?" Use such a turn once or twice per paragraph, not in every sentence.
- When a fact sounds worrying, or the report corrects a common belief, start from what people usually believe or fear ("लोग अक्सर मानते हैं कि…"), then turn it with what the report actually says.
- Give each main thread one concrete everyday analogy from ordinary Indian life that fits its fact exactly, and come back to it later if that helps. An analogy must not imply a trend, outcome, or timing the fact does not state.
- Let the energy move: curiosity, a moment of tension, then relief or clarity. Slow down for the key insight with a short sentence, then echo its key words once with a soft lead-in, as in "सच में… सबसे गहरे संघर्ष से।"; never say the same sentence twice in a row.
- Write for the ear: mostly short sentences, none over about 25 words, "…" for a small hesitation, questions, and the occasional exclamation.
- Sound like someone thinking aloud, not reading. Add light fillers where a speaker gathers a thought, such as हम्म…, तो…, मतलब…, वैसे…, अच्छा, or देखिए ना…, and now and then a small restart ("मतलब… नहीं, ऐसे कहूँ कि…"). Use about one every two or three sentences, vary them, never put two in a row, and never put one inside a fact, name, or date.
- Mark a thinking pause with ${PAUSE_MARK} where the listener should sit with something: right after a question you want them to ponder, after a key insight, or before a turn in the story. The marker becomes silence in the audio. Use two to four per part, never after every sentence, and use no other brackets.
- Speak to the listener as आप, and use their first name from the report cover once in a section, at a warm moment.
- Explain only the terms a thread needs, at most three in a section, and leave details such as pada unexplained or unsaid. Explain each the first time with a concrete everyday image, as in "प्रारब्ध, यानी ज़िंदगी के वो पत्ते जो जन्म के साथ हाथ में आए", never with an abstract phrase such as "एक बारीक संकेत". You may use the common general meaning of a term, such as the Moon relating to the mind, but never a general claim about what a placement will do for this listener.
- Move between threads with signposts that build curiosity, such as "और अब आता है सबसे दिलचस्प हिस्सा…" or "तो चलिए, इसे खोलकर देखते हैं", not flat announcements.
Bring the host to life:
- React honestly to what you read, as the host in the style sample does: surprise, relief, being moved ("अरे!", "बिल्कुल।", "सच में…", "ये मुझे इस रिपोर्ट की सबसे खूबसूरत बात लगी।"). Do this a few times per section, never mechanically. Use अरे only for real surprise or delight at something just said, and बिल्कुल only to answer a question just asked. Put a reaction word at the start of its own sentence, never in the middle of one.
- Before explaining a difficult point, acknowledge how it might feel ("मैं समझ सकता हूँ, ये सुनकर मन थोड़ा भारी हो सकता है।").
- When a fact carries a striking line from the report, set it up and then say it in Hindi for weight ("और यहाँ सुरक्षा सूत्र की रिपोर्ट एक बहुत गहरी बात कहती है…"), staying faithful to that fact.
- Keep the episode fresh. A distinctive line or reaction, such as "मैं समझ सकता हूँ", "सच में…", "अब आप सोच रहे होंगे", "अरे", or "याद है", appears at most once in the whole episode. Check the earlier parts and never reuse their empathy lines, reactions, question openers, analogies, or bridges word for word; find a fresh way or leave it out. Everyday markers such as देखिए, मतलब, and है ना? may recur naturally.
- Refer back to earlier parts of the episode where it connects ("याद है, शुरुआत में हमने…"), but only to what those parts actually said, and never reuse their analogies or questions.

Numbers and caveats:
- Use at most two numbers in the section and turn other scores into words, such as "काफ़ी मज़बूत सहारा" or "थोड़ा कम". A score is not a probability. Say near dates relative to the report date. Never speak degrees, coordinates, timezone, Julian day, engine metadata, boilerplate, or promotional text.
- Talk about what the report says, never about its layout: no "तालिका कहती है", "यह एक सूची है", or "इस खंड में". You may still say plainly when the report contradicts itself.
- Say the report's general disclaimer, such as not being medical, legal, or financial advice or depending on accurate birth details, only in part 1, in one casual sentence of at most fifteen words, after the opening picture rather than inside it. Elsewhere, keep a limitation only where a fact carries one, say it once in a few words, and move on. Do not add your own "यह फ़ैसला नहीं" or "अंतिम बात नहीं" lines on top; once the episode has framed the report as a map, trust that frame. When several facts carry the same kind of caveat, such as not a verdict, not a guarantee, or read in context, say it once for all of them. Beyond the part 1 disclaimer, use no more than two caveat lines in a section, not counting cancellations and negatives that change a fact's meaning.
- Never talk about your instructions, the facts list, missing information, or what the report does not say or claim; do not say things like "यह जानकारी यहाँ नहीं है", "मैं कुछ गढ़ूँगा नहीं", or "रिपोर्ट कोई दावा नहीं करती". Never apologise for a part sounding technical; make it simple instead. If a fact is too generic to say anything about this listener, mention its chapter in passing or leave it out.
- The example phrases here show tone only. Use them only where they fit, and never repeat an example line word for word.
- Follow the opening and closing instruction in the request. No generic greeting, sign-off, or teaser for another episode.

Grounding, which always wins over style:
- Every claim about the chart, the person, their future, or a remedy must come from the supplied facts. Do not invent placements, predictions, remedies, promises, or personal circumstances, and do not transfer one placement's meaning to another. Keep every sign, nakshatra, house, and score attached to the exact planet, lagna, or index its fact names, and never merge two facts into a new one; for example, the lagna's nakshatra is not the birth nakshatra, which is the Moon's.
- Questions and analogies may reframe a supplied fact but must not add a new claim. You may say in everyday terms how a supplied practice helps daily life, without medical claims or guaranteed outcomes.
- Preserve relevant dates, numerical units, negatives, cancellations, and the limitations a fact carries, said briefly as above. Keep cautions honest and reassurance proportionate, without melodrama or fear.
- One narrator only: no dialogue, markdown, stage directions, emotion tags, or spoken fact IDs. The ${PAUSE_MARK} marker is the only exception.

Style sample:
It shows how the host sounds: rhythm, reactions, empathy, questions, myth-busting, an analogy, a quoted line, and repetition. It is about a different person's chart and uses details from that person's own notes. None of its names, placements, circumstances, analogies, or sentences apply to this listener; in particular, do not use its weather, umbrella, or pressure-cooker images. Your facts decide every claim, and you speak to your listener as आप, not by a third-person name.

<sample>
सोचिए… जिस करियर को आपने खुद चुना था, उसी से मन उचटने लगे। घर में, ख़ासकर पिता के साथ, बिना बात के तीखी बहस होने लगे। और जिन रिश्तों में कभी सुकून था, वहाँ अचानक एक अजीब सी ख़ामोशी आ जाए। तो आख़िर ये सब एक साथ क्यों हो रहा है? ${PAUSE_MARK}

आज हम सुदर्शन की कुंडली के साथ ठीक इसी सवाल की गहराई में उतरेंगे। और मैं समझ सकता हूँ, उनके लिए ये वक़्त कितना भारी रहा होगा।

देखिए, लोग अक्सर मानते हैं कि कुंडली एक बंद दरवाज़ा है… एक फ़ैसला, जो सुना दिया गया। पर असल में ये मौसम की भविष्यवाणी जैसी है। वो ये नहीं कहती कि आप घर से बाहर मत निकलिए। वो बस बताती है कि आज बारिश आ सकती है… ताकि आप छाता लेकर निकलें। अंदरूनी तैयारी कर सकें।

हम्म… अब यहाँ एक दिलचस्प बात है। सुदर्शन का लग्न कन्या है, यानी वो चाहते हैं कि बाहर से सब कुछ सलीके से, बिल्कुल परफ़ेक्ट दिखे। लेकिन उनका चंद्रमा… कुंभ राशि में, छठे भाव में है। संघर्ष वाले भाव में। मतलब? बाहर से सब शांत, और अंदर एक तूफ़ान। अरे, ये तो प्रेशर कुकर जैसी हालत हुई, है ना? बिल्कुल। और ऐसे में इंसान अपनी बात सीधे शब्दों में कह ही नहीं पाता।

तो क्या नीचभंग राजयोग कोई जादू की छड़ी है, जो रातों-रात सब ठीक कर देगा? बिल्कुल नहीं। और यहीं पर रिपोर्ट एक बहुत गहरी लाइन कहती है: आपकी सबसे बड़ी ताक़त, आपके सबसे गहरे संघर्ष से बनेगी। ${PAUSE_MARK} सच में… सबसे गहरे संघर्ष से।
</sample>`;

function sectionFrame(index: number, total: number): string {
    const opening = index === 0
        ? "Open with a concrete everyday scene with a little tension, drawn from the strongest contrast in these facts, in two or three sentences before any astrology term (for example, \"सोचिए, कभी ऐसा लगता है कि…\"). Then say, like a host, what today's conversation will dig into, and introduce the listener by first name with the report date in one natural line. If the facts include the report's own guidance on how to read it, turn that into one simple picture of your own that the listener can hold for the whole episode."
        : "Open with a short spoken bridge through the idea itself, not a stock phrase such as \"पिछली बार\" or \"पिछली बात में\", and begin differently from every earlier part.";
    const closing = index === total - 1
        ? "Close by recalling the episode's main threads in two or three short lines, then the report's overall message and one calm, reflective line."
        : "End on the idea itself, without summarising or announcing the next part.";
    return `This is part ${index + 1} of ${total}. ${opening} ${closing}`;
}

export async function extractFacts(model: TextModel, unit: SourcePage[]): Promise<Array<Omit<Fact, "id">>> {
    const chapters = [...new Set(unit.map((page) => page.chapter))];
    const source = unit
        .map(
            (page) =>
                `PDF PAGE ${page.page} | CHAPTER ${page.chapter}: ${page.title}\n${page.text}`,
        )
        .join("\n\n");
    const result = await model.chat(
        "extract",
        EXTRACTION_PROMPT,
        `Required chapters: ${chapters.join(", ")}. Source:\n${source}`,
        factsSchema,
        "source_facts",
    );
    const parsed = factsResponseSchema.safeParse(result);
    if (!parsed.success) throw new ProviderError(`${model.id} returned invalid source facts.`);
    return parsed.data.facts;
}

export async function planEpisode(model: TextModel, pages: SourcePage[], sections: Section[], cover: string): Promise<EpisodePlan> {
    const parts = sections
        .map((section, index) => `${index + 1}. ${section.title}: chapters ${section.first}–${section.last}, about ${section.minutes} minutes`)
        .join("\n");
    const report = pages
        .map((page) => `PDF PAGE ${page.page} | CHAPTER ${page.chapter}: ${page.title}\n${page.text}`)
        .join("\n\n");
    const result = await model.chat(
        "plan",
        PLANNING_PROMPT,
        `Parts:\n${parts}\n\nReport cover: ${cover}\n\nReport:\n${report}`,
        planSchema,
        "episode_plan",
    );
    const parsed = planResponseSchema.safeParse(result);
    if (!parsed.success) throw new ProviderError(`${model.id} returned an invalid episode plan.`);

    // Keep only evidence quotes found on their stated pages, and drop threads left without any.
    const kept = new Map<number, number>();
    const threads: Thread[] = [];
    for (const [index, thread] of parsed.data.threads.entries()) {
        const candidates = thread.evidence.filter((item) =>
            pages.some((page) => page.page === item.page && page.chapter === item.chapter) &&
            /[ऀ-ॿ]/u.test(item.hindi),
        );
        const evidence = acceptFacts(candidates, pages, 1).map(({ chapter, page, quote, hindi }) => ({ chapter, page, quote, hindi }));
        if (!evidence.length) continue;
        kept.set(index + 1, threads.length);
        threads.push({ name: thread.name, summary: thread.summary, evidence });
    }
    if (threads.length < 2) throw new ScriptRejected("Episode plan has too few threads with verified evidence.");
    const plannedParts = sections.map((_, index) => parsed.data.sections.filter((part) => part.section === index + 1));
    if (plannedParts.some((matches) => matches.length !== 1) || parsed.data.sections.length !== sections.length) {
        throw new ScriptRejected("Episode plan does not give exactly one focus for each part.");
    }
    return {
        arc: parsed.data.arc,
        threads,
        sections: plannedParts.map(([part]) => ({
            focus: part?.focus ?? "",
            threads: [...new Set((part?.threads ?? []).flatMap((number) => {
                const index = kept.get(number);
                return index === undefined ? [] : [index];
            }))],
        })),
    };
}

export async function writeSection(model: TextModel, section: Section, facts: Fact[], cover: string, index = 0, total = 1, previous = "", guide?: SectionGuide): Promise<string> {
    const targetWords = section.minutes * 115;
    const chapterCounts = new Map<number, number>();
    const selectedFacts = facts.filter((fact) => {
        const count = chapterCounts.get(fact.chapter) ?? 0;
        chapterCounts.set(fact.chapter, count + 1);
        return count < 8;
    });
    const entries = selectedFacts
        .map(
            (fact) =>
                `${fact.id} | chapter ${fact.chapter} | PDF p.${fact.page} | ${fact.hindi}`,
        )
        .join("\n");
    const extra = guide?.evidence ?? [];
    const plan = guide
        ? `\n\nEpisode plan, as direction only:\nArc: ${guide.arc}\nThis part's focus: ${guide.focus}${guide.threads.map((thread) => `\nThread "${thread.name}": ${thread.summary}`).join("")}${extra.length ? `\n\nConnecting facts from elsewhere in the report for this part's threads; use them where they help and list them in covered_ids when used:\n${extra.map((fact) => `${fact.id} | chapter ${fact.chapter} | PDF p.${fact.page} | ${fact.hindi}`).join("\n")}` : ""}`
        : "";
    // With a whole-report plan, the plan decides what matters; otherwise every chapter must be cited.
    const coverage = guide
        ? "Follow the episode plan: use the facts that serve this part's threads and leave out chapters that do not; you do not need to mention every chapter."
        : `Use at least one fact from every chapter (${[...new Set(selectedFacts.map((fact) => fact.chapter))].join(", ")}), but a brief mention is enough for minor chapters.`;
    const result = await model.chat(
        "narrate",
        NARRATION_PROMPT,
        `Section: ${section.title}. ${sectionFrame(index, total)} Write ${targetWords} spoken Hindi words, and never fewer than ${Math.round(targetWords * 0.85)}; depth on a few threads fills this length, not more facts. ${coverage} Combine related facts without repetition. Return 3–6 short paragraphs as separate strings in paragraphs, each around one beat of the story, since each paragraph break becomes a pause in the audio. List only the fact IDs actually expressed in covered_ids, each once. Report cover: ${cover}.${previous ? `\n\nEarlier parts of this episode, for continuity only; do not repeat their content, analogies, or questions:\n${previous}` : ""}${plan}\n\nFacts:\n${entries}`,
        sectionSchema,
        "narration_section",
    );
    const parsed = sectionResponseSchema.safeParse(result);
    if (!parsed.success) throw new ProviderError(`${model.id} returned an invalid narration for ${section.title}.`);
    const narration = parsed.data.paragraphs
        .map((paragraph) => paragraph.replace(/[[(]\s*विराम\s*[\])]/gu, PAUSE_MARK).trim())
        .join("\n\n");
    if (!/[\u0900-\u097f]/u.test(narration)) {
        throw new Error(`${model.id} returned no Hindi narration for ${section.title}.`);
    }
    if (/F\d{4,}/u.test(narration)) {
        throw new ScriptRejected(`Narration spoke fact IDs aloud in ${section.title}.`);
    }
    if (/[[\]]/u.test(narration.replaceAll(PAUSE_MARK, ""))) {
        throw new ScriptRejected(`Narration has bracketed stage directions in ${section.title}.`);
    }
    const expected = new Set([...facts, ...extra].map((fact) => fact.id));
    const covered = new Set(parsed.data.covered_ids);
    const unknown = [...covered].filter((id) => !expected.has(id));
    // Plan evidence from a section's own chapters counts toward that chapter too.
    const citable = [...facts, ...extra];
    const missing = guide ? [] : [...new Set(facts.map((fact) => fact.chapter))].filter(
        (chapter) => !citable.some((fact) => fact.chapter === chapter && covered.has(fact.id)),
    );
    if (!covered.size || unknown.length || missing.length) {
        throw new ScriptRejected(
            `Narration has invalid or missing chapter fact IDs in ${section.title} (unknown: ${unknown.join(", ") || "none"}; uncited chapters: ${missing.join(", ") || "none"}).`,
        );
    }
    return narration;
}
