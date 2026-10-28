import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Answer, answer, type Context, reddit as forReddit, MODELS, type Mode, site } from "./agent";
import { trim } from "./archive";
import { Budget, type BudgetState } from "./budget";
import { loadEnv } from "./env";
import { generate, QuotaError } from "./gemini";
import { client, Limiter, type LimitState, type Status } from "./limit";
import { Log, place } from "./log";
import { Memory } from "./memory";
import * as reddit from "./reddit";

for (const f of (process.env.ENV_FILES ?? "").split(",").filter(Boolean)) loadEnv(f);
if (!process.env.GEMINI_API_KEY && process.env.GEMINI_KEY_FILE) process.env.GEMINI_API_KEY = readFileSync(process.env.GEMINI_KEY_FILE, "utf8").trim();

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => (flag(name) ? args[args.indexOf(name) + 1] : undefined);
const DRY = flag("--dry-run") || process.env.DRY_RUN === "1";
const SUBS = (process.env.SUBS ?? "iwanttorun,RunAustralia,runEuropaAlliance,runtoJapan,runtoJapan2,runtonihon").split(",");
const ALLOWED = new Set(SUBS.map(s => s.toLowerCase()));
const BOT = (process.env.REDDIT_BOT_NAME ?? "").toLowerCase();
const DIR = process.env.STATE_DIR ?? "state";
const FILE = join(DIR, "state.json");
const ORIGINS = (process.env.ASK_ORIGINS ?? "https://archive.open-run.org").split(",");
const PER_REPLY = 4;
const HOUR = 3600000;
const DAY = 24 * HOUR;

const SRC = import.meta.dir;
const version = () => {
    const h = createHash("sha1");
    for (const f of readdirSync(SRC).sort()) h.update(readFileSync(join(SRC, f)));
    h.update(readFileSync(join(SRC, "..", "persona.md")));
    return h.digest("hex");
};
const VERSION = version();

type State = { done: string[]; threads: string[]; launch?: number; randomAt?: number; checked?: number; budget?: BudgetState; limits?: LimitState };

mkdirSync(DIR, { recursive: true });
const state = (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {}) as State;
state.done ??= [];
state.threads ??= [];
if (!DRY && !flag("--serve")) state.launch ??= Date.now();
const memory = new Memory(DIR);
const budget = new Budget(state, {
    [MODELS.fast]: Number(process.env.QUOTA_FAST) || 1000,
    [MODELS.main]: Number(process.env.QUOTA_MAIN) || 250,
});
const limiter = new Limiter(state, Number(process.env.ASK_PAUSE) || 900);
const chats = new Log(DIR);
let pausedUntil = 0;
let lastRandom = 0;

const save = () => {
    state.done = state.done.slice(-5000);
    state.threads = state.threads.slice(-2000);
    writeFileSync(FILE, JSON.stringify(state));
};

const log = (entry: Record<string, unknown>) => {
    const line = JSON.stringify({ at: new Date().toISOString(), dry: DRY, ...entry });
    appendFileSync(join(DIR, "actions.jsonl"), `${line}\n`);
    console.log(line);
};

const MENTION = new RegExp(`(^|[^\\w-])/?u/${BOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");

let cached = { at: 0, posts: [] as reddit.Thing[] };
const feed = async () => {
    if (Date.now() - cached.at > 50000) cached = { at: Date.now(), posts: await reddit.newPosts(SUBS.join("+"), 100) };
    return cached.posts;
};

const isBot = (name?: string) => !name || name === "[deleted]" || name.toLowerCase() === BOT || name === "AutoModerator" || /bot$/i.test(name);

const gone = (x: reddit.Thing) => ["[deleted]", "[removed]", ""].includes((x.body ?? `${x.title ?? ""}${x.selftext ?? ""}`).trim());

const postIdOf = (x: reddit.Thing) =>
    x.link_id?.slice(3) || x.context?.match(/\/comments\/([a-z0-9]+)\//)?.[1] || (x.name.startsWith("t3_") ? x.name.slice(3) : "");

const who = (name: string) => (name.toLowerCase() === BOT ? "you" : name);

const contextOf = (t: reddit.Thread): Context => ({
    today: new Date().toISOString().slice(0, 10),
    postId: t.post.id,
    sub: `r/${t.post.subreddit}`,
    title: t.post.title,
    body: t.post.is_self ? (t.post.selftext ?? "") : (t.post.url ?? ""),
    chain: t.chain.map(c => ({ author: who(c.author), text: c.body ?? "" })),
    target:
        t.target === t.post
            ? { author: t.post.author, text: `${t.post.title}\n${t.post.selftext ?? ""}` }
            : { author: t.target.author, text: t.target.body ?? "" },
});

const pick = (mode: Mode) => {
    if (budget.left(MODELS.main) >= (mode === "random" ? 30 : PER_REPLY)) return MODELS.main;
    return budget.left(MODELS.fast) >= PER_REPLY ? MODELS.fast : null;
};

const summary = (a: Answer) =>
    a.steps.map(s => (s.type === "search" ? `search ${s.query}` : s.type === "read" ? `read ${trim(s.title, 30)}` : `browse ${s.url}`));

const handle = async (item: reddit.Thing, mode: Mode) => {
    const postId = postIdOf(item);
    const commentId = item.name.startsWith("t1_") ? item.name.slice(3) : "";
    const t = await reddit.thread(postId, commentId, item);
    if (!t || isBot(t.target.author) || gone(t.target) || t.post.locked || t.post.archived) {
        log({ mode, target: item.name, skip: "unavailable" });
        return false;
    }
    const model = pick(mode);
    if (!model) throw new QuotaError("no model has quota left", MODELS.main, true, 0);
    const ctx = contextOf(t);
    const started = Date.now();
    const a = await answer(ctx, mode, {
        model,
        style: memory.style(),
        history: memory.history(ctx.target.author),
        similar: memory.similar(ctx.target.text),
        examples: memory.examples(),
        spend: m => budget.spend(m),
    });
    const text = forReddit(a);
    const where = `https://www.reddit.com/r/${t.post.subreddit}/comments/${postId}/_/${commentId}`;
    const posted = DRY ? "dry-run" : await reddit.reply(item.name, text);
    const shown = site(a);
    chats.write({
        source: "reddit",
        status: DRY ? "dry-run" : "posted",
        thread: `t3_${postId}`,
        author: ctx.target.author,
        place: `r/${t.post.subreddit}`,
        link: where,
        question: ctx.target.text,
        history: { mode, target: item.name, title: t.post.title, body: ctx.body, chain: ctx.chain, posted },
        answer: text,
        refs: shown.refs,
        steps: a.steps,
        model: a.model,
        turns: a.turns,
        ms: Date.now() - started,
    });
    log({
        mode,
        target: item.name,
        where,
        posted,
        title: t.post.title,
        about: `${ctx.target.author}: ${ctx.target.text.slice(0, 300)}`,
        model: a.model,
        turns: a.turns,
        steps: summary(a),
        text,
    });
    state.threads.push(`t3_${postId}`);
    if (!DRY) {
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
            reply: shown.text,
        });
    }
    return true;
};

const run = async (fn: () => Promise<unknown>) => {
    try {
        return (await fn()) ? "posted" : "ok";
    } catch (e) {
        if (e instanceof QuotaError) {
            if (e.daily) budget.exhausted(e.model, e.limit);
            log({ error: "quota", model: e.model, daily: e.daily, limit: e.limit });
            return "retry";
        }
        const message = e instanceof Error ? e.message : String(e);
        const wait = message.match(/RATELIMIT.*?(\d+) (minute|second)/i);
        if (wait) {
            pausedUntil = Date.now() + Number(wait[1]) * (wait[2]?.startsWith("minute") ? 60000 : 1000);
            log({ error: "reddit ratelimit", seconds: (pausedUntil - Date.now()) / 1000 });
            return "retry";
        }
        log({ error: message });
        return "fail";
    } finally {
        save();
    }
};

const inbox = async () => {
    const read: string[] = [];
    const queue: { m: reddit.Thing; rank: number; fromInbox?: boolean }[] = [];
    for (const m of await reddit.inbox()) {
        const kind = m.type ?? m.subject ?? "";
        const rank = /comment.reply/.test(kind) ? 1 : /mention/.test(kind) ? 2 : 0;
        if (rank === 1 && m.parent_id) memory.noteReply(m.parent_id, m);
        const skip = m.kind !== "t1" || !rank || !ALLOWED.has((m.subreddit ?? "").toLowerCase()) || isBot(m.author) || state.done.includes(m.name);
        if (skip) read.push(m.name);
        else queue.push({ m, rank, fromInbox: true });
    }
    for (const p of await feed()) {
        const fresh = Date.now() / 1000 - p.created_utc < 2 * 86400;
        if (fresh && MENTION.test(`${p.title}\n${p.selftext ?? ""}`) && !isBot(p.author) && !gone(p) && !state.done.includes(p.name)) {
            queue.push({ m: p, rank: 2 });
        }
    }
    queue.sort((a, b) => a.rank - b.rank || a.m.created_utc - b.m.created_utc);
    for (const { m, rank, fromInbox } of queue) {
        if (Date.now() < pausedUntil || !pick("mention")) break;
        budget.interactive();
        if ((await run(() => handle(m, rank === 1 ? "reply" : "mention"))) === "retry") break;
        state.done.push(m.name);
        if (fromInbox) read.push(m.name);
    }
    if (!DRY) await reddit.markRead(read);
};

const cap = () => {
    const weeks = Math.floor((Date.now() - (state.launch ?? Date.now())) / (7 * DAY));
    return Math.max(1, Math.floor(Math.min(256, 16 * 2 ** weeks) / 2 ** memory.removals(7)));
};

const candidates = async () => {
    const now = Date.now() / 1000;
    return (await feed()).filter(
        x =>
            now - x.created_utc < 2 * 86400 &&
            !isBot(x.author) &&
            !gone(x) &&
            !x.locked &&
            !x.archived &&
            !state.done.includes(x.name) &&
            !state.threads.includes(x.name),
    );
};

const random = async (count?: number) => {
    const credit = budget.randomCredit(MODELS.main, PER_REPLY);
    if (count === undefined && (credit < 1 || budget.randomToday() >= cap() || Date.now() - (state.randomAt ?? 0) < DAY / cap())) return;
    let n = count ?? 1;
    if (Date.now() < pausedUntil) return;
    const items = await candidates();
    while (n > 0 && items.length) {
        const x = items.splice(Math.floor(Math.random() * items.length), 1)[0];
        if (!x) break;
        if (!pick("random")) break;
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
    if (Date.now() - (state.checked ?? 0) > HOUR) {
        state.checked = Date.now();
        await run(() => memory.refresh(reddit.info));
    }
    if (memory.due() && budget.left(MODELS.main) >= 1) {
        await run(async () => {
            budget.spend(MODELS.main);
            const summary = await memory.reflect(generate, MODELS.main);
            if (summary) log({ learned: summary });
        });
    }
};

const sse = (o: Record<string, unknown>) => new TextEncoder().encode(`data: ${JSON.stringify(o)}\n\n`);

type Turn = { role: "visitor" | "you"; text: string };

const conversation = (raw: unknown): Turn[] =>
    (Array.isArray(raw) ? raw : [])
        .flatMap(m => {
            const role = (m as { role?: unknown })?.role;
            const text = String((m as { text?: unknown })?.text ?? "").trim();
            return (role === "visitor" || role === "you") && text ? [{ role, text: text.slice(0, 4000) } as Turn] : [];
        })
        .slice(-12);

const limitInfo = (st: Status) => ({ until: st.until, span: st.span, used: st.used, reset: st.reset });

const serve = (port: number) => {
    const server = Bun.serve({
        port,
        hostname: "0.0.0.0",
        idleTimeout: 255,
        fetch: async req => {
            const url = new URL(req.url);
            const origin = req.headers.get("origin") ?? "";
            const cors: Record<string, string> = ORIGINS.includes(origin) ? { "access-control-allow-origin": origin, vary: "origin" } : {};
            const peer = server.requestIP(req)?.address ?? "";
            const ip = client(req, peer);
            if (url.pathname === "/health") return new Response("ok", { headers: cors });
            if (url.pathname === "/limit") return Response.json(limitInfo(limiter.status(ip)), { headers: { ...cors, "cache-control": "no-store" } });
            if (url.pathname !== "/ask") return new Response("not found", { status: 404 });
            if (req.method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" },
                });
            }
            if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: cors });
            const raw = await req.text().catch(() => "");
            let body: { q?: unknown; history?: unknown; client?: unknown } = {};
            try {
                body = JSON.parse(raw) as typeof body;
            } catch {}
            const q = String(body.q ?? "").trim();
            const who = (body.client ?? {}) as { visitor?: unknown; thread?: unknown; turn?: unknown };
            const base = {
                source: "site" as const,
                visitor: typeof who.visitor === "string" ? who.visitor.slice(0, 64) : null,
                thread: typeof who.thread === "string" ? who.thread.slice(0, 64) : null,
                turn: typeof who.turn === "number" ? who.turn : null,
                ip,
                edge: peer,
                ...place(req),
                client: body.client ?? null,
                question: q || raw.slice(0, 4000),
                history: body.history ?? null,
            };
            if (!q || q.length > 2000) {
                chats.write({ ...base, status: "bad" });
                return Response.json({ error: "bad question" }, { status: 400, headers: cors });
            }
            const now = limiter.status(ip);
            if (!now.ok) {
                chats.write({ ...base, status: "limited", limits: limitInfo(now) });
                return Response.json({ error: "wait", ...limitInfo(now) }, { status: 429, headers: cors });
            }
            const model = pick("ask");
            if (!model) {
                chats.write({ ...base, status: "quota" });
                return Response.json({ error: "Mofufu is out of quota for today." }, { status: 503, headers: cors });
            }
            const after = limiter.take(ip);
            const started = Date.now();
            save();
            budget.interactive();
            const stream = new ReadableStream({
                start: async c => {
                    c.enqueue(sse({ type: "limit", ...limitInfo(after) }));
                    try {
                        const ctx = {
                            today: new Date().toISOString().slice(0, 10),
                            target: { author: "a visitor", text: q },
                            conversation: conversation(body.history),
                        };
                        const a = await answer(ctx, "ask", {
                            model,
                            style: memory.style(),
                            spend: m => budget.spend(m),
                            onStep: s => c.enqueue(sse({ type: "step", step: s })),
                        });
                        const shown = site(a);
                        c.enqueue(sse({ type: "answer", ...shown }));
                        log({ mode: "ask", q: trim(q, 200), model: a.model, turns: a.turns, steps: summary(a) });
                        chats.write({
                            ...base,
                            status: "ok",
                            answer: shown.text,
                            refs: shown.refs,
                            steps: a.steps,
                            model: a.model,
                            turns: a.turns,
                            ms: Date.now() - started,
                            limits: limitInfo(after),
                        });
                    } catch (e) {
                        if (e instanceof QuotaError && e.daily) budget.exhausted(e.model, e.limit);
                        const message = e instanceof Error ? e.message : String(e);
                        log({ mode: "ask", error: message });
                        chats.write({ ...base, status: "error", error: message, model, ms: Date.now() - started, limits: limitInfo(after) });
                        c.enqueue(
                            sse({
                                type: "error",
                                message: e instanceof QuotaError ? "Mofufu is out of quota for today." : "Mofufu could not answer this time.",
                            }),
                        );
                    } finally {
                        save();
                        c.close();
                    }
                },
            });
            return new Response(stream, { headers: { ...cors, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
        },
    });
    return server;
};

const tick = async () => {
    await run(inbox);
    if (Date.now() - lastRandom >= 5 * 60000) {
        lastRandom = Date.now();
        await run(() => random());
    }
    await run(learn);
};

if (process.env.PORT) serve(Number(process.env.PORT));

const target = value("--target");
if (target) {
    const mode = (value("--mode") ?? "random") as Mode;
    for (const x of await reddit.info(target.split(","))) await run(() => handle(x, mode));
} else if (flag("--once")) {
    await run(inbox);
    const n = Number(value("--random"));
    if (n) await run(() => random(n));
} else if (!flag("--serve")) {
    console.log(`archive bot as u/${BOT} in ${SUBS.join(", ")}${DRY ? " (dry run)" : ""}`);
    budget.randomCredit(MODELS.main, PER_REPLY);
    for (;;) {
        if (version() !== VERSION) {
            log({ restart: "code changed" });
            process.exit(0);
        }
        await tick();
        await Bun.sleep(60000);
    }
}
