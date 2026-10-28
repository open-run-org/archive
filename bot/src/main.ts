import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Action, type Answer, answer, type Context, reddit as forReddit, MODELS, type Mode, persona, refine, site } from "./agent";
import { trim } from "./archive";
import { Desk, type Kind } from "./digest";
import { loadEnv } from "./env";
import { generate, QuotaError, setMeter } from "./gemini";
import { charge, Ledger } from "./ledger";
import { client, FREE, Limiter, type LimitState, type Status } from "./limit";
import { Log, place } from "./log";
import { compose, fresh, type Letter, Mailbox, PAGES, type Signature } from "./mail";
import { Memory } from "./memory";
import { MARGIN, Money, ownerMail, ownerReddit, type Standing, TIERS } from "./money";
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
const PROFILE = `u_${BOT}`;
const DIR = process.env.STATE_DIR ?? "state";
const FILE = join(DIR, "state.json");
const ORIGINS = (process.env.ASK_ORIGINS ?? "https://archive.open-run.org").split(",");
const API = (process.env.PUBLIC_API || "https://archive-bot.open-run.org").replace(/\/$/, "");
const QUEUE = Number(process.env.MAIL_QUEUE) || 4;
const RESERVE = Number(process.env.MEMBER_RESERVE) || 0.4;
const HOUR = 3600000;
const DAY = 24 * HOUR;

const SRC = import.meta.dir;
const version = () => {
    const h = createHash("sha1");
    for (const f of readdirSync(SRC).sort()) h.update(readFileSync(join(SRC, f)));
    for (const f of ["persona.md", "about.md", "package.json", "bun.lock"]) if (existsSync(join(SRC, "..", f))) h.update(readFileSync(join(SRC, "..", f)));
    return h.digest("hex");
};
const VERSION = version();

type Queued = { thing: reddit.Thing; rank: number; author: string; at: number; tries?: number };
type State = {
    done: string[];
    threads: string[];
    launch?: number;
    randomAt?: number;
    checked?: number;
    limits?: LimitState;
    mail?: { limits?: LimitState };
    reddit?: { limits?: LimitState; queue?: Queued[] };
    random?: { day: string; count: number };
    digest?: Partial<Record<Kind, string>>;
    about?: { id: string; url: string; hash: string; pinned: boolean };
    fails?: Record<string, number>;
};

mkdirSync(DIR, { recursive: true });
const state = (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {}) as State;
state.done ??= [];
state.threads ??= [];
state.mail ??= {};
state.reddit ??= {};
state.reddit.queue ??= [];
state.fails ??= {};
const fails = state.fails;
if (!DRY && !flag("--serve")) state.launch ??= Date.now();
const memory = new Memory(DIR);
const ledger = new Ledger(DIR);
setMeter((model, usage, searches) => ledger.record(model, usage, searches));
const money = new Money(DIR, ledger);
const limiter = new Limiter(state, Number(process.env.ASK_PAUSE) || 900);
const chats = new Log(DIR);
const mailbox = process.env.MAIL_SECRET ? new Mailbox(DIR) : null;
const mailLimiter = new Limiter(state.mail, Number(process.env.MAIL_PAUSE) || Number(process.env.ASK_PAUSE) || 900);
const redditLimiter = new Limiter(state.reddit, Number(process.env.REDDIT_PAUSE) || Number(process.env.ASK_PAUSE) || 900);
const queue = state.reddit.queue;
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

const desk = new Desk(DIR, {
    money,
    mailbox,
    bot: BOT,
    api: API,
    post: process.env.DIGEST_POST === "1",
    mail: process.env.DIGEST_MAIL === "1",
    log,
    status: email => signature(email),
    about: () => guide(),
});

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

const blocked: Record<string, number> = {};
const pick = () => [MODELS.main, MODELS.fast].find(m => (blocked[m] ?? 0) <= Date.now()) ?? null;
const cool = (e: QuotaError) => {
    blocked[e.model] = Date.now() + (e.daily ? 3 * HOUR : 2 * 60000);
};

const surplus = () => money.budget().surplus;

const free = (s: Standing | null) => Boolean(s && (s.tier === "owner" || money.left(s) > RESERVE));

const deepen = async (a: Answer, request: string, onStep?: Parameters<typeof refine>[1]["onStep"]) => {
    try {
        return await refine(a, { request, onStep });
    } catch (e) {
        log({ refine: e instanceof Error ? e.message : String(e) });
        return a;
    }
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
    const model = pick();
    if (!model) throw new QuotaError("no model is available", MODELS.main, false, 0);
    const ctx = contextOf(t);
    const owner = ownerReddit(ctx.target.author);
    const tag = mode === "random" ? "random" : owner ? "owner" : "reply";
    const started = Date.now();
    const a = await charge(tag, async () => {
        const draft = await answer(ctx, mode, {
            model,
            style: memory.style(),
            history: memory.history(ctx.target.author),
            similar: memory.similar(ctx.target.text),
            examples: memory.examples(),
        });
        if (mode === "random" || !(owner || surplus() > 0)) return draft;
        return await deepen(
            draft,
            [`Post: ${ctx.title ?? ""}`, trim(ctx.body ?? "", 1500), `Message by ${ctx.target.author}: ${trim(ctx.target.text, 1500)}`].join("\n"),
        );
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
            cool(e);
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

const summon = async (m: reddit.Thing, rank: number) => {
    const author = (m.author ?? "").toLowerCase();
    const owner = ownerReddit(author);
    if (!owner && !redditLimiter.status(author).ok) {
        if (queue.filter(q => q.author === author).length < QUEUE) {
            queue.push({ thing: m, rank, author, at: Date.now() });
            log({ mode: rank === 1 ? "reply" : "mention", target: m.name, queued: author });
        } else log({ mode: rank === 1 ? "reply" : "mention", target: m.name, dropped: author, reason: "queue full" });
        return "queued";
    }
    const status = await run(() => handle(m, rank === 1 ? "reply" : "mention"));
    if (status === "posted" && !owner) redditLimiter.take(author);
    return status;
};

const drainReddit = async () => {
    const seen = new Set<string>();
    for (const q of [...queue].sort((a, b) => a.at - b.at)) {
        if (seen.has(q.author)) continue;
        seen.add(q.author);
        if (!redditLimiter.status(q.author).ok) continue;
        if (Date.now() < pausedUntil || !pick()) break;
        const status = await run(() => handle(q.thing, q.rank === 1 ? "reply" : "mention"));
        if (status === "retry") break;
        q.tries = (q.tries ?? 0) + 1;
        if (status === "fail" && q.tries < 3) continue;
        queue.splice(queue.indexOf(q), 1);
        if (status === "posted") redditLimiter.take(q.author);
    }
};

const inbox = async () => {
    const read: string[] = [];
    const todo: { m: reddit.Thing; rank: number; fromInbox?: boolean; issue?: string }[] = [];
    for (const m of await reddit.inbox()) {
        const kind = m.type ?? m.subject ?? "";
        const sub = (m.subreddit ?? "").toLowerCase();
        const onIssue = /post.reply/.test(kind) && sub === PROFILE;
        const rank = /comment.reply/.test(kind) || onIssue ? 1 : /mention/.test(kind) ? 2 : 0;
        if (/comment.reply/.test(kind) && m.parent_id) memory.noteReply(m.parent_id, m);
        const found = onIssue ? desk.issue(`t3_${postIdOf(m)}`) : null;
        const issue = found ? `${found.kind} ${found.edition}` : undefined;
        const skip = m.kind !== "t1" || !rank || !(ALLOWED.has(sub) || sub === PROFILE) || isBot(m.author) || state.done.includes(m.name);
        if (skip) read.push(m.name);
        else todo.push({ m, rank, fromInbox: true, issue });
    }
    for (const p of await feed()) {
        const recent = Date.now() / 1000 - p.created_utc < 2 * 86400;
        if (recent && MENTION.test(`${p.title}\n${p.selftext ?? ""}`) && !isBot(p.author) && !gone(p) && !state.done.includes(p.name)) {
            todo.push({ m: p, rank: 2 });
        }
    }
    todo.sort((a, b) => a.rank - b.rank || a.m.created_utc - b.m.created_utc);
    for (const { m, rank, fromInbox, issue } of todo) {
        if (Date.now() < pausedUntil || !pick()) break;
        const status = await summon(m, rank);
        if (status === "retry") break;
        if (status === "fail") {
            fails[m.name] = (fails[m.name] ?? 0) + 1;
            if ((fails[m.name] ?? 0) < 3) continue;
        }
        delete fails[m.name];
        if (issue) desk.feedback({ at: m.created_utc * 1000, source: "reddit", issue, author: m.author, text: m.body ?? "" });
        state.done.push(m.name);
        if (fromInbox) read.push(m.name);
    }
    if (!DRY) await reddit.markRead(read);
};

const randomTarget = async () => {
    const now = Date.now() / 1000;
    const posts = (await feed()).filter(x => now - x.created_utc < 86400 && !isBot(x.author)).length;
    if (posts < 4) return 0;
    const since = Date.now() - 7 * DAY;
    const done = memory.replies.filter(r => r.mode === "random" && r.at > since).length;
    const unit = done >= 4 ? Math.max(0.001, ledger.spent(since, { tag: "random" }) / done) : 0.006;
    const extra = Math.floor((0.5 * Math.max(0, surplus())) / 30 / unit);
    return Math.max(4, Math.min(Math.floor(posts / 3), 4 + extra));
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

const rank = async (items: reddit.Thing[]) => {
    const now = Date.now() / 1000;
    const list = items
        .map(
            x =>
                `[${x.name}] r/${x.subreddit} · ${Math.round((now - x.created_utc) / 3600)} h old · score ${x.score ?? 0} · ${x.num_comments ?? 0} comments\nTitle: ${x.title ?? ""}\n${trim(x.selftext ?? "", 300)}`,
        )
        .join("\n\n");
    const out = await generate<{ order: string[] }>(MODELS.main, {
        system: `Who you are:\n${persona()}\n\nNobody summoned you. You choose which of these recent posts to reply to. Order them by your own judgement of where your reply adds the most, and return their ids in that order.`,
        prompt: list,
        schema: { type: "OBJECT", properties: { order: { type: "ARRAY", items: { type: "STRING" } } }, required: ["order"] },
        thinking: "low",
        maxTokens: 2048,
    });
    const named = new Map(items.map(x => [x.name, x]));
    const chosen = out.order.map(id => named.get(id.trim().replace(/^\[|\]$/g, ""))).filter((x): x is reddit.Thing => Boolean(x));
    return [...new Set([...chosen, ...items])];
};

const random = async (count?: number) => {
    const today = new Date().toISOString().slice(0, 10);
    if (state.random?.day !== today) state.random = { day: today, count: 0 };
    const tally = state.random;
    if (count === undefined) {
        const target = await randomTarget();
        const left = Date.parse(`${today}T00:00:00Z`) + DAY - Date.now();
        if (tally.count >= target || Date.now() - (state.randomAt ?? 0) < Math.min(DAY / target, left / (target - tally.count))) return;
    }
    let n = count ?? 1;
    if (Date.now() < pausedUntil) return;
    const found = await candidates();
    if (!found.length || !pick()) return;
    const items = found.length > 1 ? await charge("random", () => rank(found)).catch(() => found) : found;
    while (n > 0 && items.length) {
        const x = items.shift();
        if (!x) break;
        if (!pick()) break;
        const status = await run(() => handle(x, "random"));
        if (status === "retry") break;
        state.done.push(x.name);
        if (status === "fail") break;
        if (status === "posted") {
            n -= 1;
            tally.count += 1;
            state.randomAt = Date.now();
        }
    }
};

const learn = async () => {
    if (Date.now() - (state.checked ?? 0) > HOUR) {
        state.checked = Date.now();
        await run(() => memory.refresh(reddit.info));
        await money.refresh();
        await run(sync);
    }
    if (memory.due() && pick() === MODELS.main) {
        await run(async () => {
            const summary = await charge("learn", () => memory.reflect(generate, MODELS.main));
            if (summary) log({ learned: summary });
        });
    }
};

const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const day = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const clock = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const guide = () => (state.about ? `https://redd.it/${state.about.id.slice(3)}` : undefined);

const signature = (email: string, st?: Status): Signature => {
    const s = money.standing(email);
    const p = money.person(email);
    const base = { weekly: Boolean(p?.weekly), daily: s ? Boolean(p?.daily) : null, guide: guide() };
    if (s?.tier === "owner") return base;
    if (s && money.left(s) > RESERVE) {
        const share = Math.min(100, Math.max(0, Math.round(((money.left(s) - RESERVE) / Math.max(0.01, s.cap - RESERVE)) * 100)));
        return { ...base, quota: `${share}% left until ${day(s.until)}` };
    }
    const now = st ?? mailLimiter.status(email);
    const left = Math.max(0, FREE - now.used);
    const free = now.until ? `next answer at ${clock(now.until)}` : left ? `${left} of ${FREE} free left today` : "next answer now";
    const quota = s ? `Allowance used until ${day(s.until)} · ${free}` : free;
    return { ...base, quota: quota.charAt(0).toUpperCase() + quota.slice(1) };
};

const describe = (email: string, s: Standing | null) => {
    const p = money.person(email);
    const subs = `Weekly digest by email: ${p?.weekly ? "on" : "off"}. Daily digest: ${p?.daily ? "on" : "off"}.`;
    if (s?.tier === "owner") return `This is your owner, clareLab, writing from their own domain. ${subs}`;
    if (s) return `A ${s.tier} (€${s.amount.toFixed(2)} a month on Ko-fi) until ${new Date(s.until).toISOString().slice(0, 10)}. ${subs}`;
    return `Not a member; membership is €4 a month at ko-fi.com/clareLab, paid with this email address. ${subs}`;
};

const subscription = (email: string, s: Standing | null): Action => ({
    declaration: {
        name: "subscription",
        description:
            "Change this person's email subscriptions: 润学周报, the weekly digest, free for anyone; 润学日报, the daily digest, for members only. Call it only when they ask to subscribe, unsubscribe, or switch one of them on or off.",
        parameters: {
            type: "OBJECT",
            properties: {
                weekly: { type: "STRING", enum: ["on", "off"], description: "The weekly digest." },
                daily: { type: "STRING", enum: ["on", "off"], description: "The daily digest, members only." },
            },
        },
    },
    run: async x => {
        const weekly = x.weekly === "on" ? true : x.weekly === "off" ? false : undefined;
        const wanted = x.daily === "on" ? true : x.daily === "off" ? false : undefined;
        const daily = wanted && !s ? undefined : wanted;
        const p = money.subscribe(email, { weekly, daily });
        log({ subscription: email, weekly: p.weekly, daily: p.daily });
        return {
            weekly: p.weekly === 1,
            daily: p.daily === 1,
            member: s?.tier ?? null,
            note: wanted && !s ? "The daily is for members only (€4 a month at ko-fi.com/clareLab, paid with this email address), so it stays off." : undefined,
        };
    },
});

const answerMail = async (letter: Letter, model: string) => {
    if (!mailbox) return false;
    const started = Date.now();
    const standing = money.standing(letter.sender);
    const unlimited = free(standing);
    const owner = standing?.tier === "owner";
    const tag = owner ? "owner" : unlimited && standing ? `member:${standing.email}` : "qa";
    const conversation = mailbox.history(letter);
    const issue = mailbox.sent(letter);
    if (issue && !conversation.length) conversation.push({ role: "you", text: `(You sent them "${issue.subject}".)\n${trim(issue.text, 3000)}` });
    const author = letter.name ? `${letter.name} <${letter.sender}>` : letter.sender;
    const a = await charge(tag, async () => {
        const draft = await answer(
            {
                today: new Date().toISOString().slice(0, 10),
                title: letter.subject ?? "",
                target: { author, text: fresh(letter.text) },
                conversation,
                about: describe(letter.sender, standing),
            },
            "mail",
            { model, style: memory.style(), actions: [subscription(letter.sender, standing)] },
        );
        return unlimited || surplus() > 0 ? await deepen(draft, fresh(letter.text)) : draft;
    });
    const shown = site(a);
    const base = {
        source: "mail" as const,
        visitor: letter.sender,
        thread: letter.thread,
        turn: conversation.length / 2,
        author: letter.name,
        place: letter.subject,
        question: letter.text,
        history: conversation,
        answer: shown.text,
        refs: shown.refs,
        steps: a.steps,
        model: a.model,
        turns: a.turns,
        headers: JSON.parse(letter.headers),
    };
    try {
        const sent = await mailbox.send(letter, shown.text, shown.refs, signature(letter.sender, unlimited ? undefined : mailLimiter.peek(letter.sender)));
        const st = unlimited ? mailLimiter.status(letter.sender) : mailLimiter.take(letter.sender);
        mailbox.mark(letter.id, { status: "answered", answered_at: Date.now(), reply_id: sent.id, reply: shown.text, error: null });
        if (issue) desk.feedback({ at: Date.now(), source: "mail", issue: issue.subject ?? issue.kind, author: letter.sender, text: fresh(letter.text) });
        chats.write({
            ...base,
            status: "ok",
            ms: Date.now() - started,
            link: sent.id,
            client: { message_id: letter.message_id, auth: JSON.parse(letter.auth), via: sent.via, tier: standing?.tier ?? null },
            limits: limitInfo(st),
        });
        log({ mode: "mail", to: letter.sender, via: sent.via, model: a.model, turns: a.turns, steps: summary(a) });
        return true;
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const failed = Boolean((e as { permanent?: boolean }).permanent) || letter.attempts + 1 >= 3;
        mailbox.mark(letter.id, { status: failed ? "failed" : "queued", attempts: letter.attempts + 1, error: message });
        chats.write({ ...base, status: failed ? "failed" : "error", error: message, ms: Date.now() - started });
        log({ mode: "mail", to: letter.sender, error: message, failed });
        return false;
    }
};

let draining = false;
const drain = async () => {
    if (!mailbox || draining) return;
    draining = true;
    try {
        const seen = new Set<string>();
        for (const letter of mailbox.queued()) {
            if (seen.has(letter.sender)) continue;
            seen.add(letter.sender);
            if (!free(money.standing(letter.sender)) && !mailLimiter.status(letter.sender).ok) continue;
            const model = pick();
            if (!model || Date.now() < pausedUntil) break;
            if ((await run(() => answerMail(letter, model))) === "retry") break;
        }
    } finally {
        draining = false;
    }
};

const WELCOME = (s: Standing) =>
    [
        `${s.tier === "sponsor" ? "赞助" : "会员"}已开通：€${s.amount.toFixed(2)}/月，有效至 ${when(s.until).slice(0, 10)}。`,
        `权益与指令：${guide() ?? `https://www.reddit.com/user/${BOT}/`}`,
    ].join("\n");

const zh = (s: number) => (s >= 3600 ? `${s / 3600} 小时` : `${Math.round(s / 60)} 分钟`);
const DAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const about = () => {
    const local = (WEEKDAY * 24 + HOUR_UTC + 8) % 168;
    const cap = (eur: number) => MARGIN * eur - money.fee(eur);
    const values: Record<string, string> = {
        free: String(FREE),
        p1: zh(mailLimiter.pause(FREE)),
        p2: zh(mailLimiter.pause(FREE + 1)),
        p3: zh(mailLimiter.pause(FREE + 2)),
        queue: String(QUEUE),
        weekly: `每${DAYS[WEEKDAY]} ${String(HOUR_UTC).padStart(2, "0")}:00 UTC（北京时间${Math.floor(local / 24) === WEEKDAY ? "" : DAYS[Math.floor(local / 24)]} ${String(local % 24).padStart(2, "0")}:00）`,
        address: process.env.MAIL_ADDRESS || "bot.mofufu@clarelab.moe",
        member: `€${TIERS.member}`,
        sponsor: `€${TIERS.sponsor}`,
        ratio: (cap(TIERS.sponsor) / cap(TIERS.member)).toFixed(1),
    };
    return readFileSync(join(SRC, "..", "about.md"), "utf8")
        .trim()
        .replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
};

const sync = async () => {
    if (DRY) return false;
    const body = about();
    const hash = createHash("sha1").update(body).digest("hex");
    if (state.about?.hash === hash) return false;
    const old = state.about;
    if (old) {
        try {
            await reddit.edit(old.id, body);
            state.about = { ...old, hash };
            log({ about: "edited", id: old.id });
            return false;
        } catch (e) {
            const [x] = await reddit.info([old.id]);
            log({ about: "edit failed", error: e instanceof Error ? e.message : String(e), gone: !x || x.author === "[deleted]" });
            if (x && x.author !== "[deleted]") return false;
        }
    }
    const p = await reddit.submit(PROFILE, "Mofufu 使用说明", body);
    const pinned = await reddit.pin(p.name).then(
        () => true,
        e => {
            log({ about: "pin failed", error: e instanceof Error ? e.message : String(e) });
            return false;
        },
    );
    state.about = { id: p.name, url: p.url, hash, pinned };
    log({ about: "posted", ...state.about });
    return false;
};

const welcome = async (s: Standing) => {
    if (!mailbox) return;
    try {
        await mailbox.post(s.email, {
            kind: "welcome",
            subject: `Mofufu：${s.tier === "sponsor" ? "赞助" : "会员"}已开通`,
            text: WELCOME(s),
            refs: [],
            sig: signature(s.email),
        });
        log({ welcome: s.email, tier: s.tier });
    } catch (e) {
        log({ welcome: s.email, error: e instanceof Error ? e.message : String(e) });
    }
};

let digesting = false;
const HOUR_UTC = Number(process.env.DIGEST_HOUR ?? 0);
const WEEKDAY = Number(process.env.DIGEST_WEEKDAY ?? 0);
const digests = () => {
    const now = new Date();
    if (digesting || now.getUTCHours() < HOUR_UTC) return;
    const date = now.toISOString().slice(0, 10);
    state.digest ??= {};
    const kind: Kind = now.getUTCDay() === WEEKDAY ? "weekly" : "daily";
    if (state.digest[kind] === date) return;
    state.digest[kind] = date;
    save();
    digesting = true;
    void (async () => {
        try {
            if (kind === "weekly") {
                try {
                    const notes = await charge("weekly", () => desk.reflect());
                    if (notes) log({ digest: "notes", summary: notes });
                } catch (e) {
                    log({ digest: "notes", error: e instanceof Error ? e.message : String(e) });
                }
            }
            log({ digest: kind, ...(await desk.run(kind, { dry: DRY })) });
        } catch (e) {
            log({ digest: kind, error: e instanceof Error ? e.message : String(e) });
        } finally {
            digesting = false;
        }
    })();
};

const same = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
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

const page = (body: string, status = 200) =>
    new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

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
            if (url.pathname === "/kofi" && req.method === "POST") {
                const raw = new URLSearchParams(await req.text().catch(() => "")).get("data") ?? "";
                const got = money.accept(raw);
                log({ kofi: got.status, ...(got.status === "ok" ? { email: got.email, tier: got.standing?.tier ?? null, first: got.first } : {}) });
                if (got.status === "bad") return new Response("bad request", { status: 400 });
                if (got.status === "forbidden") return new Response("forbidden", { status: 403 });
                if (got.status === "ok" && got.first && got.standing && process.env.DIGEST_MAIL === "1") void welcome(got.standing);
                return new Response("ok");
            }
            if (url.pathname === "/unsubscribe") {
                const p = money.byToken(url.searchParams.get("t") ?? "");
                if (!p) return page(PAGES.invalid(), 404);
                const l = url.searchParams.get("l");
                const list = l === "weekly" || l === "daily" ? l : undefined;
                if (req.method === "POST") {
                    money.subscribe(p.email, list ? { [list]: false } : { weekly: false, daily: false });
                    log({ unsubscribe: p.email, list: list ?? "all" });
                    return page(PAGES.done(p.email, list));
                }
                return page(PAGES.ask(p.email, list));
            }
            if (url.pathname === "/mail" && req.method === "POST") {
                if (!mailbox || !same(req.headers.get("x-mail-secret") ?? "", process.env.MAIL_SECRET ?? "")) return new Response("forbidden", { status: 403 });
                const raw = new Uint8Array(await req.arrayBuffer());
                const got = await mailbox.receive(
                    raw,
                    { from: req.headers.get("x-envelope-from") ?? "", to: req.headers.get("x-envelope-to") ?? "" },
                    { unlimited: ownerMail },
                );
                log({ mail: got.status, sender: got.sender, reason: got.reason });
                if (got.status === "command" && got.change) {
                    const s = money.standing(got.sender);
                    const change = { ...got.change };
                    const refused = change.daily === true && !s;
                    if (refused) change.daily = undefined;
                    money.subscribe(got.sender, change);
                    const letter = mailbox.letter(got.id);
                    const text = `${[
                        change.weekly === true && "已订阅周报",
                        change.weekly === false && "已退订周报",
                        change.daily === true && "已开启日报",
                        change.daily === false && "已关闭日报",
                        refused && "日报仅限会员",
                    ]
                        .filter(Boolean)
                        .join("；")}。`;
                    if (letter) void mailbox.send(letter, text, [], signature(got.sender)).catch(e => log({ mail: "command", error: String(e) }));
                }
                if (got.status !== "queued")
                    chats.write({ source: "mail", status: got.status, visitor: got.sender, error: got.reason, link: `mail:${got.id}` });
                setTimeout(() => void run(drain), 0);
                return Response.json(got, { status: 202 });
            }
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
            const visitor = (body.client ?? {}) as { visitor?: unknown; thread?: unknown; turn?: unknown };
            const base = {
                source: "site" as const,
                visitor: typeof visitor.visitor === "string" ? visitor.visitor.slice(0, 64) : null,
                thread: typeof visitor.thread === "string" ? visitor.thread.slice(0, 64) : null,
                turn: typeof visitor.turn === "number" ? visitor.turn : null,
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
            const model = pick();
            if (!model) {
                chats.write({ ...base, status: "quota" });
                return Response.json({ error: "Mofufu is out of quota for today." }, { status: 503, headers: cors });
            }
            const after = limiter.take(ip);
            const started = Date.now();
            save();
            const stream = new ReadableStream({
                start: async c => {
                    c.enqueue(sse({ type: "limit", ...limitInfo(after) }));
                    try {
                        const ctx = {
                            today: new Date().toISOString().slice(0, 10),
                            target: { author: "a visitor", text: q },
                            conversation: conversation(body.history),
                        };
                        const onStep = (s: Answer["steps"][number]) => c.enqueue(sse({ type: "step", step: s }));
                        const a = await charge("qa", async () => {
                            const draft = await answer(ctx, "ask", { model, style: memory.style(), onStep });
                            return surplus() > 0 ? await deepen(draft, q, onStep) : draft;
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
                        if (e instanceof QuotaError) cool(e);
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
    await run(drain);
    await run(drainReddit);
    await run(inbox);
    if (Date.now() - lastRandom >= 5 * 60000) {
        lastRandom = Date.now();
        await run(() => random());
    }
    await run(learn);
    digests();
};

if (process.env.PORT) serve(Number(process.env.PORT));

const target = value("--target");
const preview = value("--digest") as Kind | undefined;
if (preview) {
    await money.refresh();
    const member = value("--member");
    const out = value("--out") ?? DIR;
    const p = await desk.preview(preview, { member: member ? (money.standing(member) ?? undefined) : undefined });
    const mail = compose(p.own.text, p.own.refs, p.footer, member ? signature(member) : undefined);
    writeFileSync(join(out, `${preview}.md`), `${p.title}\n\n${p.markdown}\n`);
    writeFileSync(join(out, `${preview}.html`), `<!doctype html><meta charset="utf-8"><title>${p.title}</title><h2>${p.title}</h2>${mail.html}`);
    writeFileSync(join(out, `${preview}.txt`), `${p.title}\n\n${mail.text}\n`);
    console.log(JSON.stringify({ title: p.title, posts: p.posts, chars: p.own.text.length, refs: p.own.refs.length, spend: ledger.report(Date.now() - HOUR) }));
} else if (flag("--about")) {
    console.log(about());
} else if (flag("--spend")) {
    await money.refresh();
    console.log(JSON.stringify({ budget: money.budget(), last30: ledger.report(Date.now() - 30 * DAY) }, null, 2));
} else if (target) {
    const mode = (value("--mode") ?? "random") as Mode;
    for (const x of await reddit.info(target.split(","))) await run(() => handle(x, mode));
} else if (flag("--once")) {
    await run(inbox);
    const n = Number(value("--random"));
    if (n) await run(() => random(n));
} else if (!flag("--serve")) {
    console.log(`archive bot as u/${BOT} in ${SUBS.join(", ")}${DRY ? " (dry run)" : ""}`);
    await money.refresh();
    await run(sync);
    for (;;) {
        if (version() !== VERSION) {
            log({ restart: "code changed" });
            process.exit(0);
        }
        await tick();
        await Bun.sleep(60000);
    }
}
