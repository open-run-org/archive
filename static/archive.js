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
            const more = document.createElement("button");
            more.type = "button";
            more.className = "more";
            more.textContent = `${n} 条回复 / ${n} ${n > 1 ? "replies" : "reply"}`;
            c.prepend(fold);
            c.insertBefore(more, first);
            const set = open => {
                c.classList.toggle("folded", !open);
                fold.textContent = open ? "−" : "+";
                fold.setAttribute("aria-expanded", String(open));
                fold.setAttribute("aria-label", open ? "Collapse replies" : `Show ${n} replies`);
            };
            fold.addEventListener("click", () => set(c.classList.contains("folded")));
            more.addEventListener("click", () => set(true));
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
            for (const [mode, label] of [["top", "Top / 最热"], ["new", "New / 最新"]]) {
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
                const label = () => { toggle.textContent = open ? "Collapse all / 全部折叠" : "Expand all / 全部展开"; };
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
    if (search && window.PagefindUI) {
        const ui = new PagefindUI({ element: "#search", showSubResults: false, showImages: false });
        const q = new URLSearchParams(location.search).get("q");
        if (q) ui.triggerSearch(q);
    }
});
