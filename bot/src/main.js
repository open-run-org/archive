import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Budget } from "./budget.js";
import { answer, MODELS } from "./compose.js";
import { loadEnv } from "./env.js";
import { generate, QuotaError } from "./gemini.js";
import { Memory } from "./memory.js";
import * as reddit from "./reddit.js";

for (const f of (process.env.ENV_FILES || "").split(",").filter(Boolean)) loadEnv(f);
if (!process.env.GEMINI_API_KEY && process.env.GEMINI_KEY_FILE) {
    process.env.GEMINI_API_KEY = readFileSync(process.env.GEMINI_KEY_FILE, "utf8").trim();
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run") || process.env.DRY_RUN === "1";
const ONCE = args.includes("--once");
const PREVIEW = args.includes("--random") ? Number(args[args.indexOf("--random") + 1]) || 1 : 0;
const SUBS = (process.env.SUBS || "iwanttorun,RunAustralia,runEuropaAlliance,runtoJapan,runtoJapan2,runtonihon").split(",");
const ALLOWED = new Set(SUBS.map(s => s.toLowerCase()));
const BOT = (process.env.REDDIT_BOT_NAME || "").toLowerCase();
const DIR = process.env.STATE_DIR || "state";
const FILE = join(DIR, "state.json");
const HOUR = 3600000;
const SRC = dirname(fileURLToPath(import.meta.url));
const version = () => {
    const h = createHash("sha1");
    for (const f of readdirSync(SRC).sort()) h.update(readFileSync(join(SRC, f)));
    return h.digest("hex");
};
const VERSION = version();
const DAY = 24 * HOUR;

mkdirSync(DIR, { recursive: true });
const state = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
state.done ??= [];
state.threads ??= [];
state.dead ??= {};
if (!DRY) state.launch ??= Date.now();
const memory = new Memory(DIR);
const budget = new Budget(state, {
    [MODELS.fast]: Number(process.env.QUOTA_FAST) || 1000,
    [MODELS.main]: Number(process.env.QUOTA_MAIN) || 250,
});
let pausedUntil = 0;
let lastRandom = 0;

const save = () => {
    state.done = state.done.slice(-5000);
    state.threads = state.threads.slice(-2000);
    writeFileSync(FILE, JSON.stringify(state));
};

const log = entry => {
    const line = JSON.stringify({ at: new Date().toISOString(), dry: DRY, ...entry });
    appendFileSync(join(DIR, "actions.jsonl"), `${line}\n`);
    console.log(line);
};

const isBot = name => !name || name === "[deleted]" || name.toLowerCase() === BOT || name === "AutoModerator" || /bot$/i.test(name);

const gone = x => ["[deleted]", "[removed]", ""].includes((x.body ?? `${x.title || ""}${x.selftext || ""}`).trim());

const postIdOf = x =>
    x.link_id?.slice(3) || x.context?.match(/\/comments\/([a-z0-9]+)\//)?.[1] || (x.name.startsWith("t3_") ? x.name.slice(3) : "");

const who = name => (name?.toLowerCase() === BOT ? "you" : name);

const contextOf = t => ({
    today: new Date().toISOString().slice(0, 10),
    postId: t.post.id,
    sub: `r/${t.post.subreddit}`,
    title: t.post.title,
    body: t.post.is_self ? t.post.selftext || "" : t.post.url || "",
    chain: t.chain.map(c => ({ author: who(c.author), text: c.body })),
    target:
        t.target === t.post
            ? { author: t.post.author, text: `${t.post.title}\n${t.post.selftext || ""}` }
            : { author: t.target.author, text: t.target.body },
});

const handle = async (item, mode) => {
    const postId = postIdOf(item);
    const t = await reddit.thread(postId, item.name.startsWith("t1_") ? item.name.slice(3) : "", item);
    if (!t?.target || isBot(t.target.author) || gone(t.target) || t.post.locked || t.post.archived) {
        log({ mode, target: item.name, skip: "unavailable" });
        return;
    }
    const ctx = contextOf(t);
    const out = await answer(ctx, mode, {
        spend: m => budget.spend(m),
        style: memory.style(),
        similar: q => memory.similar(q),
        examples: memory.examples(),
        history: memory.history(ctx.target.author),
        model: mode === "random" && budget.left(MODELS.main) < 30 ? MODELS.fast : MODELS.main,
    });
    const where = `https://www.reddit.com/r/${t.post.subreddit}/comments/${postId}/_/${item.name.startsWith("t1_") ? item.name.slice(3) : ""}`;
    const posted = DRY ? "dry-run" : await reddit.reply(item.name, out.reply);
    log({
        mode,
        target: item.name,
        where,
        posted,
        title: t.post.title,
        about: `${ctx.target.author}: ${ctx.target.text.slice(0, 300)}`,
        queries: out.queries,
        sources: out.sources.length,
        text: out.reply,
    });
    state.threads.push(`t3_${postId}`);
    if (posted && !DRY) {
        memory.record({
            id: posted,
            parent: item.name,
            url: where,
            mode,
            sub: `r/${t.post.subreddit}`,
            at: Date.now(),
            author: ctx.target.author,
            title: t.post.title,
            target: ctx.target.text.slice(0, 600),
            reply: out.body,
            queries: out.queries,
        });
    }
    return true;
};

const run = async fn => {
    try {
        return (await fn()) ? "posted" : "ok";
    } catch (e) {
        if (e instanceof QuotaError) {
            if (e.daily) budget.exhausted(e.model, e.limit);
            log({ error: "quota", model: e.model, daily: e.daily, limit: e.limit });
            return "retry";
        }
        const wait = e.message.match(/RATELIMIT.*?(\d+) (minute|second)/i);
        if (wait) {
            pausedUntil = Date.now() + Number(wait[1]) * (wait[2].startsWith("minute") ? 60000 : 1000);
            log({ error: "reddit ratelimit", seconds: (pausedUntil - Date.now()) / 1000 });
            return "retry";
        }
        log({ error: e.message });
        return "fail";
    } finally {
        save();
    }
};

const inbox = async () => {
    const read = [];
    const queue = [];
    for (const m of await reddit.inbox()) {
        const kind = m.type || m.subject;
        const rank = /comment.reply/.test(kind) ? 1 : /mention/.test(kind) ? 2 : 0;
        if (rank === 1) memory.noteReply(m.parent_id, m);
        const skip =
            m.kind !== "t1" ||
            !rank ||
            !ALLOWED.has((m.subreddit || "").toLowerCase()) ||
            isBot(m.author) ||
            state.done.includes(m.name);
        if (skip) read.push(m.name);
        else queue.push({ m, rank });
    }
    queue.sort((a, b) => a.rank - b.rank || a.m.created_utc - b.m.created_utc);
    for (const { m, rank } of queue) {
        if (Date.now() < pausedUntil || !budget.can({ [MODELS.fast]: 1, [MODELS.main]: 1 })) break;
        budget.interactive();
        if ((await run(() => handle(m, rank === 1 ? "reply" : "mention"))) === "retry") break;
        state.done.push(m.name);
        read.push(m.name);
    }
    if (!DRY) await reddit.markRead(read);
};

const cap = () => {
    const weeks = Math.floor((Date.now() - (state.launch || Date.now())) / (7 * DAY));
    return Math.max(1, Math.floor(Math.min(256, 16 * 2 ** weeks) / 2 ** memory.removals(7)));
};

const candidates = async () => {
    const now = Date.now() / 1000;
    const items = [];
    for (const sub of SUBS) {
        if ((state.dead[sub] || 0) > Date.now()) continue;
        try {
            for (const p of await reddit.newPosts(sub)) if (now - p.created_utc < 2 * 86400) items.push(p);
        } catch (e) {
            if (/HTTP (403|404)/.test(e.message)) state.dead[sub] = Date.now() + DAY;
        }
    }
    return items.filter(
        x =>
            !isBot(x.author) &&
            !gone(x) &&
            !x.locked &&
            !x.archived &&
            !state.done.includes(x.name) &&
            !state.threads.includes(x.name),
    );
};

const random = async count => {
    const credit = budget.randomCredit(MODELS.fast, MODELS.main);
    if (count === undefined && (credit < 1 || budget.randomToday() >= cap() || Date.now() - (state.randomAt || 0) < DAY / cap())) return;
    let n = count ?? 1;
    if (Date.now() < pausedUntil) return;
    const items = await candidates();
    while (n > 0 && items.length) {
        const x = items.splice(Math.floor(Math.random() * items.length), 1)[0];
        if (!budget.can({ [MODELS.fast]: 1 })) break;
        const status = await run(() => handle(x, "random"));
        if (status === "retry") break;
        state.done.push(x.name);
        if (status === "posted") {
            n -= 1;
            budget.useCredit();
            state.randomAt = Date.now();
        }
    }
};

const learn = async () => {
    if (Date.now() - (state.checked || 0) > HOUR) {
        state.checked = Date.now();
        await run(() => memory.refresh(reddit.info));
    }
    if (memory.due() && budget.can({ [MODELS.main]: 1 })) {
        await run(async () => {
            budget.spend(MODELS.main);
            const summary = await memory.reflect(generate, MODELS.main);
            if (summary) log({ learned: summary });
        });
    }
};

const tick = async () => {
    await run(inbox);
    if (Date.now() - lastRandom >= 5 * 60000) {
        lastRandom = Date.now();
        await run(() => random());
    }
    await run(learn);
};

if (args.includes("--target")) {
    const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "random";
    for (const x of await reddit.info(args[args.indexOf("--target") + 1].split(","))) await run(() => handle(x, mode));
} else if (ONCE) {
    await run(inbox);
    if (PREVIEW) await run(() => random(PREVIEW));
} else {
    console.log(`archive bot as u/${BOT} in ${SUBS.join(", ")}${DRY ? " (dry run)" : ""}`);
    budget.randomCredit(MODELS.fast, MODELS.main);
    for (;;) {
        if (version() !== VERSION) {
            log({ restart: "code changed" });
            process.exit(0);
        }
        await tick();
        await new Promise(ok => setTimeout(ok, 60000));
    }
}
