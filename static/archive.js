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

    for (const c of document.querySelectorAll(".comments .c")) {
        const replies = c.querySelectorAll(".c").length;
        const head = c.querySelector(":scope > p");
        if (!replies || !head) continue;
        let depth = 0;
        for (let p = c.parentElement.closest(".c"); p; p = p.parentElement.closest(".c")) depth++;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "fold";
        const set = open => {
            c.classList.toggle("folded", !open);
            button.textContent = open ? "−" : "+" + replies;
            button.setAttribute("aria-expanded", String(open));
        };
        button.addEventListener("click", () => set(c.classList.contains("folded")));
        head.prepend(button);
        set(depth < 5);
    }

    const box = document.querySelector(".comments");
    const title = box && box.querySelector(".comments-title");
    if (title && box.querySelectorAll(".c").length > 1) {
        const bar = document.createElement("div");
        bar.className = "sort";
        const order = {
            top: (a, b) => b.dataset.s - a.dataset.s || a.dataset.t - b.dataset.t,
            new: (a, b) => b.dataset.t - a.dataset.t,
        };
        const apply = mode => {
            for (const group of [box, ...box.querySelectorAll(".c")]) {
                const kids = Array.from(group.children).filter(e => e.classList.contains("c"));
                if (kids.length > 1) kids.sort(order[mode]).forEach(k => group.appendChild(k));
            }
            for (const b of bar.children) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
        };
        for (const [mode, label] of [["top", "Top / 最热"], ["new", "New / 最新"]]) {
            const b = document.createElement("button");
            b.type = "button";
            b.dataset.mode = mode;
            b.textContent = label;
            b.addEventListener("click", () => apply(mode));
            bar.appendChild(b);
        }
        title.after(bar);
        apply("top");
    }

    const search = document.getElementById("search");
    if (search && window.PagefindUI) {
        const ui = new PagefindUI({ element: "#search", showSubResults: false, showImages: false });
        const q = new URLSearchParams(location.search).get("q");
        if (q) ui.triggerSearch(q);
    }
});
