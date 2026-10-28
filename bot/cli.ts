import { readFileSync } from "node:fs";
import { answer, reddit, site } from "./src/agent";

if (!process.env.GEMINI_API_KEY && process.env.GEMINI_KEY_FILE) process.env.GEMINI_API_KEY = readFileSync(process.env.GEMINI_KEY_FILE, "utf8").trim();

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "ask" || !rest.length) {
    console.error("usage: bun cli.ts ask <question> [--json]");
    process.exit(2);
}
const json = rest.includes("--json");
const question = rest.filter(x => x !== "--json").join(" ");
const a = await answer({ today: new Date().toISOString().slice(0, 10), target: { author: "a visitor", text: question } }, "ask", {
    onStep: s => console.error(s.type === "search" ? `search: ${s.query}` : s.type === "read" ? `read: ${s.title}` : `browse: ${s.url}`),
});
console.error(`(${a.turns} turns, ${a.model})`);
console.log(json ? JSON.stringify(site(a), null, 2) : reddit(a));
