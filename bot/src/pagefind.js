import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SITE = (process.env.ARCHIVE_URL || "https://archive.open-run.org").replace(/\/$/, "");
const TTL = 3 * 3600 * 1000;
let current = null;

const load = async () => {
    const r = await fetch(`${SITE}/pagefind/pagefind.js`);
    if (!r.ok) throw new Error(`pagefind.js: HTTP ${r.status}`);
    const file = join(tmpdir(), `archive-bot-pagefind-${process.pid}-${Date.now()}.mjs`);
    await writeFile(file, await r.text());
    try {
        const pf = await import(pathToFileURL(file).href);
        await pf.options({ basePath: `${SITE}/pagefind/`, baseUrl: `${SITE}/` });
        return { pf, at: Date.now() };
    } finally {
        await unlink(file).catch(() => {});
    }
};

export const pagefind = async (fresh = false) => {
    if (fresh || !current || Date.now() - current.at > TTL) current = await load();
    return current.pf;
};

export const search = async (query, opts = {}) => {
    try {
        return await (await pagefind()).search(query, opts);
    } catch {
        return await (await pagefind(true)).search(query, opts);
    }
};

export const words = d => {
    const raw = d.raw_content ?? d.content ?? "";
    const zws = raw.includes("​");
    return { w: zws ? raw.split("​") : raw.split(/[\r\n\s]+/g), j: zws ? "" : " " };
};
