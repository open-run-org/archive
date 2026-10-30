type Fragment = {
    url: string;
    content?: string;
    raw_content?: string;
    meta: Record<string, string | undefined>;
    filters: Record<string, string[] | undefined>;
    locations?: number[];
    weighted_locations?: { location: number; balanced_score: number }[];
    anchors?: { id: string; location: number }[];
};
type Search = { results: { data(): Promise<Fragment> }[]; filters?: Record<string, Record<string, number>> };
type Pagefind = { search(q: string | null, o: Record<string, unknown>): Promise<Search | null> };
type Words = { w: string[]; j: string };
type Item = { id: string; html?: string; el?: Element; text?: string };

document.addEventListener("click", e => {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (a instanceof HTMLAnchorElement && /^https?:$/.test(a.protocol) && a.host !== location.host) {
        a.target = "_blank";
        a.relList.add("noopener");
    }
});

document.addEventListener("DOMContentLoaded", () => {
    const table = document.getElementById("archiveTable") as HTMLTableElement | null;
    if (table) {
        const tbody = table.querySelector("tbody")!;
        const filter = document.getElementById("archiveFilter") as HTMLInputElement | null;
        if (filter) {
            filter.addEventListener("input", () => {
                const q = filter.value.toLowerCase();
                for (const row of tbody.rows) {
                    const title = row.cells[3]!.textContent!.toLowerCase();
                    const author = row.cells[4] ? row.cells[4].textContent!.toLowerCase() : "";
                    row.style.display = title.includes(q) || author.includes(q) ? "" : "none";
                }
            });
        }
        let dir = 1;
        for (const button of table.querySelectorAll<HTMLButtonElement>("th button[data-sort]")) {
            button.addEventListener("click", () => {
                const col = button.closest("th")!.cellIndex;
                const type = button.dataset.sort;
                dir *= -1;
                const rows = Array.from(tbody.rows);
                rows.sort((a, b) => {
                    const x = a.cells[col]!.getAttribute("data-value")!;
                    const y = b.cells[col]!.getAttribute("data-value")!;
                    if (type === "number") return (parseFloat(x) - parseFloat(y)) * dir;
                    return x.localeCompare(y) * dir;
                });
                for (const row of rows) tbody.appendChild(row);
            });
        }
    }

    const box = document.querySelector<HTMLElement>(".comments");
    if (box) {
        const all = Array.from(box.querySelectorAll<HTMLElement>(".c"));
        all.forEach((c, i) => {
            const when = c.querySelector(":scope > .meta .when");
            c.dataset.i = String(i);
            c.dataset.t = String(when ? Date.parse(when.textContent!.replace(" UTC", "Z").replace(" ", "T")) || 0 : 0);
        });
        const setters: ((open: boolean) => void)[] = [];
        const openers = new Map<Element, (open: boolean) => void>();
        for (const c of all) {
            const first = c.querySelector(":scope > .c");
            if (!first) continue;
            const n = c.querySelectorAll(".c").length;
            const fold = document.createElement("button");
            fold.type = "button";
            fold.className = "fold";
            c.prepend(fold);
            const set = (open: boolean) => {
                c.classList.toggle("folded", !open);
                fold.textContent = open ? "−" : `+${n}`;
                fold.setAttribute("aria-expanded", String(open));
                fold.setAttribute("aria-label", open ? "Collapse replies" : `Show ${n} replies`);
                fold.title = open ? "Collapse" : `${n} ${n > 1 ? "replies" : "reply"}`;
            };
            fold.addEventListener("click", () => set(c.classList.contains("folded")));
            set(false);
            setters.push(set);
            openers.set(c, set);
        }
        const reveal = () => {
            const target = /^#c-[a-z0-9]+$/.test(location.hash) && document.getElementById(location.hash.slice(1));
            if (!target || !box.contains(target)) return;
            for (let p = target.parentElement!.closest(".c"); p; p = p.parentElement!.closest(".c")) openers.get(p)?.(true);
            target.scrollIntoView({ block: "center" });
        };
        window.addEventListener("hashchange", reveal);
        const head = box.querySelector(".comments-head");
        if (head && all.length > 1) {
            const bar = document.createElement("div");
            bar.className = "sort";
            const order: Record<string, (a: HTMLElement, b: HTMLElement) => number> = {
                top: (a, b) => Number(a.dataset.i) - Number(b.dataset.i),
                new: (a, b) => Number(b.dataset.t) - Number(a.dataset.t) || Number(a.dataset.i) - Number(b.dataset.i),
            };
            const modes: HTMLButtonElement[] = [];
            const apply = (mode: string) => {
                for (const group of [box, ...all]) {
                    const kids = Array.from(group.children as HTMLCollectionOf<HTMLElement>).filter(e => e.classList.contains("c"));
                    if (kids.length > 1) for (const k of kids.sort(order[mode])) group.appendChild(k);
                }
                for (const b of modes) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
            };
            for (const [mode, label] of [
                ["top", "Top"],
                ["new", "New"],
            ] as const) {
                const b = document.createElement("button");
                b.type = "button";
                b.dataset.mode = mode;
                b.textContent = label;
                b.addEventListener("click", () => apply(mode));
                bar.appendChild(b);
                modes.push(b);
            }
            if (setters.length) {
                let open = false;
                const toggle = document.createElement("button");
                toggle.type = "button";
                toggle.className = "all";
                const label = () => {
                    toggle.textContent = open ? "Collapse all" : "Expand all";
                };
                toggle.addEventListener("click", () => {
                    open = !open;
                    for (const set of setters) set(open);
                    label();
                });
                label();
                bar.appendChild(toggle);
            }
            head.appendChild(bar);
            apply("top");
        }
        reveal();
    }

    const search = document.getElementById("search");
    if (search) runSearch(search);
});

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
};

const hueOf = async (name: string) => {
    const b = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(name.toLowerCase())));
    return ((b[0]! << 16) | (b[1]! << 8) | b[2]!) % 360;
};

const userLink = async (name: string) => {
    const a = el("a", "user", name);
    a.href = `/search/?user=${encodeURIComponent(name)}`;
    a.style.setProperty("--h", String(await hueOf(name)));
    a.dataset.i = (name.match(/[A-Za-z0-9]/) || ["?"])[0]!.toUpperCase();
    return a;
};

const words = (d: Fragment): Words => {
    const raw = d.raw_content ?? (d.content || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const zws = raw.includes("​");
    return { w: zws ? raw.split("​") : raw.split(/[\r\n\s]+/g), j: zws ? "" : " " };
};

const snip = (d: Fragment, text: Words, lo: number, hi: number, locs: number[], len = 32) => {
    const rank = new Map((d.weighted_locations || []).map(x => [x.location, x.balanced_score]));
    const best = locs.reduce((a, b) => ((rank.get(b) || 0) > (rank.get(a) || 0) ? b : a));
    const start = Math.max(lo, Math.min(best - Math.floor(len / 3), hi - len));
    const end = Math.min(hi, start + len);
    const hits = new Set(locs);
    const body = text.w
        .slice(start, end)
        .map((x, i) => (hits.has(start + i) ? `<mark>${x}</mark>` : x))
        .join(text.j)
        .trim();
    return (start > lo ? "…" : "") + body + (end < hi ? "…" : "");
};

const textOf = (c: Element) => {
    const own = Array.from(c.children).filter(e => !e.matches(".meta, .c, .fold"));
    const t = own
        .map(e => e.textContent!.trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ");
    if (t) return t;
    if (own.some(e => e.matches("video") || e.querySelector("video"))) return "Video";
    return own.some(e => e.matches("img") || e.querySelector("img")) ? "Image" : "";
};

async function runSearch(root: HTMLElement) {
    const params = new URLSearchParams(location.search);
    const q = (params.get("q") || "").trim();
    const user = (params.get("user") || "").trim();
    let sub = params.get("sub") || "";
    const modes: [string, string][] = q
        ? [
              ["top", "Relevance"],
              ["hot", "Hot"],
              ["new", "New"],
          ]
        : [
              ["hot", "Hot"],
              ["new", "New"],
          ];
    let mode = modes.some(([m]) => m === params.get("sort")) ? params.get("sort")! : modes[0]![0];
    const input = document.querySelector<HTMLInputElement>(".search input");
    if (input && q) input.value = q;
    const head = root.querySelector<HTMLElement>(".page-head")!;
    const subs = root.querySelector(".subs")!;
    const sorter = root.querySelector(".sort")!;
    const status = root.querySelector(".status")!;
    const list = root.querySelector(".hits")!;
    const more = root.querySelector<HTMLElement>(".more")!;
    if (!q && !user) {
        status.textContent = "Search posts and users.";
        return;
    }
    if (q.length >= 3 && /[A-Za-z0-9]/.test(q)) {
        const names: string[] = await fetch(root.dataset.users!)
            .then(r => r.json())
            .catch(() => []);
        const key = q.toLowerCase().replace(/^\/?u\//, "");
        const rank = (n: string) => {
            const l = n.toLowerCase();
            return l === key ? 0 : l.startsWith(key) ? 1 : l.includes(key) ? 2 : 3;
        };
        const hits = names
            .map(n => [rank(n), n] as const)
            .filter(([r]) => r < 3)
            .sort((a, b) => a[0] - b[0] || a[1].length - b[1].length)
            .slice(0, 12);
        const people = root.querySelector<HTMLElement>(".people")!;
        for (const [, n] of hits) people.appendChild(await userLink(n));
        people.hidden = !hits.length;
    }
    if (user) {
        const h1 = el("h1");
        h1.appendChild(await userLink(user));
        const out = el("a", "pill", "Reddit ↗");
        out.href = `https://www.reddit.com/user/${encodeURIComponent(user)}`;
        out.target = "_blank";
        out.rel = "noopener";
        head.append(h1, out);
        head.hidden = false;
    }
    const pagefind = (await import(root.dataset.pagefind!).catch(() => null)) as Pagefind | null;
    if (!pagefind) {
        status.textContent = "Search is unavailable.";
        return;
    }
    const base: Record<string, unknown> = {};
    if (user) base.any = [{ author: user }, { user: user }];
    const sorts: Record<string, Record<string, string>> = { hot: { hot: "desc" }, new: { date: "desc" } };
    let results: Search["results"] = [],
        shown = 0,
        gen = 0;
    const pages = new Map<string, Promise<Document | null>>();
    const load = (url: string) => {
        if (!pages.has(url)) {
            pages.set(
                url,
                fetch(url)
                    .then(r => (r.ok ? r.text() : ""))
                    .then(t => (t ? new DOMParser().parseFromString(t, "text/html") : null))
                    .catch(() => null),
            );
        }
        return pages.get(url)!;
    };
    const metaOf = (c: Element, url: string) => {
        const src = c?.querySelector(":scope > .meta");
        const m = src ? (src.cloneNode(true) as HTMLElement) : el("div", "meta");
        const w = m.querySelector(".when");
        if (w) {
            const a = el("a", "when", w.textContent!.slice(0, 10));
            a.href = `${url}#${c.id}`;
            a.title = w.textContent!;
            w.replaceWith(a);
        }
        if (!q) m.querySelector(".user")?.remove();
        return m;
    };
    const replies = async (d: Fragment, li: HTMLElement, text: Words, cs: { id: string; location: number }[]) => {
        let items: Item[] = [];
        if (q) {
            const groups = new Map<number, number[]>();
            for (const l of d.locations || []) {
                let lo = 0,
                    hi = cs.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (cs[mid]!.location <= l) lo = mid + 1;
                    else hi = mid;
                }
                if (!lo) continue;
                if (!groups.has(lo - 1)) groups.set(lo - 1, []);
                groups.get(lo - 1)!.push(l);
            }
            items = Array.from(groups)
                .sort((a, b) => a[0] - b[0])
                .map(([k, locs]) => ({
                    id: cs[k]!.id,
                    html: snip(d, text, cs[k]!.location, k + 1 < cs.length ? cs[k + 1]!.location : text.w.length, locs),
                }));
        } else {
            const doc = await load(d.url);
            if (!doc) return;
            const key = user.toLowerCase();
            items = Array.from(doc.querySelectorAll(".c[id]"))
                .filter(c => (c.querySelector(":scope > .meta .user")?.textContent || "").toLowerCase() === key)
                .map(c => ({ id: c.id, el: c, text: textOf(c) }));
        }
        if (!items.length) return;
        const rows = items.map(it => {
            const r = el("li", "reply");
            const a = el("a", "excerpt");
            a.href = `${d.url}#${it.id}`;
            if (it.html !== undefined) a.innerHTML = it.html;
            else a.textContent = it.text!;
            r.append(it.el ? metaOf(it.el, d.url) : el("div", "meta"), a);
            return r;
        });
        const ol = el("ol", "replies");
        ol.append(...rows.slice(0, 3));
        li.appendChild(ol);
        if (rows.length > 3) {
            const n = rows.length - 3;
            const b = el("button", "pill more-replies", `+${n}`);
            b.type = "button";
            b.setAttribute("aria-label", `Show ${n} more comments`);
            b.addEventListener("click", () => {
                ol.append(...rows.slice(3));
                b.remove();
            });
            li.appendChild(b);
        }
        if (q) {
            const doc = await load(d.url);
            if (!doc) return;
            rows.forEach((r, i) => {
                const c = doc.getElementById(items[i]!.id);
                if (c) r.firstChild!.replaceWith(metaOf(c, d.url));
            });
        }
    };
    const sync = () => {
        const p = new URLSearchParams();
        if (q) p.set("q", q);
        if (user) p.set("user", user);
        if (sub) p.set("sub", sub);
        if (mode !== modes[0]![0]) p.set("sort", mode);
        history.replaceState(null, "", `?${p.toString()}`);
    };
    const page = async () => {
        const mine = results,
            from = shown;
        shown = Math.min(mine.length, from + 20);
        more.hidden = true;
        const batch = await Promise.all(mine.slice(from, shown).map(r => r.data()));
        const hits = await Promise.all(batch.map(hit));
        if (mine !== results) return;
        list.append(...hits);
        more.hidden = shown >= mine.length;
    };
    const hit = async (d: Fragment) => {
        const li = el("li", "hit");
        const t = el("a", "t", d.meta.title || d.url);
        t.href = d.url;
        const meta = el("div", "meta");
        const n = parseInt(d.meta.score!, 10);
        if (!Number.isNaN(n)) {
            const s = el("span", `score${n > 0 ? " up" : n < 0 ? " down" : ""}`);
            s.append(el("i", "", n < 0 ? "▼" : "▲"), String(Math.abs(n)));
            meta.appendChild(s);
        }
        const author = d.meta.author;
        if (author && author !== "[deleted]") meta.appendChild(await userLink(author));
        else meta.appendChild(el("b", "user gone", "[deleted]"));
        const label = (d.filters.subreddit || [])[0];
        if (label) {
            const a = el("a", "tag", label);
            a.href = `/r_${label.slice(2)}/`;
            meta.appendChild(a);
        }
        if (user && author === user) meta.appendChild(el("span", "tag op", "OP"));
        if (d.meta.flair) meta.appendChild(el("span", "tag", d.meta.flair));
        if (d.meta.state) meta.appendChild(el("span", "tag state", d.meta.state));
        if (d.meta.date) meta.appendChild(el("span", "when", d.meta.date.slice(0, 10)));
        li.append(t, meta);
        const text = words(d);
        const anchors = (d.anchors || []).slice().sort((a, b) => a.location - b.location);
        const cs = anchors.filter(a => /^c-[a-z0-9]+$/.test(a.id));
        if (q) {
            const body = anchors.find(a => a.id === "post-body");
            const lo = body ? body.location : 0;
            const hi = cs.length ? cs[0]!.location : text.w.length;
            const own = (d.locations || []).filter(l => l >= lo && l < hi);
            if (own.length) {
                const ex = el("p", "excerpt");
                ex.innerHTML = snip(d, text, lo, hi, own);
                li.appendChild(ex);
            }
        }
        replies(d, li, text, cs);
        return li;
    };
    const run = async () => {
        const g = ++gen;
        sync();
        const sort = sorts[mode];
        let all: Search | null, res: Search | null;
        try {
            all = await pagefind.search(q || null, { filters: { ...base, subreddit: { any: root.dataset.subs!.split(",") } }, sort });
            res = sub ? await pagefind.search(q || null, { filters: { ...base, subreddit: sub }, sort }) : all;
        } catch {
            if (g === gen) status.textContent = "Search is unavailable.";
            return;
        }
        if (g !== gen) return;
        results = res ? res.results : [];
        const counts = all?.filters?.subreddit || {};
        subs.replaceChildren();
        const total = all ? all.results.length : 0;
        for (const [name, count] of [
            ["", total] as [string, number],
            ...Object.entries(counts)
                .filter(([, c]) => c > 0)
                .sort((a, b) => b[1] - a[1]),
        ]) {
            const a = el("a", sub === name ? "current" : "");
            a.href = "#";
            a.append(name || "All", " ", el("span", "muted", count.toLocaleString("en")));
            a.addEventListener("click", e => {
                e.preventDefault();
                sub = name;
                run();
            });
            subs.appendChild(a);
        }
        status.textContent = results.length ? "" : "No posts.";
        list.replaceChildren();
        shown = 0;
        await page();
    };
    for (const [m, label] of modes) {
        const b = el("button", "", label);
        b.type = "button";
        b.addEventListener("click", () => {
            mode = m;
            for (const x of sorter.children) x.setAttribute("aria-pressed", String(x === b));
            run();
        });
        b.setAttribute("aria-pressed", String(m === mode));
        sorter.appendChild(b);
    }
    more.addEventListener("click", page);
    await run();
}
