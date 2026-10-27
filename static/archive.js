document.addEventListener("DOMContentLoaded", () => {
    const table = document.getElementById("archiveTable");
    if (!table) return;
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
    for (const th of table.querySelectorAll("th[data-sort]")) {
        th.addEventListener("click", () => {
            const col = th.cellIndex;
            const type = th.dataset.sort;
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
});
