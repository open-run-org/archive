import { Database } from "bun:sqlite";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Answer, answer, reddit as forReddit, MODELS, Registry, refine, site } from "./agent";
import { type Comment, type Entry, listing, type Thread, thread, trim } from "./archive";
import { generate, write } from "./gemini";
import { charge } from "./ledger";
import type { Footer, Mailbox, Signature } from "./mail";
import type { Money, Person, Standing } from "./money";
import * as reddit from "./reddit";

const DAY = 86400000;

export type Kind = "weekly" | "daily";

const NAME: Record<Kind, string> = { weekly: "润学周报", daily: "润学日报" };
const SPAN: Record<Kind, number> = { weekly: 7 * DAY, daily: DAY };
const BEFORE: Record<Kind, number> = { weekly: 4, daily: 7 };
const LENGTH: Record<Kind, string> = { weekly: "1024 to 4096 Chinese characters", daily: "512 to 2048 Chinese characters" };

const SYSTEM = (
    kind: Kind,
    notes: string,
) => `You are the bot described under "Who you are", writing ${NAME[kind]} (${kind === "weekly" ? "the weekly" : "the daily"}), a digest of the Chinese-language emigration communities on Reddit (r/iwanttorun, r/runEuropaAlliance, r/runtoJapan2 and others) for their readers. You get every post and comment of the period from the archive, which keeps deleted and removed ones, each with a source id, plus statistics and your previous issue.

What it is:
- A synthesis, not a list of new posts. Find the trends: what people talk about, how it shifts compared with before, why, and what it means for someone planning to leave or already abroad.
- Back every trend with evidence: several posts, numbers from the statistics, or history from the archive (search_archive and read let you compare with earlier months).
- Wider news and analysis from outside Reddit are added in a second round, so leave room for them.
- When a post or comment you cite was deleted or removed, say so.

Form:
- Simplified Chinese. Plain, analytical and calm; no hype, no moralising.
- Open with a short overview of the period in two or three sentences. Then sections with "## " headings: the main trends first, then wider news and analysis, then a few posts or threads worth reading with one line on why each. Change the sections when the period calls for it.
- Length: ${LENGTH[kind]}. Use the room only when the period has that much worth saying.
- Put the source id right after each statement it supports, like [S3] or [S2][S5]. Never invent facts, numbers, names or quotes.
- Never put u/ before a username. No title line, no greeting, no sign-off and no reference list; they are added automatically.

Editorial notes learned from readers' feedback. Follow them unless they conflict with the rules above:
${notes}`;

const RESEARCH = (kind: Kind) =>
    `This is an issue of ${NAME[kind]}. Add the wider news and analysis that bear on its trends: policy changes in destination countries, events in China and abroad that drive the discussion, and corrections where the community's view is out of date. Keep the structure and the length limit of ${LENGTH[kind]}.`;

const PERSONAL = `You adapt one issue of a digest for a single reader who is a member. You get the issue, which cites sources as [S3] and so on, and what the reader recently asked or told you.
- Keep the issue's content, structure and citations; reorder or trim so what matters to this reader comes first.
- Add at the top a short paragraph for them, two to four sentences, that connects this issue to their situation. Base it only on what they told you.
- Same language. Never invent; keep every [S#] that stays in the text.
- Return only the adapted issue.`;

const REFLECT = `You maintain the editorial notes of 润学周报 and 润学日报, digests a bot writes for Chinese-language emigration communities on Reddit. You get the current notes and readers' feedback on recent issues: comments under the issues on Reddit, the issues' scores, and emails replying to them. Update the notes:
- Keep points the feedback supports, change or drop points it contradicts, add at most three new points.
- Every point must be concrete and checkable.
- At most 16 points, in English, as a "- " list.
Also summarise what you changed in one or two sentences.`;

const SEED = `- Lead with the one shift that matters most in the period and say why it matters.
- Prefer a few well-argued trends over many thin ones.
- Compare with earlier periods using the statistics or the archive.
- Name concrete visas, countries, sums and timelines when the posts do.
- Keep news to what bears on decisions to leave or to stay abroad.
`;

const SCHEMA = `
create table if not exists digests (
    id integer primary key,
    at integer not null,
    kind text not null,
    edition text not null,
    recipient text,
    title text not null,
    text text not null,
    markdown text,
    refs text,
    post text,
    url text,
    status text not null,
    error text
);
create index if not exists digests_kind on digests (kind, at);
`;

type Feedback = { at: number; source: "reddit" | "mail"; issue: string; author: string; text: string };
type Row = { id: number; at: number; kind: string; edition: string; text: string; post: string | null };

const iso = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const day = (at: number) => new Date(at + 8 * 3600_000).toISOString().slice(0, 10);
const name = (s: string) => s.replace(/[()[\]\\^*_~`|<>#]/g, "").trim();

const walk = (roots: Comment[], cap: number) => {
    const out: { c: Comment; depth: number }[] = [];
    const go = (list: Comment[], depth: number) => {
        for (const c of list) {
            if (out.length >= cap) return;
            out.push({ c, depth });
            go(c.kids, depth + 1);
        }
    };
    go(roots, 0);
    return out;
};

const count = <T>(xs: T[], key: (x: T) => string) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return m;
};

const pool = async <T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>) => {
    const out: R[] = new Array(xs.length);
    let i = 0;
    await Promise.all(
        Array.from({ length: Math.min(n, xs.length) }, async () => {
            while (i < xs.length) {
                const k = i++;
                out[k] = await fn(xs[k] as T);
            }
        }),
    );
    return out;
};

export class Desk {
    private readonly db: Database;
    private readonly paths: { notes: string; history: string; feedback: string };

    constructor(
        dir: string,
        private readonly o: {
            money: Money;
            mailbox: Mailbox | null;
            bot: string;
            api: string;
            post: boolean;
            mail: boolean;
            log: (e: Record<string, unknown>) => void;
            status: (email: string, unsubscribe?: string) => Signature;
            about: () => string | undefined;
        },
    ) {
        this.db = new Database(join(dir, "chats.db"), { create: true });
        this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
        this.db.exec(SCHEMA);
        this.paths = { notes: join(dir, "digest-notes.md"), history: join(dir, "digest-notes"), feedback: join(dir, "digest-feedback.jsonl") };
        mkdirSync(this.paths.history, { recursive: true });
        if (!existsSync(this.paths.notes)) writeFileSync(this.paths.notes, SEED);
    }

    notes() {
        return readFileSync(this.paths.notes, "utf8").trim();
    }

    issue(name: string) {
        return (this.db.query("select id, at, kind, edition, text, post from digests where post = ?").get(name) as Row | null) ?? null;
    }

    feedback(f: Feedback) {
        appendFileSync(this.paths.feedback, `${JSON.stringify(f)}\n`);
    }

    private last(kind: Kind) {
        return (
            (this.db
                .query("select id, at, kind, edition, text, post from digests where kind = ? and recipient is null order by at desc limit 1")
                .get(kind) as Row | null) ?? null
        );
    }

    private save(r: {
        kind: string;
        edition: string;
        recipient?: string | null;
        title: string;
        text: string;
        markdown?: string;
        refs?: unknown;
        post?: string;
        url?: string;
        status: string;
        error?: string;
    }) {
        this.db
            .query(
                "insert into digests (at, kind, edition, recipient, title, text, markdown, refs, post, url, status, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
                Date.now(),
                r.kind,
                r.edition,
                r.recipient ?? null,
                r.title,
                r.text,
                r.markdown ?? null,
                r.refs ? JSON.stringify(r.refs) : null,
                r.post ?? null,
                r.url ?? null,
                r.status,
                r.error ?? null,
            );
    }

    async reflect() {
        const since = Number(existsSync(join(this.paths.history, "at")) ? readFileSync(join(this.paths.history, "at"), "utf8") : 0);
        const fresh = existsSync(this.paths.feedback)
            ? readFileSync(this.paths.feedback, "utf8")
                  .split("\n")
                  .filter(Boolean)
                  .map(l => JSON.parse(l) as Feedback)
                  .filter(f => f.at > since)
            : [];
        if (!fresh.length) return null;
        const posted = this.db.query("select post, edition, kind from digests where post is not null and at > ? order by at").all(Date.now() - 30 * DAY) as {
            post: string;
            edition: string;
            kind: string;
        }[];
        const scores = posted.length ? await reddit.info(posted.map(p => p.post)).catch(() => []) : [];
        const out = await generate<{ notes: string; summary: string }>(MODELS.main, {
            system: REFLECT,
            prompt: [
                `Current notes:\n${this.notes()}`,
                `Issues on Reddit and their scores:\n${posted.map(p => `- ${p.kind} ${p.edition}: score ${scores.find(x => x.name === p.post)?.score ?? "?"}`).join("\n") || "(none)"}`,
                `Feedback since the last update:\n${fresh.map(f => `- ${f.source}, on ${f.issue}, ${f.author}: ${trim(flat(f.text), 400)}`).join("\n")}`,
            ].join("\n\n"),
            schema: { type: "OBJECT", properties: { notes: { type: "STRING" }, summary: { type: "STRING" } }, required: ["notes", "summary"] },
            thinking: "medium",
            maxTokens: 8192,
        });
        const notes = out.notes.trim();
        if (notes.length < 40 || notes.length > 6000) return null;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        copyFileSync(this.paths.notes, join(this.paths.history, `${stamp}.md`));
        writeFileSync(this.paths.notes, `${notes}\n`);
        appendFileSync(join(this.paths.history, "changes.log"), `${stamp} ${flat(out.summary)}\n`);
        writeFileSync(join(this.paths.history, "at"), String(Date.now()));
        return out.summary;
    }

    private async material(kind: Kind, reg: Registry) {
        const all = await listing(Date.now() - (BEFORE[kind] + 1) * SPAN[kind] - 2 * DAY);
        const newest = all[0]?.at ?? Date.now();
        const from = newest - SPAN[kind];
        const now = all.filter(e => e.at > from);
        const before = all.filter(e => e.at <= from && e.at > from - BEFORE[kind] * SPAN[kind]);
        const threads = await pool(now, 8, e => thread(e.url));
        const unit = kind === "weekly" ? "week" : "day";
        const avg = (n: number) => (n / BEFORE[kind]).toFixed(1);
        const versus = (a: Map<string, number>, b: Map<string, number>, top: number) =>
            [...a]
                .sort((x, y) => y[1] - x[1])
                .slice(0, top)
                .map(([k, v]) => `${k || "(none)"} ${v} (${avg(b.get(k) ?? 0)})`)
                .join(", ");
        const gone = (xs: Entry[]) => xs.filter(e => e.state).length;
        const sizes = now.map((e, i) => ({ e, n: threads[i]?.comments.size ?? 0 }));
        const blocks: string[] = [];
        const ids = new Map<string, string>();
        now.forEach((e, i) => {
            const t = threads[i] as Thread | null;
            const p = reg.add({
                kind: "post",
                link: e.url,
                title: e.title,
                sub: e.sub,
                author: e.author,
                date: iso(e.at).slice(0, 10),
                score: e.score,
                state: e.state,
            });
            ids.set(e.url, p.id);
            const lines = [
                `[${p.id}] ${e.sub} · ${iso(e.at)} UTC · ${e.flair || "no flair"} · by ${e.author} · score ${e.score ?? "?"}${e.state ? ` · ${e.state}` : ""}`,
                `Title: ${e.title}`,
            ];
            if (t?.body) lines.push(`Text: ${trim(flat(t.body), 1200)}`);
            const shown = t ? walk(t.roots, 40) : [];
            for (const { c, depth } of shown) {
                const s = reg.add({
                    kind: "comment",
                    link: `${e.url}#${c.id}`,
                    title: e.title,
                    sub: e.sub,
                    author: c.author,
                    date: c.date,
                    score: c.score,
                    state: c.state,
                });
                lines.push(
                    `${"  ".repeat(Math.min(depth, 3) + 1)}[${s.id}] ${c.author} · score ${c.score ?? "?"}${c.state ? ` · ${c.state}` : ""}: ${trim(flat(c.text), 300)}`,
                );
            }
            if (t && t.comments.size > shown.length) lines.push(`  (${t.comments.size - shown.length} more comments)`);
            blocks.push(lines.join("\n"));
        });
        const previous = this.last(kind);
        const stats = [
            `Period: ${iso(from)} to ${iso(newest)} UTC.`,
            `Posts: ${now.length} (previous ${BEFORE[kind]} ${unit}s: ${avg(before.length)} per ${unit} on average).`,
            `Comments archived on these posts: ${sizes.reduce((a, x) => a + x.n, 0)}.`,
            `Deleted or removed posts: ${gone(now)} (previous: ${avg(gone(before))} per ${unit}).`,
            `By community, with the previous average in brackets: ${versus(
                count(now, e => e.sub),
                count(before, e => e.sub),
                8,
            )}.`,
            `By flair: ${versus(
                count(now, e => e.flair),
                count(before, e => e.flair),
                10,
            )}.`,
            `Busiest threads: ${[...sizes]
                .sort((a, b) => b.n - a.n)
                .slice(0, 5)
                .map(x => `[${ids.get(x.e.url)}] ${x.n} comments`)
                .join(", ")}.`,
        ];
        return {
            text: [
                `Statistics:\n${stats.join("\n")}`,
                previous ? `Your previous issue (${previous.edition}):\n${trim(previous.text, 3000)}` : "",
                `Posts and comments of the period, newest first:\n\n${blocks.join("\n\n")}`,
            ]
                .filter(Boolean)
                .join("\n\n"),
            posts: now.length,
            newest,
        };
    }

    async edition(kind: Kind): Promise<{ a: Answer; posts: number; edition: string }> {
        const reg = new Registry();
        const m = await this.material(kind, reg);
        const edition = day(Date.now());
        const task = `Write ${NAME[kind]} for ${edition}.`;
        const draft = await answer({ today: new Date().toISOString().slice(0, 10), target: { author: "editor", text: task }, material: m.text }, "digest", {
            system: SYSTEM(kind, this.notes()),
            registry: reg,
            maxTurns: 8,
            thinking: kind === "weekly" ? "medium" : "low",
        });
        const a = await refine(draft, { request: task, task: RESEARCH(kind) }).catch(e => {
            this.o.log({ digest: kind, refine: e instanceof Error ? e.message : String(e) });
            return draft;
        });
        return { a, posts: m.posts, edition };
    }

    private footer(kind: Kind, o: { unsubscribe?: string; member?: boolean } = {}): { md: string; mail: Footer } {
        const s = this.o.money.sponsors();
        const names = s.names.map(name).filter(Boolean);
        const hidden = s.hidden ? [`${s.hidden} anonymous ${s.hidden > 1 ? "supporters" : "supporter"}`] : [];
        const thanks = kind === "weekly" && (names.length || s.hidden) ? `Thanks to our sponsors: ${[...names, ...hidden].join(", ")}` : "";
        const url = this.o.about();
        const pitch = o.member || !url ? "" : `^(Subscribe, membership and commands:) ^[u/${this.o.bot}](${url})`;
        const md = [thanks && `^(${thanks.replace(/[()]/g, "")})`, pitch].filter(Boolean).join("  \n");
        const html = (t: string) => t.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
        return {
            md,
            mail: { text: thanks, html: thanks ? `<p style="margin:1.4em 0 0;font-size:.78em;color:#6b7078">${html(thanks)}</p>` : "" },
        };
    }

    async preview(kind: Kind, o: { member?: Standing } = {}) {
        const { a, posts, edition } = await charge(kind, () => this.edition(kind));
        const own = o.member ? await this.personal(a, o.member) : a;
        return {
            title: `${NAME[kind]} · ${edition}`,
            posts,
            markdown: forReddit(a, this.footer(kind).md),
            shared: site(a),
            own: site(own),
            footer: this.footer(kind, { member: Boolean(o.member) }).mail,
        };
    }

    private async personal(a: Answer, s: Standing) {
        const past = this.o.mailbox?.recent(s.email, 8) ?? [];
        if (!past.length) return a;
        const about = past
            .map(r => `- ${iso(r.at).slice(0, 10)}, they wrote: ${trim(flat(r.text), 400)} / you answered: ${trim(flat(r.reply), 300)}`)
            .join("\n");
        const text = await charge(s.tier === "owner" ? "owner" : `member:${s.email}`, () =>
            write(MODELS.main, { system: PERSONAL, prompt: `What the reader recently asked or told you:\n${about}\n\nThe issue:\n${a.text}`, thinking: "low" }),
        );
        return { ...a, text };
    }

    async run(kind: Kind, o: { dry?: boolean } = {}) {
        const mailbox = this.o.mailbox;
        const people =
            kind === "weekly" ? [...this.o.money.readers("weekly"), ...this.o.money.readers("daily").filter(p => !p.weekly)] : this.o.money.readers("daily");
        const readers = people.map(p => ({ p, s: this.o.money.standing(p.email) })).filter(x => kind === "weekly" || x.s);
        if (kind === "daily" && (!readers.length || !this.o.mail || o.dry)) return { kind, skipped: readers.length ? "mail off" : "no readers" };
        const { a, posts, edition } = await charge(kind, () => this.edition(kind));
        const title = `${NAME[kind]} · ${edition}`;
        const shown = site(a);
        const result: Record<string, unknown> = { kind, edition, posts, chars: shown.text.length, refs: shown.refs.length };
        if (kind === "weekly") {
            const markdown = forReddit(a, this.footer(kind).md);
            let post = "";
            let url = "";
            let status = "draft";
            let error: string | undefined;
            if (this.o.post && !o.dry) {
                try {
                    ({ name: post, url } = await reddit.submit(`u_${this.o.bot}`, title, markdown));
                    status = "posted";
                } catch (e) {
                    status = "failed";
                    error = e instanceof Error ? e.message : String(e);
                }
            }
            this.save({ kind, edition, title, text: shown.text, markdown, refs: shown.refs, post, url, status, error });
            Object.assign(result, { status, url, error });
        } else {
            this.save({ kind, edition, title, text: shown.text, refs: shown.refs, status: "draft" });
        }
        const send = this.o.mail && !o.dry && mailbox;
        let sent = 0;
        let failed = 0;
        for (const { p, s } of readers) {
            const link = `${this.o.api}/unsubscribe?t=${(p as Person).token}`;
            try {
                const own = send && s && (s.tier === "owner" || this.o.money.left(s) > 0) ? await this.personal(a, s).catch(() => a) : a;
                const view = site(own);
                if (send)
                    await mailbox.post(p.email, {
                        kind,
                        subject: title,
                        text: view.text,
                        refs: view.refs,
                        footer: this.footer(kind, { unsubscribe: link, member: Boolean(s) }).mail,
                        unsubscribe: link,
                        sig: this.o.status(p.email, link),
                    });
                if (s) this.save({ kind, edition, recipient: p.email, title, text: view.text, refs: view.refs, status: send ? "sent" : "draft" });
                sent += send ? 1 : 0;
            } catch (e) {
                failed += 1;
                this.o.log({ digest: kind, to: p.email, error: e instanceof Error ? e.message : String(e) });
            }
        }
        Object.assign(result, { readers: readers.length, sent, failed });
        return result;
    }
}
