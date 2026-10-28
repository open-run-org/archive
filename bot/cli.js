import { answer } from "./src/compose.js";
import { commentMeta, decode, page } from "./src/sources.js";

const plain = html => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const commentText = (html, at) => {
    const start = html.indexOf("</div>", at) + 6;
    const end = html.slice(start).search(/<div class="?c[ ">]|<\/div>/);
    return plain(html.slice(start, end < 0 ? undefined : start + end));
};

const fromArchive = async (url, cid) => {
    const html = await page(url);
    const bodyAt = html.indexOf("id=post-body>");
    const commentsAt = html.indexOf("<div class=comments");
    const ctx = {
        postId: url.match(/-([a-z0-9]+)\/?$/)?.[1],
        sub: plain(html.match(/<a class="?sub"?[^>]*>(.*?)<\/a>/s)?.[1] || ""),
        title: plain(html.match(/<h1 class="?post-title"?>(.*?)<\/h1>/s)?.[1] || ""),
        body: bodyAt < 0 ? "" : plain(html.slice(bodyAt + 13, commentsAt < 0 ? undefined : commentsAt)),
    };
    const author = decode(html.match(/data-pagefind-meta=author[^>]*>([^<]*)</)?.[1] || "[deleted]");
    if (!cid) return { ...ctx, target: { author, text: `${ctx.title}\n${ctx.body}` } };
    const at = html.search(new RegExp(`id="?c-${cid}"?>`));
    if (at < 0) throw new Error(`comment ${cid} not found`);
    const stack = [];
    for (const m of html.slice(commentsAt, at).matchAll(/<div\b[^>]*?(?:id="?(c-[a-z0-9]+))?"?>|<\/div>/g)) {
        if (m[0] === "</div>") stack.pop();
        else stack.push(m[1] || null);
    }
    const chain = stack.filter(Boolean).map(id => {
        const pos = html.search(new RegExp(`id="?${id}"?>`));
        return { author: commentMeta(html, id)?.author || "[deleted]", text: commentText(html, pos) };
    });
    return { ...ctx, chain, target: { author: commentMeta(html, `c-${cid}`)?.author || "[deleted]", text: commentText(html, at) } };
};

const [cmd, ...args] = process.argv.slice(2);
let ctx;
let mode;
if (cmd === "ask") {
    ctx = { target: { author: "a visitor of the archive website", text: args.join(" ") } };
    mode = "ask";
} else if (cmd === "thread") {
    ctx = await fromArchive(args[0], args[1]);
    mode = args[2] || "mention";
} else {
    console.error("usage: node cli.js ask <question> | thread <archive post url> [comment id] [mention|reply|random]");
    process.exit(2);
}
const out = await answer({ ...ctx, today: new Date().toISOString().slice(0, 10) }, mode);
console.log(`queries: ${out.queries.join(" | ")}`);
for (const [i, s] of out.sources.entries()) console.log(`[${i + 1}] ${s.kind} ${s.date} ${s.author} ${s.link}`);
console.log(`\n${out.reply}`);
