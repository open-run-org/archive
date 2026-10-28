document.addEventListener("DOMContentLoaded", () => {
    const table = document.getElementById("archiveTable");
    if (table) {
        const tbody = table.querySelector("tbody");
        const filter = document.getElementById("archiveFilter");
        if (filter) {
            filter.addEventListener("input", () => {
                const q = filter.value.toLowerCase();
                for (const row of tbody.rows) {
                    const title = row.cells[3].textContent.toLowerCase();
                    const author = row.cells[4] ? row.cells[4].textContent.toLowerCase() : "";
                    row.style.display = title.includes(q) || author.includes(q) ? "" : "none";
                }
            });
        }
        let dir = 1;
        for (const button of table.querySelectorAll("th button[data-sort]")) {
            button.addEventListener("click", () => {
                const col = button.closest("th").cellIndex;
                const type = button.dataset.sort;
                dir *= -1;
                const rows = Array.from(tbody.rows);
                rows.sort((a, b) => {
                    const x = a.cells[col].getAttribute("data-value");
                    const y = b.cells[col].getAttribute("data-value");
                    if (type === "number") return (parseFloat(x) - parseFloat(y)) * dir;
                    return x.localeCompare(y) * dir;
                });
                rows.forEach(row => tbody.appendChild(row));
            });
        }
    }

    const box = document.querySelector(".comments");
    if (box) {
        const all = Array.from(box.querySelectorAll(".c"));
        all.forEach((c, i) => {
            const when = c.querySelector(":scope > .meta .when");
            c.dataset.i = i;
            c.dataset.t = when ? Date.parse(when.textContent.replace(" UTC", "Z").replace(" ", "T")) || 0 : 0;
        });
        const setters = [];
        const openers = new Map();
        for (const c of all) {
            const first = c.querySelector(":scope > .c");
            if (!first) continue;
            const n = c.querySelectorAll(".c").length;
            const fold = document.createElement("button");
            fold.type = "button";
            fold.className = "fold";
            c.prepend(fold);
            const set = open => {
                c.classList.toggle("folded", !open);
                fold.textContent = open ? "−" : "+" + n;
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
            for (let p = target.parentElement.closest(".c"); p; p = p.parentElement.closest(".c")) openers.get(p)?.(true);
            target.scrollIntoView({ block: "center" });
        };
        window.addEventListener("hashchange", reveal);
        const head = box.querySelector(".comments-head");
        if (head && all.length > 1) {
            const bar = document.createElement("div");
            bar.className = "sort";
            const order = {
                top: (a, b) => a.dataset.i - b.dataset.i,
                new: (a, b) => b.dataset.t - a.dataset.t || a.dataset.i - b.dataset.i,
            };
            const modes = [];
            const apply = mode => {
                for (const group of [box, ...all]) {
                    const kids = Array.from(group.children).filter(e => e.classList.contains("c"));
                    if (kids.length > 1) kids.sort(order[mode]).forEach(k => group.appendChild(k));
                }
                for (const b of modes) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
            };
            for (const [mode, label] of [["top", "Top"], ["new", "New"]]) {
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
                const label = () => { toggle.textContent = open ? "Collapse all" : "Expand all"; };
                toggle.addEventListener("click", () => {
                    open = !open;
                    setters.forEach(set => set(open));
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

    const mofufu = document.getElementById("mofufu");
    if (mofufu) runMofufu(mofufu);
});

const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
};

const hueOf = async name => {
    const b = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(name.toLowerCase())));
    return ((b[0] << 16) | (b[1] << 8) | b[2]) % 360;
};

const userLink = async name => {
    const a = el("a", "user", name);
    a.href = "/search/?user=" + encodeURIComponent(name);
    a.style.setProperty("--h", await hueOf(name));
    a.dataset.i = (name.match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
    return a;
};

const words = d => {
    const raw = d.raw_content ?? (d.content || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const zws = raw.includes("​");
    return { w: zws ? raw.split("​") : raw.split(/[\r\n\s]+/g), j: zws ? "" : " " };
};

const snip = (d, text, lo, hi, locs, len = 32) => {
    const rank = new Map((d.weighted_locations || []).map(x => [x.location, x.balanced_score]));
    const best = locs.reduce((a, b) => ((rank.get(b) || 0) > (rank.get(a) || 0) ? b : a));
    const start = Math.max(lo, Math.min(best - Math.floor(len / 3), hi - len));
    const end = Math.min(hi, start + len);
    const hits = new Set(locs);
    const body = text.w.slice(start, end).map((x, i) => (hits.has(start + i) ? `<mark>${x}</mark>` : x)).join(text.j).trim();
    return (start > lo ? "…" : "") + body + (end < hi ? "…" : "");
};

const textOf = c => {
    const own = Array.from(c.children).filter(e => !e.matches(".meta, .c, .fold"));
    const t = own.map(e => e.textContent.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
    if (t) return t;
    if (own.some(e => e.matches("video") || e.querySelector("video"))) return "Video";
    return own.some(e => e.matches("img") || e.querySelector("img")) ? "Image" : "";
};

const markdown = (text, refs) => {
    const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const inline = s =>
        esc(s)
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/(?:\[\d+\])+/g, group => {
                const links = [...group.matchAll(/\[(\d+)\]/g)]
                    .map(([, n]) => refs[Number(n) - 1] && `<a href="${esc(refs[Number(n) - 1].link)}" title="${esc(refs[Number(n) - 1].title)}">${n}</a>`)
                    .filter(Boolean);
                return links.length ? `<sup>${links.join(",")}</sup>` : group;
            });
    const out = [];
    let para = [];
    let list = null;
    const flush = () => {
        if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
        if (list) out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ""}>${list.items.map(i => `<li>${i}</li>`).join("")}</${list.tag}>`);
        para = [];
        list = null;
    };
    for (const line of text.split("\n")) {
        const item = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/);
        if (!line.trim()) flush();
        else if (item) {
            const tag = item[1] ? "ul" : "ol";
            if (para.length || (list && list.tag !== tag)) flush();
            list = list || { tag, start: Number(item[2]) || 1, items: [] };
            list.items.push(inline(item[3]));
        } else {
            if (list) flush();
            para.push(inline(line.trim()));
        }
    }
    flush();
    return out.join("");
};

async function runSearch(root) {
    const params = new URLSearchParams(location.search);
    const q = (params.get("q") || "").trim();
    const user = (params.get("user") || "").trim();
    let sub = params.get("sub") || "";
    const modes = q ? [["top", "Relevance"], ["hot", "Hot"], ["new", "New"]] : [["hot", "Hot"], ["new", "New"]];
    let mode = modes.some(([m]) => m === params.get("sort")) ? params.get("sort") : modes[0][0];
    const input = document.querySelector(".search input");
    if (input && q) input.value = q;
    const head = root.querySelector(".page-head");
    const subs = root.querySelector(".subs");
    const sorter = root.querySelector(".sort");
    const status = root.querySelector(".status");
    const list = root.querySelector(".hits");
    const more = root.querySelector(".more");
    if (!q && !user) {
        status.textContent = "Search posts and users.";
        return;
    }
    if (q.length >= 3 && /[A-Za-z0-9]/.test(q)) {
        const names = await fetch(root.dataset.users).then(r => r.json()).catch(() => []);
        const key = q.toLowerCase().replace(/^\/?u\//, "");
        const rank = n => {
            const l = n.toLowerCase();
            return l === key ? 0 : l.startsWith(key) ? 1 : l.includes(key) ? 2 : 3;
        };
        const hits = names.map(n => [rank(n), n]).filter(([r]) => r < 3).sort((a, b) => a[0] - b[0] || a[1].length - b[1].length).slice(0, 12);
        const people = root.querySelector(".people");
        for (const [, n] of hits) people.appendChild(await userLink(n));
        people.hidden = !hits.length;
    }
    if (q && root.dataset.mofufu) {
        const ask = el("a", "pill ask-link", "Ask Mofufu");
        ask.href = `${root.dataset.mofufu}?q=${encodeURIComponent(q)}`;
        sorter.prepend(ask);
    }
    if (user) {
        const h1 = el("h1");
        h1.appendChild(await userLink(user));
        const out = el("a", "pill", "Reddit ↗");
        out.href = "https://www.reddit.com/user/" + encodeURIComponent(user);
        out.target = "_blank";
        out.rel = "noopener";
        head.append(h1, out);
        head.hidden = false;
    }
    const pagefind = await import(root.dataset.pagefind);
    const base = {};
    if (user) base.any = [{ author: user }, { user: user }];
    const sorts = { hot: { hot: "desc" }, new: { date: "desc" } };
    let results = [], shown = 0;
    const pages = new Map();
    const load = url => {
        if (!pages.has(url)) {
            pages.set(url, fetch(url).then(r => (r.ok ? r.text() : "")).then(t => (t ? new DOMParser().parseFromString(t, "text/html") : null)).catch(() => null));
        }
        return pages.get(url);
    };
    const metaOf = (c, url) => {
        const src = c && c.querySelector(":scope > .meta");
        const m = src ? src.cloneNode(true) : el("div", "meta");
        const w = m.querySelector(".when");
        if (w) {
            const a = el("a", "when", w.textContent.slice(0, 10));
            a.href = url + "#" + c.id;
            a.title = w.textContent;
            w.replaceWith(a);
        }
        if (!q) m.querySelector(".user")?.remove();
        return m;
    };
    const replies = async (d, li, text, cs) => {
        let items = [];
        if (q) {
            const groups = new Map();
            for (const l of d.locations || []) {
                let lo = 0, hi = cs.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (cs[mid].location <= l) lo = mid + 1;
                    else hi = mid;
                }
                if (!lo) continue;
                if (!groups.has(lo - 1)) groups.set(lo - 1, []);
                groups.get(lo - 1).push(l);
            }
            items = Array.from(groups).sort((a, b) => a[0] - b[0]).map(([k, locs]) => ({
                id: cs[k].id,
                html: snip(d, text, cs[k].location, k + 1 < cs.length ? cs[k + 1].location : text.w.length, locs),
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
            a.href = d.url + "#" + it.id;
            if (it.html !== undefined) a.innerHTML = it.html;
            else a.textContent = it.text;
            r.append(it.el ? metaOf(it.el, d.url) : el("div", "meta"), a);
            return r;
        });
        const ol = el("ol", "replies");
        ol.append(...rows.slice(0, 3));
        li.appendChild(ol);
        if (rows.length > 3) {
            const n = rows.length - 3;
            const b = el("button", "pill more-replies", "+" + n);
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
                const c = doc.getElementById(items[i].id);
                if (c) r.firstChild.replaceWith(metaOf(c, d.url));
            });
        }
    };
    const sync = () => {
        const p = new URLSearchParams();
        if (q) p.set("q", q);
        if (user) p.set("user", user);
        if (sub) p.set("sub", sub);
        if (mode !== modes[0][0]) p.set("sort", mode);
        history.replaceState(null, "", "?" + p.toString());
    };
    const page = async () => {
        const batch = await Promise.all(results.slice(shown, shown + 20).map(r => r.data()));
        for (const d of batch) list.appendChild(await hit(d));
        shown += batch.length;
        more.hidden = shown >= results.length;
    };
    const hit = async d => {
        const li = el("li", "hit");
        const t = el("a", "t", d.meta.title || d.url);
        t.href = d.url;
        const meta = el("div", "meta");
        const n = parseInt(d.meta.score, 10);
        if (!Number.isNaN(n)) {
            const s = el("span", "score" + (n > 0 ? " up" : n < 0 ? " down" : ""));
            s.append(el("i", "", n < 0 ? "▼" : "▲"), String(Math.abs(n)));
            meta.appendChild(s);
        }
        const author = d.meta.author;
        if (author && author !== "[deleted]") meta.appendChild(await userLink(author));
        else meta.appendChild(el("b", "user gone", "[deleted]"));
        const label = (d.filters.subreddit || [])[0];
        if (label) {
            const a = el("a", "tag", label);
            a.href = "/r_" + label.slice(2) + "/";
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
            const hi = cs.length ? cs[0].location : text.w.length;
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
        sync();
        const sort = sorts[mode];
        const all = await pagefind.search(q || null, { filters: { ...base, subreddit: { any: root.dataset.subs.split(",") } }, sort });
        const res = sub ? await pagefind.search(q || null, { filters: { ...base, subreddit: sub }, sort }) : all;
        results = res ? res.results : [];
        const counts = (all && all.filters && all.filters.subreddit) || {};
        subs.replaceChildren();
        const total = all ? all.results.length : 0;
        for (const [name, count] of [["", total], ...Object.entries(counts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])]) {
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

const STORE = "mofufu";
const LOCK = "mofufu-lock";
const VISITOR = "mofufu-visitor";

const visitorId = () => {
    try {
        let id = localStorage.getItem(VISITOR);
        if (!id) {
            id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
            localStorage.setItem(VISITOR, id);
        }
        return id;
    } catch {
        return null;
    }
};

const about = (thread, turn) => ({
    visitor: visitorId(),
    thread,
    turn,
    page: location.href,
    referrer: document.referrer || null,
    screen: `${screen.width}x${screen.height}`,
    viewport: `${innerWidth}x${innerHeight}`,
    dpr: devicePixelRatio,
    languages: navigator.languages ? [...navigator.languages] : [navigator.language],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: new Date().getTimezoneOffset(),
    platform: navigator.userAgentData?.platform || navigator.platform || null,
    mobile: navigator.userAgentData?.mobile ?? null,
    cores: navigator.hardwareConcurrency || null,
    memory: navigator.deviceMemory || null,
    touch: navigator.maxTouchPoints || 0,
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    threads: load().threads.length,
});

const load = () => {
    try {
        const v = JSON.parse(localStorage.getItem(STORE) || "null");
        if (v && Array.isArray(v.threads)) return v;
    } catch {}
    return { threads: [], current: null };
};

const store = v => {
    try {
        localStorage.setItem(STORE, JSON.stringify({ ...v, threads: v.threads.slice(0, 50) }));
    } catch {}
};

const clock = seconds => {
    const pad = n => String(n).padStart(2, "0");
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds / 60) % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(seconds % 60)}` : `${m}:${pad(seconds % 60)}`;
};

const stamp = at => {
    const d = new Date(at);
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const stepText = s =>
    s.type === "search" ? `Searching “${s.query}”` : s.type === "read" ? `Reading “${s.title}”` : `Opening ${s.url.replace(/^https?:\/\/(www\.)?/, "")}`;

const stepSummary = steps => {
    const n = { search: 0, read: 0, browse: 0 };
    for (const s of steps || []) n[s.type] = (n[s.type] || 0) + 1;
    return [
        n.search && `${n.search} ${n.search > 1 ? "searches" : "search"}`,
        n.read && `${n.read} read`,
        n.browse && `${n.browse} ${n.browse > 1 ? "pages" : "page"} opened`,
    ]
        .filter(Boolean)
        .join(" · ");
};

const chip = (name, hue, initial, cls = "") => {
    const c = el("span", `user ${cls}`.trim(), name);
    c.dataset.i = initial;
    c.style.setProperty("--h", hue);
    return c;
};

function runMofufu(root) {
    const api = (root.dataset.api || "").replace(/\/$/, "");
    const chat = root.querySelector(".chat");
    const list = root.querySelector(".chats");
    const past = root.querySelector(".past");
    const form = root.querySelector("form.ask");
    const input = form.querySelector("textarea");
    const send = form.querySelector("button");
    const note = form.querySelector(".status");
    let state = load();
    let busy = false;
    let holding = 0;
    let span = 0;
    let ticking = 0;

    const thread = () => state.threads.find(t => t.id === state.current) || null;

    const message = (m, live) => {
        const c = el("div", `c msg ${m.role}`);
        const meta = el("div", "meta");
        meta.append(m.role === "you" ? chip("You", 210, "Y", "you") : chip("Mofufu", 330, "M", "mofufu"));
        if (m.role === "mofufu" && m.steps?.length && !live) meta.append(el("span", "steps", stepSummary(m.steps)));
        meta.append(el("span", "when", stamp(m.at)));
        c.append(meta);
        if (live) {
            const ol = el("ol", "live");
            ol.append(el("li", "", "Looking through the archive…"));
            c.append(ol);
            return c;
        }
        if (m.error) {
            c.append(el("p", "error", m.error));
            return c;
        }
        const body = el("div", "body");
        if (m.role === "mofufu") body.innerHTML = markdown(m.text, m.refs || []);
        else for (const line of m.text.split(/\n{2,}/)) body.append(el("p", "", line));
        c.append(body);
        if (m.refs?.length) {
            const refs = el("ol", "refs");
            for (const r of m.refs) {
                const li = el("li");
                const a = el("a", "", r.title || r.link);
                a.href = r.link;
                li.append(a, el("span", "muted", r.kind === "web" ? " · web page" : ` · ${r.kind} by ${r.author}${r.date ? ` · ${r.date}` : ""}${r.state ? ` · ${r.state}` : ""}`));
                refs.append(li);
            }
            c.append(refs);
        }
        return c;
    };

    const render = () => {
        const t = thread();
        chat.replaceChildren();
        input.placeholder = t ? "Reply to Mofufu" : "Ask Mofufu";
        past.hidden = !state.threads.length;
        past.textContent = `History ${state.threads.length}`;
        if (!t) return;
        const [first, ...rest] = t.messages;
        const head = el("header", "post-head");
        head.append(el("h1", "post-title", t.title));
        const by = el("div", "byline");
        by.append(chip("You", 210, "Y", "you"), el("span", "when", stamp(first.at)));
        head.append(by);
        chat.append(head);
        if (first.text.trim() !== t.title.trim()) {
            const body = el("div", "post-content");
            for (const line of first.text.split(/\n{2,}/)) body.append(el("p", "", line));
            chat.append(body);
        }
        if (rest.length) {
            const box = el("div", "comments");
            for (const m of rest) box.append(message(m));
            chat.append(box);
        }
    };

    const renderList = () => {
        list.replaceChildren();
        for (const t of state.threads) {
            const li = el("li", t.id === state.current ? "current" : "");
            const open = el("a", "t", t.title);
            open.href = "#";
            open.addEventListener("click", e => {
                e.preventDefault();
                state.current = t.id;
                store(state);
                list.hidden = true;
                past.setAttribute("aria-expanded", "false");
                render();
                renderList();
            });
            const drop = el("button", "drop", "×");
            drop.type = "button";
            drop.title = "Delete this chat";
            drop.setAttribute("aria-label", "Delete this chat");
            drop.addEventListener("click", () => {
                state.threads = state.threads.filter(x => x.id !== t.id);
                if (state.current === t.id) state.current = null;
                store(state);
                render();
                renderList();
                if (!state.threads.length) list.hidden = true;
            });
            li.append(open, el("span", "muted", `${Math.ceil(t.messages.length / 2)} · ${stamp(t.updated).slice(0, 10)}`), drop);
            list.append(li);
        }
    };

    const settle = () => {
        const waiting = holding > Date.now();
        form.dataset.state = busy ? "busy" : waiting ? "wait" : "";
        send.disabled = busy || waiting;
        if (!waiting) note.textContent = "";
    };

    const paint = () => {
        const left = holding - Date.now();
        if (left <= 0) {
            clearInterval(ticking);
            holding = 0;
            delete form.dataset.lock;
            form.style.removeProperty("--lock");
            form.style.removeProperty("--from");
            settle();
            return;
        }
        if (form.dataset.lock === undefined) {
            form.style.setProperty("--lock", `${left}ms`);
            form.style.setProperty("--from", String(Math.min(1, left / (span * 1000 || left))));
            form.dataset.lock = "";
        }
        form.querySelector("button .wait").dataset.clock = clock(Math.ceil(left / 1000));
        note.textContent = "Mofufu can take another question when the countdown ends.";
        settle();
    };

    const lock = (until, total) => {
        if (!until || until <= Date.now()) return;
        delete form.dataset.lock;
        void form.offsetWidth;
        holding = until;
        span = total;
        try {
            localStorage.setItem(LOCK, JSON.stringify({ until, span: total }));
        } catch {}
        clearInterval(ticking);
        paint();
        ticking = setInterval(paint, 250);
    };

    const ask = async text => {
        const now = Date.now();
        let t = thread();
        if (!t) {
            t = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: text.split("\n")[0].slice(0, 120), created: now, updated: now, messages: [] };
            state.threads.unshift(t);
            state.current = t.id;
        }
        const history = t.messages.filter(m => !m.error).map(m => ({ role: m.role === "you" ? "visitor" : "you", text: m.text }));
        t.messages.push({ role: "you", text, at: now });
        t.updated = now;
        state.threads = [t, ...state.threads.filter(x => x.id !== t.id)];
        store(state);
        render();
        renderList();
        const pending = message({ role: "mofufu", at: Date.now() }, true);
        let comments = chat.querySelector(".comments");
        if (!comments) {
            comments = el("div", "comments");
            chat.append(comments);
        }
        comments.append(pending);
        pending.scrollIntoView({ block: "nearest", behavior: "smooth" });
        const live = pending.querySelector(".live");
        const steps = [];
        busy = true;
        settle();
        let reply = null;
        try {
            const res = await fetch(`${api}/ask`, {
                method: "POST",
                headers: { "content-type": "text/plain" },
                body: JSON.stringify({ q: text, history, client: about(t.id, t.messages.length - 1) }),
            });
            if (res.status === 429) {
                const info = await res.json().catch(() => ({}));
                lock(info.until, info.span);
                throw new Error("Mofufu needs a break. Ask again when the countdown ends.");
            }
            if (!res.ok || !res.body) {
                const info = await res.json().catch(() => ({}));
                throw new Error(info.error || `Mofufu is unavailable (HTTP ${res.status}).`);
            }
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let cut = buf.indexOf("\n\n");
                while (cut >= 0) {
                    const chunk = buf.slice(0, cut).replace(/^data: /, "");
                    buf = buf.slice(cut + 2);
                    cut = buf.indexOf("\n\n");
                    if (!chunk) continue;
                    const e = JSON.parse(chunk);
                    if (e.type === "limit") lock(e.until, e.span);
                    else if (e.type === "step") {
                        if (!steps.length) live.replaceChildren();
                        steps.push(e.step);
                        live.append(el("li", "", stepText(e.step)));
                    } else if (e.type === "answer") reply = { role: "mofufu", text: e.text, refs: e.refs, steps, at: Date.now() };
                    else if (e.type === "error") throw new Error(e.message);
                }
            }
            if (!reply) throw new Error("Mofufu did not finish this time.");
        } catch (err) {
            reply = { role: "mofufu", error: err.message || "Mofufu could not answer this time.", at: Date.now() };
        }
        t.messages.push(reply);
        t.updated = Date.now();
        store(state);
        busy = false;
        render();
        renderList();
        settle();
        chat.querySelector(".comments > .c:last-child")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };

    root.querySelector(".new").addEventListener("click", () => {
        state.current = null;
        store(state);
        render();
        renderList();
        input.focus();
    });
    past.addEventListener("click", () => {
        list.hidden = !list.hidden;
        past.setAttribute("aria-expanded", String(!list.hidden));
    });
    form.addEventListener("submit", e => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text || busy || holding > Date.now()) return;
        input.value = "";
        ask(text);
    });
    input.addEventListener("keydown", e => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit();
    });
    window.addEventListener("storage", e => {
        if (e.key === STORE && !busy) {
            state = load();
            render();
            renderList();
        }
    });

    const q = new URLSearchParams(location.search).get("q");
    if (q) {
        state.current = null;
        input.value = q;
        history.replaceState(null, "", location.pathname);
    }
    render();
    renderList();
    try {
        const saved = JSON.parse(localStorage.getItem(LOCK) || "null");
        if (saved && saved.until > Date.now()) lock(saved.until, saved.span);
    } catch {}
    if (api) {
        fetch(`${api}/limit`)
            .then(r => (r.ok ? r.json() : null))
            .then(info => info?.until && lock(info.until, info.span))
            .catch(() => {});
    }
    settle();
    input.focus();
}
