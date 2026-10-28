import { readFileSync } from "node:fs";
import { generate } from "./gemini.js";
import { retrieve } from "./sources.js";

export const MODELS = {
    fast: process.env.MODEL_FAST || "gemini-3.5-flash-lite",
    main: process.env.MODEL_MAIN || "gemini-3.8-flash",
};

const SIGNATURE = [
    "^(*I am a bot with sources linking to*) ^[*archive.open-run.org*](https://archive.open-run.org)",
    "",
    "* ^(*Contact:*) ^[*clareLab.moe*](https://clarelab.moe)",
    "* ^(*Support:*) ^[*ko-fi.com/clareLab*](https://ko-fi.com/clarelab)",
].join("\n");

const QUERY_SYSTEM = `You write search queries for a full-text search engine over an archive of Reddit posts and comments from communities about emigrating from mainland China (r/iwanttorun, r/runtoJapan and similar). Most content is Simplified Chinese, with some English and Japanese. The engine only returns pages that contain every word of a query, so each query must be one or two short words that people literally write in such posts (for example 法国 留学, 技人国, 永住), never invented compounds.`;

const persona = () => readFileSync(new URL("../persona.md", import.meta.url), "utf8").trim();

const ANSWER_SYSTEM = `You reply on Reddit as the bot described below. When people ask about you, answer from this description.

Write the reply:
- In the language of the message you reply to.
- If the message only summons you (just your name, or "what do you think"), answer the question in the comment or post it replies to.
- Grounded in the numbered archive sources. Put [n] right after each statement a source supports; several sources look like [1][3]. Cite only sources that really support the statement. Never invent facts, numbers, names or quotes that are not in the sources.
- When the sources do not cover the question, say briefly that the archive has little on it, then add what you can from general knowledge without citations.
- Sources carry dates. Prefer recent ones for rules, prices and policies, and give the year when you rely on an older one.
- Concise and plain, like an experienced member of the community: 64 to 256 Chinese characters, or a similar length in other languages. Short paragraphs or a short list. No greeting, no closing summary, no headings.
- Never put u/ or /u/ before a username, so nobody gets pinged.
- Earlier comments labelled "you" are your own; stay consistent with them.
- Do not add a reference list or a signature; both are appended automatically.

Not every message is a question. To a discussion, a vent, news, a joke or a picture post, reply the way a long-time member would: respond to what was said and bring in what the archive knows, such as earlier discussions of the same thing, how it went for others, or relevant facts.`;

const QUERY_SCHEMA = {
    type: "OBJECT",
    properties: { queries: { type: "ARRAY", items: { type: "STRING" } } },
    required: ["queries"],
};

const ANSWER_SCHEMA = {
    type: "OBJECT",
    properties: { reply: { type: "STRING" } },
    required: ["reply"],
};

const STATE = { Deleted: "deleted", Removed: "removed", Gone: "gone" };

const trim = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const esc = s => s.replace(/([\\[\]*_~^`|<>#])/g, "\\$1");

const context = ctx => {
    const lines = ctx.today ? [`Today: ${ctx.today}`] : [];
    if (ctx.sub) lines.push(`Subreddit: ${ctx.sub}`);
    if (ctx.title) lines.push(`Post title: ${ctx.title}`);
    if (ctx.body) lines.push(`Post body: ${trim(ctx.body, 1500)}`);
    if (ctx.chain?.length) {
        lines.push("Earlier comments, oldest first:", ...ctx.chain.map(c => `- ${c.author}: ${trim(c.text, 600)}`));
    }
    lines.push(`Message you reply to (by ${ctx.target.author}): ${trim(ctx.target.text, 1500)}`);
    return lines.join("\n");
};

const label = s => {
    const where = s.kind === "comment" ? `comment by ${s.author} under "${s.title}"` : `post "${s.title}" by ${s.author}`;
    const facts = [s.sub, s.date, s.state && s.state.toLowerCase(), s.score !== null && `score ${s.score}`].filter(Boolean);
    return `${where} (${facts.join(", ")})`;
};

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";

const sup = n => `⁽${String(n).replace(/\d/g, d => SUP[d])}⁾`;

const cite = (s, k) => {
    const tail = [s.date, STATE[s.state]].filter(Boolean);
    return [
        `^(${k}.) ^[${esc(trim(s.title, 60)).replace(/\s+/g, "\u00a0")}](${s.link})`,
        `^(· ${s.kind} by) ^${s.author.replace(/[\\[\]_*~^`]/g, "\\$&")}`,
        tail.length ? `^(· ${tail.join(" · ")})` : "",
    ]
        .filter(Boolean)
        .join(" ");
};

const memory = (similar, examples, history, author) => {
    const out = [];
    if (history.length) {
        out.push(
            `Your earlier conversations with ${author}, most recent first (remember them; refer back when it helps):`,
            ...history.map(r => `- ${r.date}${r.title ? ` under "${trim(r.title, 80)}"` : ""}, they said: ${trim(r.target, 300)} / you replied: ${trim(r.reply, 400)}`),
        );
    }
    if (similar.length) {
        out.push(
            "Your earlier replies on similar questions (stay consistent, do not copy):",
            ...similar.map(r => `- To "${trim(r.target, 200)}" you replied: ${trim(r.reply, 500)}`),
        );
    }
    if (examples.length) {
        out.push("Replies of yours the community liked, as a tone reference only:", ...examples.map(r => `- ${trim(r.reply, 500)}`));
    }
    return out.length ? `\n\n${out.join("\n")}` : "";
};

const MARK = /\[(\d+(?:\s*[,，、]\s*\d+)*)\]/g;

export const render = (reply, sources) => {
    const order = [];
    const body = reply
        .replace(/[ \t]*\[[A-Za-z]{4,}\]/g, "")
        .replace(/[ \t]+(?=\[\d+(?:\s*[,，、]\s*\d+)*\])/g, "")
        .replace(MARK, (_, list) =>
        list
            .split(/\s*[,，、]\s*/)
            .map(Number)
            .filter(n => sources[n - 1])
            .map(n => {
                if (!order.includes(n)) order.push(n);
                return `[${sup(order.indexOf(n) + 1)}](${sources[n - 1].link})`;
            })
            .join(""),
    );
    const refs = order.map((n, i) => cite(sources[n - 1], i + 1)).join("  \n");
    return [body.trim(), refs, SIGNATURE].filter(Boolean).join("\n\n");
};

export const answer = async (ctx, mode, { spend = () => {}, style = "", similar = () => [], examples = [], history = [], model = MODELS.main } = {}) => {
    const text = context(ctx);
    spend(MODELS.fast);
    const { queries } = await generate(MODELS.fast, {
        system: QUERY_SYSTEM,
        prompt: `${text}\n\nWrite 4 to 8 search queries that would find earlier discussions relevant to the message being replied to.`,
        schema: QUERY_SCHEMA,
        thinking: "minimal",
        maxTokens: 512,
    });
    const sources = await retrieve(queries.slice(0, 8), { exclude: ctx.postId || "" });
    spend(model);
    const out = await generate(model, {
        system: [
            `${ANSWER_SYSTEM}\n\nWho you are:\n${persona()}`,
            style && `Style notes learned from how the community received your earlier replies. Follow them unless they conflict with the rules above:\n${style}`,
        ]
            .filter(Boolean)
            .join("\n\n"),
        prompt: `Mode: ${mode}\n\n${text}${memory(similar(queries), examples, history, ctx.target.author)}\n\nArchive sources:\n${sources.map((s, i) => `[${i + 1}] ${label(s)}: ${s.text}`).join("\n")}`,
        schema: ANSWER_SCHEMA,
        thinking: model === MODELS.fast ? "minimal" : "low",
    });
    return {
        queries,
        sources,
        body: out.reply.trim(),
        reply: render(out.reply, sources),
        calls: [MODELS.fast, model],
    };
};
