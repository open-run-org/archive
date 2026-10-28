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
        }
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
    }

    const search = document.getElementById("search");
    if (search) runSearch(search);
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

async function runSearch(root) {
    const params = new URLSearchParams(location.search);
    const q = (params.get("q") || "").trim();
    const user = (params.get("user") || "").trim();
    let sub = params.get("sub") || "";
    let mode = params.get("sort") || (q ? "top" : "new");
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
    await pagefind.options({ excerptLength: 30 });
    const base = {};
    if (user) base.any = [{ author: user }, { user: user }];
    let results = [], shown = 0;
    const sync = () => {
        const p = new URLSearchParams();
        if (q) p.set("q", q);
        if (user) p.set("user", user);
        if (sub) p.set("sub", sub);
        if (q && mode !== "top") p.set("sort", mode);
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
        if (user) meta.appendChild(el("span", "tag" + (author === user ? " op" : ""), author === user ? "OP" : "commented"));
        if (d.meta.flair) meta.appendChild(el("span", "tag", d.meta.flair));
        if (d.meta.state) meta.appendChild(el("span", "tag state", d.meta.state));
        if (d.meta.date) meta.appendChild(el("span", "when", d.meta.date.slice(0, 10)));
        li.append(t, meta);
        if (q && d.excerpt) {
            const ex = el("p", "excerpt");
            ex.innerHTML = d.excerpt.replace(/<(?!\/?mark>)/g, "&lt;");
            li.appendChild(ex);
        }
        return li;
    };
    const run = async () => {
        sync();
        const sort = mode === "new" ? { date: "desc" } : undefined;
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
    if (q) {
        for (const [m, label] of [["top", "Relevance"], ["new", "New"]]) {
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
    }
    more.addEventListener("click", page);
    await run();
}
