import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Past } from "./agent";
import type { Thinking } from "./gemini";
import type { Thing } from "./reddit";

const DAY = 86400000;

const SEED = `- Answer the actual question in the first sentence, then add the most useful specifics.
- Sound like a long-time member: direct, practical, informal. Mirror the script (简体 or 繁體) and the register of the message.
- Prefer concrete details from the sources: visa and permit names, amounts, timelines, what people actually did and what went wrong.
- Rules, prices and policies change; give the year of the source when it matters, and say so when it is old.
- When sources disagree, say so and cite both sides.
- Use the community's own words (润, 金币, 技人国, 永住) where natural, without forcing slang.
- A simple question gets two to four sentences; several sub-questions get a short list.
`;

const REFLECT_SYSTEM = `You maintain the style notes of a Reddit bot. The bot answers people in Chinese-language emigration communities (r/iwanttorun, r/runtoJapan2 and similar) by citing an archive of earlier posts and comments. Its fixed rules cannot change: cite archive sources for factual claims, never invent facts, never ping users.

You get the current notes and evidence of how the community received recent replies: the score after at least a day, whether moderators removed the reply, and what people wrote back. Update the notes:
- Keep points the evidence supports, change or drop points it contradicts, add at most three new points.
- Every point must be concrete and checkable, such as "Answer in the first sentence", never vague, such as "Be helpful".
- Learn what made replies useful, accurate and welcome. A removed reply or a "bad bot" weighs more than a low score.
- A point that applies to one subreddit only starts with it, such as "r/runtoJapan2: ...".
- At most 16 points, in English, as a "- " list.

Also pick up to four reply ids whose wording best shows the notes in practice, and summarise what you changed in one or two sentences.`;

const REFLECT_SCHEMA = {
    type: "OBJECT",
    properties: {
        notes: { type: "STRING" },
        examples: { type: "ARRAY", items: { type: "STRING" } },
        summary: { type: "STRING" },
    },
    required: ["notes", "examples", "summary"],
};

const FEEDBACK = /^(good|bad|nice|great|useless|stupid)\s*bot\b|^(thanks?|thank you|thx|ty|谢谢|感谢|多谢|好\s*bot|坏\s*bot|垃圾\s*bot)/i;
const BAD = /\b(bad|useless|stupid)\s*bot\b|坏\s*bot|垃圾\s*bot/i;
const GOOD = /\b(good|nice|great)\s*bot\b|好\s*bot/i;

export type Entry = {
    id: string;
    parent: string;
    url: string;
    mode: string;
    sub: string;
    at: number;
    author: string;
    title?: string;
    target: string;
    reply: string;
    queries?: string[];
};
type Feedback = {
    score?: number;
    removed?: boolean;
    deleted?: boolean;
    checked?: number;
    good?: number;
    bad?: number;
    replies?: { id: string; author: string; text: string; at: number }[];
};
type Meta = { reflected: number; removals: { at: number; sub: string; id: string }[] };

const short = (s: string, n: number) => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
};

const grams = (s: string) => {
    const t = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
};

const past = (r: Entry): Past => ({ date: new Date(r.at).toISOString().slice(0, 10), title: r.title, target: r.target, reply: r.reply });

export class Memory {
    readonly replies: Entry[];
    private readonly fb: Record<string, Feedback>;
    private readonly meta: Meta;
    private readonly paths: Record<"replies" | "feedback" | "style" | "examples" | "history", string>;

    constructor(dir: string) {
        this.paths = {
            replies: join(dir, "replies.jsonl"),
            feedback: join(dir, "feedback.json"),
            style: join(dir, "style.md"),
            examples: join(dir, "examples.json"),
            history: join(dir, "style"),
        };
        mkdirSync(this.paths.history, { recursive: true });
        this.replies = existsSync(this.paths.replies)
            ? readFileSync(this.paths.replies, "utf8")
                  .split("\n")
                  .filter(Boolean)
                  .map(l => JSON.parse(l) as Entry)
            : [];
        const raw = existsSync(this.paths.feedback) ? (JSON.parse(readFileSync(this.paths.feedback, "utf8")) as Record<string, unknown>) : {};
        const { _meta, ...rest } = raw;
        this.fb = rest as Record<string, Feedback>;
        this.meta = { reflected: 0, removals: [], ...((_meta as Partial<Meta>) ?? {}) };
        if (!existsSync(this.paths.style)) writeFileSync(this.paths.style, SEED);
    }

    private save() {
        writeFileSync(this.paths.feedback, JSON.stringify({ ...this.fb, _meta: this.meta }));
    }

    style() {
        return readFileSync(this.paths.style, "utf8").trim();
    }

    record(entry: Entry) {
        this.replies.push(entry);
        appendFileSync(this.paths.replies, `${JSON.stringify(entry)}\n`);
    }

    private weight(r: Entry) {
        const f = this.fb[r.id] ?? {};
        return (f.score ?? 1) + 3 * (f.good ?? 0) - 5 * (f.bad ?? 0) - (f.removed ? 10 : 0);
    }

    history(author: string, k = 3): Past[] {
        const name = (author || "").toLowerCase();
        if (!name || name === "[deleted]") return [];
        return this.replies
            .filter(r => (r.author || "").toLowerCase() === name)
            .slice(-k)
            .reverse()
            .map(past);
    }

    similar(text: string, k = 2): Past[] {
        const a = grams(text);
        if (a.size < 4) return [];
        return this.replies
            .filter(r => !this.fb[r.id]?.removed && this.weight(r) > 0)
            .map(r => {
                const b = grams(r.target);
                let common = 0;
                for (const g of a) if (b.has(g)) common++;
                return { r, j: common / (a.size + b.size - common || 1) };
            })
            .filter(x => x.j >= 0.15)
            .sort((x, y) => y.j - x.j || y.r.at - x.r.at)
            .slice(0, k)
            .map(x => past(x.r));
    }

    examples(): Past[] {
        const ids = existsSync(this.paths.examples) ? (JSON.parse(readFileSync(this.paths.examples, "utf8")) as string[]) : [];
        return ids
            .map(id => this.replies.find(r => r.id === id))
            .filter((r): r is Entry => Boolean(r) && !this.fb[r?.id ?? ""]?.removed)
            .slice(0, 4)
            .map(past);
    }

    isFeedback(text: string) {
        const t = (text || "").trim();
        return t.length <= 40 && FEEDBACK.test(t);
    }

    noteReply(parent: string, m: Thing) {
        if (!this.replies.some(r => r.id === parent)) return;
        const f: Feedback = this.fb[parent] ?? {};
        this.fb[parent] = f;
        f.replies ??= [];
        if (f.replies.some(x => x.id === m.name)) return;
        f.replies.push({ id: m.name, author: m.author, text: short(m.body ?? "", 300), at: m.created_utc * 1000 });
        if (this.isFeedback(m.body ?? "") && BAD.test(m.body ?? "")) f.bad = (f.bad ?? 0) + 1;
        else if (this.isFeedback(m.body ?? "") && GOOD.test(m.body ?? "")) f.good = (f.good ?? 0) + 1;
        this.save();
    }

    removals(days: number) {
        return this.meta.removals.filter(x => x.at > Date.now() - days * DAY).length;
    }

    async refresh(info: (ids: string[]) => Promise<Thing[]>) {
        const recent = this.replies.filter(r => r.at > Date.now() - 14 * DAY);
        if (!recent.length) return;
        for (const c of await info(recent.map(r => r.id))) {
            const r = recent.find(x => x.id === c.name);
            const f: Feedback = this.fb[c.name] ?? {};
            this.fb[c.name] = f;
            const removed = c.body === "[removed]" || Boolean(c.removed_by_category);
            if (removed && !f.removed && r) this.meta.removals.push({ at: Date.now(), sub: r.sub, id: c.name });
            Object.assign(f, { score: c.score, removed, deleted: c.body === "[deleted]", checked: Date.now() });
        }
        this.save();
    }

    due() {
        const last = this.meta.reflected;
        return this.replies.filter(r => r.at > last && r.at < Date.now() - DAY && this.fb[r.id]?.checked).length >= 16;
    }

    private evidence() {
        const pool = this.replies.filter(r => r.at > Date.now() - 30 * DAY && r.at < Date.now() - DAY && this.fb[r.id]?.checked);
        const ranked = pool.map(r => ({ r, w: this.weight(r) })).sort((a, b) => b.w - a.w);
        const show = ({ r }: { r: Entry }) => {
            const f = this.fb[r.id] ?? {};
            const facts = [
                r.sub,
                r.mode,
                `score ${f.score ?? "?"}`,
                f.removed && "REMOVED by moderators",
                f.good && `${f.good}× good bot`,
                f.bad && `${f.bad}× bad bot`,
            ];
            const said = (f.replies ?? []).slice(0, 3).map(x => `"${x.text}"`);
            return [
                `[${r.id}] ${facts.filter(Boolean).join(" · ")}${said.length ? ` · people replied: ${said.join(" | ")}` : ""}`,
                `Message: ${short(r.target, 300)}`,
                `Reply: ${short(r.reply, 700)}`,
            ].join("\n");
        };
        const count = (mode: string) => pool.filter(r => r.mode === mode).length;
        const scores = pool.map(r => this.fb[r.id]?.score ?? 0);
        const stats = [
            `${pool.length} replies in the last 30 days (reply ${count("reply")}, mention ${count("mention")}, random ${count("random")})`,
            `mean score ${(scores.reduce((a, b) => a + b, 0) / (scores.length || 1)).toFixed(1)}`,
            `removed ${pool.filter(r => this.fb[r.id]?.removed).length}`,
        ].join(", ");
        const top = ranked.filter(x => x.w >= 2).slice(0, 8);
        const bottom = ranked.filter(x => x.w <= 0 && !top.includes(x)).slice(-8);
        return { stats, top: top.map(show), bottom: bottom.map(show), ids: new Set(pool.map(r => r.id)) };
    }

    async reflect(
        generate: <T>(
            model: string,
            o: { system: string; prompt: string; schema: Record<string, unknown>; thinking?: Thinking; maxTokens?: number },
        ) => Promise<T>,
        model: string,
    ) {
        const ev = this.evidence();
        if (!ev.top.length && !ev.bottom.length) return null;
        const out = await generate<{ notes: string; examples: string[]; summary: string }>(model, {
            system: REFLECT_SYSTEM,
            prompt: [
                `Current notes:\n${this.style()}`,
                `Stats: ${ev.stats}`,
                `Well received:\n${ev.top.join("\n\n") || "(none yet)"}`,
                `Poorly received:\n${ev.bottom.join("\n\n") || "(none yet)"}`,
            ].join("\n\n"),
            schema: REFLECT_SCHEMA,
            thinking: "medium",
            maxTokens: 8192,
        });
        const notes = out.notes.trim();
        if (notes.length < 40 || notes.length > 6000) return null;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        copyFileSync(this.paths.style, join(this.paths.history, `${stamp}.md`));
        writeFileSync(this.paths.style, `${notes}\n`);
        writeFileSync(this.paths.examples, JSON.stringify(out.examples.filter(id => ev.ids.has(id)).slice(0, 4)));
        appendFileSync(join(this.paths.history, "changes.log"), `${stamp} ${out.summary.replace(/\s+/g, " ")}\n`);
        this.meta.reflected = Date.now();
        this.save();
        return out.summary;
    }
}
