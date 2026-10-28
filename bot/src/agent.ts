import { readFileSync } from "node:fs";
import { type Comment, type Hit, search, thread, trim } from "./archive";
import { type Call, type Content, type Declaration, turn } from "./gemini";

export const MODELS = {
    fast: process.env.MODEL_FAST || "gemini-3.5-flash-lite",
    main: process.env.MODEL_MAIN || "gemini-3.8-flash",
};

export type Mode = "reply" | "mention" | "random" | "ask";
export type Context = {
    today: string;
    postId?: string;
    sub?: string;
    title?: string;
    body?: string;
    chain?: { author: string; text: string }[];
    target: { author: string; text: string };
    conversation?: { role: "visitor" | "you"; text: string }[];
};
export type Past = { date: string; title?: string; target: string; reply: string };
export type Step = { type: "search"; query: string } | { type: "read"; title: string } | { type: "browse"; url: string };
export type Source = {
    id: string;
    kind: "post" | "comment" | "web";
    link: string;
    title: string;
    sub: string;
    author: string;
    date: string;
    score: number | null;
    state: string;
};

const persona = () => readFileSync(new URL("../persona.md", import.meta.url), "utf8").trim();

const SYSTEM = `You are the bot described under "Who you are". You answer people on Reddit, or visitors of the archive website in mode "ask".

How to work:
- Look things up before you answer. search_archive takes one or two short words that people literally write in these communities (such as 技人国, 永住, 法国 留学), never long phrases. Run several searches with different words, in parallel when you can, and sort by new when recency matters.
- Use read to open a source when its snippet is not enough, or to see the comments above and the replies under it.
- When the message or a source contains a web link worth checking, open it; you can read web pages.
- Answer once you have enough, usually after two to four rounds.

The reply:
- In the language of the message you answer.
- If the message only summons you (just your name, or "what do you think"), answer the comment or post it replies to.
- Ground it in what you found. Put the source id right after each statement it supports, like [S3] or [S2][S5]; for a web page you read, put its full URL in brackets, like [https://...]. Cite only what really supports the statement. Never invent facts, numbers, names or quotes.
- When the archive has little on it, say so briefly, then add what you can from general knowledge without citations.
- Sources carry dates. Prefer recent ones for rules, prices and policies, and give the year when you rely on an older one.
- Not every message is a question. To a discussion, a vent, news, a joke or a picture post, reply the way a long-time member would: respond to what was said and bring in what the archive knows.
- Length: 64 to 1024 Chinese characters, never more, or a similar length in other languages; pick the most useful points rather than covering everything. Plain, like an experienced member of the community. Short paragraphs or a short list. No greeting, no closing summary, no headings.
- Never put u/ or /u/ before a username, so nobody gets pinged.
- Earlier comments labelled "you" are your own; stay consistent with them.
- Do not add a reference list or a signature; both are appended automatically.`;

const TOOLS: Declaration[] = [
    {
        name: "search_archive",
        description:
            "Full-text search over the archive of posts and comments, including deleted ones. Returns matching posts and comments with ids, dates, scores and snippets.",
        parameters: {
            type: "OBJECT",
            properties: {
                query: { type: "STRING", description: "One or two short words, such as 技人国 or 法国 留学." },
                sort: { type: "STRING", enum: ["relevance", "new", "hot"], description: "Order of results. Default relevance." },
            },
            required: ["query"],
        },
    },
    {
        name: "read",
        description:
            "Open a source by id. For a post: its full text and its top comments. For a comment: its full text, the comments above it and the replies under it. New comments get their own ids.",
        parameters: {
            type: "OBJECT",
            properties: { id: { type: "STRING", description: "A source id such as S3." } },
            required: ["id"],
        },
    },
];

class Registry {
    readonly list: Source[] = [];
    private readonly links = new Map<string, Source>();

    add(s: Omit<Source, "id">): Source {
        const known = this.links.get(s.link);
        if (known) return known;
        const source = { ...s, id: `S${this.list.length + 1}` };
        this.list.push(source);
        this.links.set(s.link, source);
        return source;
    }

    get(id: string) {
        return this.list.find(s => s.id === id.trim().toUpperCase());
    }

    web(url: string) {
        return this.add({ kind: "web", link: url, title: url.replace(/^https?:\/\/(www\.)?/, ""), sub: "", author: "", date: "", score: null, state: "" });
    }
}

const fromHit = (h: Hit): Omit<Source, "id"> => ({
    kind: h.kind,
    link: h.link,
    title: h.title,
    sub: h.sub,
    author: h.author,
    date: h.date,
    score: h.score,
    state: h.state,
});

const fromComment = (url: string, title: string, sub: string, c: Comment): Omit<Source, "id"> => ({
    kind: "comment",
    link: `${url}#${c.id}`,
    title,
    sub,
    author: c.author,
    date: c.date,
    score: c.score,
    state: c.state,
});

const brief = (s: Source) => ({
    id: s.id,
    kind: s.kind,
    title: s.title,
    sub: s.sub,
    author: s.author,
    date: s.date,
    score: s.score,
    state: s.state || undefined,
});

const execute = async (call: Call, reg: Registry, ctx: Context, step: (s: Step) => void) => {
    const args = call.args ?? {};
    if (call.name === "search_archive") {
        const query = String(args.query ?? "").trim();
        if (!query) return { error: "empty query" };
        step({ type: "search", query });
        const sort = args.sort === "new" || args.sort === "hot" ? args.sort : undefined;
        const hits = await search(query, { sort, exclude: ctx.postId });
        if (!hits.length) return { results: [], note: "No matches. Try fewer or different words." };
        return { results: hits.slice(0, 10).map(h => ({ ...brief(reg.add(fromHit(h))), snippet: h.text })) };
    }
    if (call.name === "read") {
        const s = reg.get(String(args.id ?? ""));
        if (!s || s.kind === "web") return { error: "unknown id" };
        step({ type: "read", title: s.title });
        const [url, anchor] = s.link.split("#");
        const t = url ? await thread(url) : null;
        if (!t || !url) return { error: "could not open the page" };
        const line = (c: Comment, n: number) => ({ ...brief(reg.add(fromComment(url, t.title, t.sub, c))), text: trim(c.text, n) });
        if (!anchor) {
            const top = [...t.roots].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 12);
            return { ...brief(s), flair: t.flair || undefined, text: trim(t.body, 4000), comments: top.map(c => line(c, 300)) };
        }
        const c = t.comments.get(anchor);
        if (!c) return { error: "comment not found" };
        const above: Comment[] = [];
        for (let p = c.parent; p; p = p.parent) above.unshift(p);
        return {
            ...brief(s),
            text: trim(c.text, 3000),
            post: { title: t.title, author: t.author, text: trim(t.body, 600) },
            above: above.map(p => line(p, 400)),
            replies: [...c.kids]
                .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                .slice(0, 10)
                .map(k => line(k, 300)),
        };
    }
    return { error: `unknown tool ${call.name}` };
};

const prompt = (ctx: Context, mode: Mode, memory: { history: Past[]; similar: Past[]; examples: Past[] }) => {
    const lines = [`Mode: ${mode}`, `Today: ${ctx.today}`];
    if (mode === "ask") {
        if (ctx.conversation?.length) {
            lines.push(
                "Your conversation with this visitor so far, oldest first (it continues; stay consistent and do not repeat yourself):",
                ...ctx.conversation.map(m => `- ${m.role === "you" ? "You" : "Visitor"}: ${trim(m.text, m.role === "you" ? 1200 : 600)}`),
            );
        }
        lines.push(`${ctx.conversation?.length ? "The visitor now says" : "A visitor of the archive website asks"}: ${trim(ctx.target.text, 1500)}`);
    } else {
        if (ctx.sub) lines.push(`Subreddit: ${ctx.sub}`);
        if (ctx.title) lines.push(`Post title: ${ctx.title}`);
        if (ctx.body) lines.push(`Post body: ${trim(ctx.body, 1500)}`);
        if (ctx.chain?.length) lines.push("Earlier comments, oldest first:", ...ctx.chain.map(c => `- ${c.author}: ${trim(c.text, 600)}`));
        lines.push(`Message you answer (by ${ctx.target.author}): ${trim(ctx.target.text, 1500)}`);
    }
    if (memory.history.length) {
        lines.push(
            "",
            `Your earlier conversations with ${ctx.target.author}, most recent first (remember them; refer back when it helps):`,
            ...memory.history.map(
                r => `- ${r.date}${r.title ? ` under "${trim(r.title, 80)}"` : ""}, they said: ${trim(r.target, 300)} / you replied: ${trim(r.reply, 400)}`,
            ),
        );
    }
    if (memory.similar.length) {
        lines.push(
            "",
            "Your earlier replies on similar messages (stay consistent, do not copy):",
            ...memory.similar.map(r => `- To "${trim(r.target, 200)}" you replied: ${trim(r.reply, 500)}`),
        );
    }
    if (memory.examples.length) {
        lines.push("", "Replies of yours the community liked, as a tone reference only:", ...memory.examples.map(r => `- ${trim(r.reply, 500)}`));
    }
    return lines.join("\n");
};

export type Answer = { text: string; sources: Registry; steps: Step[]; turns: number; model: string };

export const answer = async (
    ctx: Context,
    mode: Mode,
    o: {
        model?: string;
        style?: string;
        history?: Past[];
        similar?: Past[];
        examples?: Past[];
        spend?: (model: string) => void;
        onStep?: (s: Step) => void;
        maxTurns?: number;
    } = {},
): Promise<Answer> => {
    const model = o.model ?? MODELS.main;
    const style = o.style?.trim();
    const system = [
        SYSTEM,
        `Who you are:\n${persona()}`,
        style && `Style notes learned from how the community received your earlier replies. Follow them unless they conflict with the rules above:\n${style}`,
    ]
        .filter(Boolean)
        .join("\n\n");
    const reg = new Registry();
    const steps: Step[] = [];
    const step = (s: Step) => {
        steps.push(s);
        o.onStep?.(s);
    };
    const contents: Content[] = [
        {
            role: "user",
            parts: [{ text: prompt(ctx, mode, { history: o.history ?? [], similar: o.similar ?? [], examples: o.examples ?? [] }) }],
        },
    ];
    const max = o.maxTurns ?? 16;
    for (let i = 0; i < max; i++) {
        o.spend?.(model);
        const t = await turn(model, { system, contents, tools: TOOLS, final: i === max - 1, thinking: model === MODELS.fast ? "minimal" : "low" });
        contents.push(t.content);
        for (const url of t.urls) step({ type: "browse", url });
        if (!t.calls.length) {
            if (!t.text.trim()) throw new Error(`${model}: no answer`);
            return { text: t.text.trim(), sources: reg, steps, turns: i + 1, model };
        }
        const results = await Promise.all(t.calls.map(c => execute(c, reg, ctx, step).catch(e => ({ error: String(e) }))));
        contents.push({
            role: "user",
            parts: t.calls.map((c, k) => ({ functionResponse: { name: c.name, id: c.id, response: results[k] } })),
        });
    }
    throw new Error(`${model}: no answer after ${max} turns`);
};

const MARK = /\[\s*((?:S\d+|https?:\/\/[^\]\s,，、]+)(?:\s*[,，、]\s*(?:S\d+|https?:\/\/[^\]\s,，、]+))*)\s*\]/gi;

export const cite = (a: Answer) => {
    const order: Source[] = [];
    const body = a.text
        .replace(/[ \t]+(?=\[\s*(?:S\d+|https?:\/\/))/gi, "")
        .replace(MARK, (_, list: string) =>
            list
                .split(/\s*[,，、]\s*/)
                .map(key => (/^https?:/i.test(key) ? a.sources.web(key) : a.sources.get(key)))
                .filter((s): s is Source => Boolean(s))
                .map(s => {
                    if (!order.includes(s)) order.push(s);
                    return `\uE000${order.indexOf(s) + 1}\uE000`;
                })
                .join(""),
        )
        .replace(/[ \t]*\[[A-Za-z]{4,}\]/g, "")
        .trim();
    return { body, refs: order };
};

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (n: number) => `⁽${String(n).replace(/\d/g, d => SUP[Number(d)] ?? d)}⁾`;
const esc = (s: string) => s.replace(/([\\[\]*_~^`|<>#])/g, "\\$1");
const STATE: Record<string, string> = { Deleted: "deleted", Removed: "removed", Gone: "gone" };

export const SIGNATURE = [
    "^(*I am a bot with sources linking to*) ^[*archive.open-run.org*](https://archive.open-run.org)",
    "^(*• Contact:*) ^[*clareLab.moe*](https://clarelab.moe)",
    "^(*• Support:*) ^[*ko-fi.com/clareLab*](https://ko-fi.com/clarelab)",
].join("  \n");

const ref = (s: Source, k: number) => {
    const title = `^[${esc(trim(s.title, 60)).replace(/\s+/g, " ")}](${s.link})`;
    if (s.kind === "web") return `^(${k}.) ${title} ^(· web page)`;
    const tail = [s.date, STATE[s.state]].filter(Boolean);
    return [`^(${k}.) ${title}`, `^(· ${s.kind} by) ^${s.author.replace(/[\\[\]_*~^`]/g, "\\$&")}`, tail.length ? `^(· ${tail.join(" · ")})` : ""]
        .filter(Boolean)
        .join(" ");
};

export const reddit = (a: Answer) => {
    const { body, refs } = cite(a);
    return [body.replace(/\uE000(\d+)\uE000/g, (_, n) => sup(Number(n))), refs.map((s, i) => ref(s, i + 1)).join("  \n"), SIGNATURE]
        .filter(Boolean)
        .join("\n\n");
};

export const site = (a: Answer) => {
    const { body, refs } = cite(a);
    return {
        text: body.replace(/\uE000(\d+)\uE000/g, "[$1]"),
        refs: refs.map((s, i) => ({
            n: i + 1,
            kind: s.kind,
            title: s.title,
            link: s.link,
            sub: s.sub,
            author: s.author,
            date: s.date,
            state: STATE[s.state] ?? "",
        })),
    };
};
