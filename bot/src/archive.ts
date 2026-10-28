import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SITE = (process.env.ARCHIVE_URL || "https://archive.open-run.org").replace(/\/$/, "");

type Fragment = {
    url: string;
    raw_content?: string;
    content?: string;
    meta: Record<string, string>;
    filters?: Record<string, string[]>;
    anchors?: { id: string; location: number }[];
    locations?: number[];
};
type Result = { score: number; data(): Promise<Fragment> };
type Pagefind = {
    options(o: Record<string, unknown>): Promise<void>;
    search(q: string | null, o?: Record<string, unknown>): Promise<{ results: Result[] } | null>;
    filters(): Promise<Record<string, Record<string, number>>>;
};

let current: { pf: Pagefind; at: number } | null = null;

const load = async () => {
    const r = await fetch(`${SITE}/pagefind/pagefind.js`);
    if (!r.ok) throw new Error(`pagefind.js: HTTP ${r.status}`);
    const file = join(tmpdir(), `archive-bot-pagefind-${process.pid}-${Date.now()}.mjs`);
    await Bun.write(file, await r.text());
    try {
        const pf = (await import(file)) as Pagefind;
        await pf.options({ basePath: `${SITE}/pagefind/`, baseUrl: `${SITE}/` });
        return { pf, at: Date.now() };
    } finally {
        await unlink(file).catch(() => {});
    }
};

const find = async (q: string | null, o: Record<string, unknown>) => {
    if (!current || Date.now() - current.at > 3 * 3600_000) current = await load();
    try {
        return await current.pf.search(q, o);
    } catch {
        current = await load();
        return await current.pf.search(q, o);
    }
};

export type Entry = { url: string; title: string; sub: string; author: string; at: number; score: number | null; state: string; flair: string };

export const listing = async (since: number): Promise<Entry[]> => {
    try {
        return await list(since);
    } catch {
        current = await load();
        return await list(since);
    }
};

const list = async (since: number): Promise<Entry[]> => {
    if (!current || Date.now() - current.at > 3 * 3600_000) current = await load();
    const subs = Object.keys((await current.pf.filters()).subreddit ?? {});
    const res = await find(null, { filters: { subreddit: { any: subs } }, sort: { date: "desc" } });
    const results = res?.results ?? [];
    const out: Entry[] = [];
    for (let i = 0; i < results.length; i += 16) {
        const batch = await Promise.all(results.slice(i, i + 16).map(r => r.data()));
        let older = false;
        for (const d of batch) {
            const at = Date.parse((d.meta.date ?? "").replace(/ UTC$/, "Z").replace(" ", "T"));
            if (!at) continue;
            if (at < since) {
                older = true;
                continue;
            }
            const n = Number.parseInt(d.meta.score ?? "", 10);
            out.push({
                url: d.url,
                title: decode(d.meta.title ?? ""),
                sub: d.filters?.subreddit?.[0] ?? "",
                author: d.meta.author || "[deleted]",
                at,
                score: Number.isNaN(n) ? null : n,
                state: d.meta.state ?? "",
                flair: decode(d.meta.flair ?? ""),
            });
        }
        if (older) break;
    }
    return out;
};

export const decode = (s: string) =>
    s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&#x27;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&amp;/g, "&");

const plain = (html: string) =>
    decode(html.replace(/<(br|\/p|\/li|\/h\d|\/blockquote|\/pre|\/figure)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "))
        .replace(/[ \t ]+/g, " ")
        .replace(/ *\n[\s]*/g, "\n")
        .trim();

export const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export type Meta = { author: string; score: number | null; date: string; state: string; op: boolean };

const meta = (html: string): Meta => {
    const score = html.match(/<span class="?score[^>]*>(?:<i>(.)<\/i>)?([^<]*)<\/span>/);
    const n = score ? Number.parseInt(score[2] ?? "", 10) : Number.NaN;
    const user = html.match(/class="?user[^>]*>([^<]*)<\/(?:a|b)>/);
    const tags = [...html.matchAll(/<span class="?tag ?([a-z]*)"?[^>]*>([^<]*)<\/span>/g)];
    return {
        author: user ? decode(user[1] ?? "") : "[deleted]",
        score: Number.isNaN(n) ? null : score?.[1] === "▼" ? -n : n,
        date: (html.match(/class="?when"?[^>]*>(?:<time[^>]*>)?([^<]*)</)?.[1] ?? "").slice(0, 10),
        state: tags.find(t => t[1] === "state")?.[2] ?? "",
        op: tags.some(t => t[1] === "op"),
    };
};

export type Comment = Meta & { id: string; text: string; kids: Comment[]; parent: Comment | null };
export type Thread = Meta & {
    url: string;
    title: string;
    sub: string;
    flair: string;
    body: string;
    roots: Comment[];
    comments: Map<string, Comment>;
};

export const parse = (url: string, html: string): Thread => {
    const head = html.match(/<div class="?byline"?[^>]*>(.*?)<\/div>/s)?.[1] ?? "";
    const start = html.indexOf("<div class=comments");
    const bodyAt = html.search(/id="?post-body"?>/);
    const thread: Thread = {
        ...meta(head),
        url,
        title: decode(html.match(/<h1 class="?post-title"?>(.*?)<\/h1>/s)?.[1]?.replace(/<[^>]+>/g, "") ?? ""),
        sub: decode(html.match(/<a class="?sub"?[^>]*>([^<]*)<\/a>/)?.[1] ?? ""),
        flair: decode(head.match(/data-pagefind-meta="?flair"?>([^<]*)</)?.[1] ?? ""),
        date: head.match(/<time[^>]*>([^<]*)</)?.[1]?.slice(0, 10) ?? "",
        body: bodyAt < 0 ? "" : plain(html.slice(html.indexOf(">", bodyAt) + 1, start < 0 ? html.indexOf("</article>") : start)),
        roots: [],
        comments: new Map(),
    };
    if (start < 0) return thread;
    const stack: { node: Comment | null; open: number }[] = [];
    const tag = /<div\b([^>]*)>|<\/div>/g;
    tag.lastIndex = start;
    const spans: { node: Comment; open: number; close: number }[] = [];
    for (let m = tag.exec(html); m; m = tag.exec(html)) {
        if (m[0] === "</div>") {
            const top = stack.pop();
            if (top?.node) spans.push({ node: top.node, open: top.open, close: m.index });
            if (!stack.length) break;
            continue;
        }
        const id = /\bclass="?c(?: folded)?"?(?:\s|$)/.test(`${m[1]} `) ? m[1]?.match(/\bid="?(c-[a-z0-9]+)/)?.[1] : undefined;
        if (!id) {
            stack.push({ node: null, open: m.index + m[0].length });
            continue;
        }
        const parent = [...stack].reverse().find(s => s.node)?.node ?? null;
        const node: Comment = { id, author: "[deleted]", score: null, date: "", state: "", op: false, text: "", kids: [], parent };
        (parent ? parent.kids : thread.roots).push(node);
        thread.comments.set(id, node);
        stack.push({ node, open: m.index + m[0].length });
    }
    for (const { node, open, close } of spans) {
        const inner = html.slice(open, close);
        const metaEnd = inner.indexOf("</div>");
        if (inner.startsWith("<div class=meta>") || inner.startsWith('<div class="meta">')) Object.assign(node, meta(inner.slice(0, metaEnd)));
        const rest = inner.slice(metaEnd + 6);
        const child = rest.search(/<div class="?c[ ">]/);
        node.text = plain(child < 0 ? rest : rest.slice(0, child));
    }
    return thread;
};

const threads = new Map<string, Promise<Thread | null>>();

export const thread = (url: string) => {
    let t = threads.get(url);
    if (!t) {
        t = fetch(url)
            .then(async r => (r.ok ? parse(url, await r.text()) : null))
            .catch(() => null);
        threads.set(url, t);
        if (threads.size > 300) threads.delete(threads.keys().next().value as string);
    }
    return t;
};

export type Hit = Meta & { kind: "post" | "comment"; url: string; link: string; title: string; sub: string; text: string; weight: number };

const WINDOW = 160;

const words = (d: Fragment) => {
    const raw = d.raw_content ?? d.content ?? "";
    const zws = raw.includes("​");
    return { w: zws ? raw.split("​") : raw.split(/[\r\n\s]+/g), j: zws ? "" : " " };
};

const clip = (text: { w: string[]; j: string }, lo: number, hi: number, locs: number[]) => {
    let start = lo;
    let end = hi;
    if (hi - lo > WINDOW) {
        start = Math.max(lo, Math.min((locs[0] ?? lo) - Math.floor(WINDOW / 4), hi - WINDOW));
        end = start + WINDOW;
    }
    const body = decode(text.w.slice(start, end).join(text.j)).replace(/\s+/g, " ").trim();
    return (start > lo ? "…" : "") + body + (end < hi ? "…" : "");
};

export const search = async (query: string, o: { sort?: "new" | "hot"; pages?: number; exclude?: string } = {}): Promise<Hit[]> => {
    const sort = o.sort === "new" ? { date: "desc" } : o.sort === "hot" ? { hot: "desc" } : undefined;
    const res = await find(query, sort ? { sort } : {});
    const hits: Hit[] = [];
    for (const r of (res?.results ?? []).slice(0, o.pages ?? 6)) {
        const d = await r.data();
        if (o.exclude && d.url.includes(`-${o.exclude}/`)) continue;
        const text = words(d);
        const anchors = (d.anchors ?? []).slice().sort((a, b) => a.location - b.location);
        const cs = anchors.filter(a => /^c-[a-z0-9]+$/.test(a.id));
        const bodyAt = anchors.find(a => a.id === "post-body")?.location ?? 0;
        const first = cs[0]?.location ?? text.w.length;
        const own: number[] = [];
        const groups = new Map<number, number[]>();
        for (const l of d.locations ?? []) {
            let lo = 0;
            let hi = cs.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if ((cs[mid]?.location ?? 0) <= l) lo = mid + 1;
                else hi = mid;
            }
            if (!lo) own.push(l);
            else groups.set(lo - 1, [...(groups.get(lo - 1) ?? []), l]);
        }
        const total = (d.locations ?? []).length || 1;
        const base = { url: d.url, title: decode(d.meta.title ?? ""), sub: d.filters?.subreddit?.[0] ?? "" };
        if (own.length) {
            const n = Number.parseInt(d.meta.score ?? "", 10);
            hits.push({
                ...base,
                kind: "post",
                link: d.url,
                text: clip(text, bodyAt, first, own),
                author: d.meta.author || "[deleted]",
                score: Number.isNaN(n) ? null : n,
                date: (d.meta.date ?? "").slice(0, 10),
                state: d.meta.state ?? "",
                op: false,
                weight: (r.score * own.length) / total,
            });
        }
        const best = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 2);
        if (!best.length) continue;
        const t = await thread(d.url);
        for (const [k, locs] of best) {
            const a = cs[k];
            if (!a) continue;
            const c = t?.comments.get(a.id);
            hits.push({
                ...base,
                kind: "comment",
                link: `${d.url}#${a.id}`,
                text: clip(text, a.location, cs[k + 1]?.location ?? text.w.length, locs),
                author: c?.author ?? "[deleted]",
                score: c?.score ?? null,
                date: c?.date ?? "",
                state: c?.state ?? "",
                op: c?.op ?? false,
                weight: (r.score * locs.length) / total,
            });
        }
    }
    return hits.filter(h => h.text);
};
