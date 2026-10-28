import { search, words } from "./pagefind.js";

const ANCHOR = /^c-[a-z0-9]+$/;
const WINDOW = 160;
const pages = new Map();

export const decode = s =>
    s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&#x27;/g, "'")
        .replace(/&amp;/g, "&");

export const page = url => {
    if (!pages.has(url)) {
        pages.set(url, fetch(url).then(r => (r.ok ? r.text() : "")).catch(() => ""));
        if (pages.size > 300) pages.delete(pages.keys().next().value);
    }
    return pages.get(url);
};

export const commentMeta = (html, id) => {
    const i = html.search(new RegExp(`id="?${id}"?>`));
    if (i < 0) return null;
    const m = html.slice(i, i + 4000).match(/<div class="?meta"?>(.*?)<\/div>/s);
    if (!m) return null;
    const s = m[1];
    const score = s.match(/<span class="?score[^>]*>(?:<i>(.)<\/i>)?([^<]*)<\/span>/);
    const user = s.match(/class="?user[^>]*>([^<]*)<\/(?:a|b)>/);
    const tags = [...s.matchAll(/<span class="?tag ?([a-z]*)"?>([^<]*)<\/span>/g)].map(t => ({ kind: t[1], text: decode(t[2]) }));
    const when = s.match(/class="?when"?[^>]*>([^<]*)</);
    const n = score ? parseInt(score[2], 10) : NaN;
    return {
        author: user ? decode(user[1]) : "[deleted]",
        score: Number.isNaN(n) ? null : score[1] === "▼" ? -n : n,
        date: when ? when[1].slice(0, 10) : "",
        op: tags.some(t => t.kind === "op"),
        state: tags.find(t => t.kind === "state")?.text || "",
    };
};

const clip = (text, lo, hi, locs) => {
    let start = lo;
    let end = hi;
    if (hi - lo > WINDOW) {
        start = Math.max(lo, Math.min(locs[0] - Math.floor(WINDOW / 4), hi - WINDOW));
        end = start + WINDOW;
    }
    const body = decode(text.w.slice(start, end).join(text.j)).replace(/\s+/g, " ").trim();
    return (start > lo ? "…" : "") + body + (end < hi ? "…" : "");
};

const describe = async s => {
    const meta = s.d.meta || {};
    const base = {
        kind: s.kind,
        url: s.url,
        link: s.id ? `${s.url}#${s.id}` : s.url,
        title: decode(meta.title || ""),
        sub: (s.d.filters?.subreddit || [])[0] || "",
        text: clip(s.text, s.lo, s.hi, s.locs.sort((a, b) => a - b)),
    };
    if (s.kind === "post") {
        const n = parseInt(meta.score, 10);
        return { ...base, author: meta.author || "[deleted]", date: (meta.date || "").slice(0, 10), score: Number.isNaN(n) ? null : n, state: meta.state || "" };
    }
    const m = commentMeta(await page(s.url), s.id) || {};
    return { ...base, author: m.author || "[deleted]", date: m.date || "", score: m.score ?? null, state: m.state || "" };
};

export const retrieve = async (queries, { exclude = "", limit = 12, perQuery = 8, perPage = 3 } = {}) => {
    const found = new Map();
    const queue = [...new Set(queries.map(q => q.trim()).filter(Boolean))];
    for (let i = 0; i < queue.length && i < 16; i++) {
        const q = queue[i];
        const res = await search(q);
        const results = res?.results || [];
        if (results.length < 3) {
            for (const part of q.split(/\s+/)) if (part !== q && part.length > 1 && !queue.includes(part)) queue.push(part);
        }
        for (const r of results.slice(0, perQuery)) {
            const d = await r.data();
            if (exclude && d.url.includes(`-${exclude}/`)) continue;
            const text = words(d);
            const anchors = (d.anchors || []).slice().sort((a, b) => a.location - b.location);
            const cs = anchors.filter(a => ANCHOR.test(a.id));
            const body = anchors.find(a => a.id === "post-body");
            const first = cs.length ? cs[0].location : text.w.length;
            const total = (d.locations || []).length || 1;
            const add = (key, src, locs) => {
                const score = (r.score * locs.length) / total;
                const prev = found.get(key);
                if (prev) {
                    prev.score += score;
                    prev.locs = [...new Set([...prev.locs, ...locs])];
                } else {
                    found.set(key, { ...src, score, locs, d, text });
                }
            };
            const groups = new Map();
            const own = [];
            for (const l of d.locations || []) {
                let lo = 0;
                let hi = cs.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (cs[mid].location <= l) lo = mid + 1;
                    else hi = mid;
                }
                if (!lo) own.push(l);
                else groups.set(lo - 1, [...(groups.get(lo - 1) || []), l]);
            }
            if (own.length) add(d.url, { kind: "post", url: d.url, lo: body ? body.location : 0, hi: first }, own);
            const best = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, perPage);
            for (const [k, locs] of best) {
                const hi = k + 1 < cs.length ? cs[k + 1].location : text.w.length;
                add(`${d.url}#${cs[k].id}`, { kind: "comment", url: d.url, id: cs[k].id, lo: cs[k].location, hi }, locs);
            }
        }
    }
    const seen = new Set();
    const picked = [...found.values()]
        .sort((a, b) => b.score - a.score)
        .filter(s => {
            const key = s.kind === "post" ? `${s.d.meta?.author}|${s.d.meta?.title}` : `${s.url}#${s.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, limit);
    return (await Promise.all(picked.map(describe))).filter(s => s.text);
};
