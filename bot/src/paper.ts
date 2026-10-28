import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "./archive";
import { reserved } from "./limit";
import type { Ref } from "./mail";

const TECTONIC = process.env.TECTONIC || "tectonic";
const FONTS = (process.env.PAPER_FONTS || "/fonts").replace(/\/$/, "");

export type Doc = {
    name: string;
    edition: string;
    text: string;
    refs: Ref[];
    keywords?: string;
    from?: string;
    to?: string;
    number?: number;
    total?: number;
    link?: string;
    thanks?: string;
};

const PICTO = /\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu;

const esc = (s: string) =>
    s
        .replace(/`([^`\n]+)`/g, "$1")
        .replace(PICTO, "")
        .replace(/\s*·\s*/g, "\uE001")
        .replace(
            /[\\{}$&#^_%~]/g,
            c =>
                ({
                    "\\": "\\textbackslash{}",
                    "{": "\\{",
                    "}": "\\}",
                    $: "\\$",
                    "&": "\\&",
                    "#": "\\#",
                    "^": "\\textasciicircum{}",
                    _: "\\_",
                    "%": "\\%",
                    "~": "\\textasciitilde{}",
                })[c] ?? c,
        )
        .replace(/\uE001/g, "\\enspace\\textperiodcentered\\enspace{}");

const link = (u: string) => {
    let s = u.replace(/[{}\\\s]/g, "");
    try {
        s = encodeURI(decodeURI(s));
    } catch {}
    return s.replace(/[%#]/g, c => `\\${c}`);
};

const inline = (s: string) =>
    esc(s)
        .replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}")
        .replace(/(?:\[\d+\])+/g, group => `\\cite{${[...group.matchAll(/\[(\d+)\]/g)].map(([, n]) => `r${n}`).join(",")}}`);

const blocks = (text: string) => {
    const out: string[] = [];
    let para: string[] = [];
    let list: { env: string; items: string[] } | null = null;
    const flush = () => {
        if (para.length) out.push(`${para.join("\n")}\n`);
        if (list)
            out.push(`\\begin{${list.env}}[leftmargin=2em,itemsep=.15em,topsep=.3em]\n${list.items.map(i => `\\item ${i}`).join("\n")}\n\\end{${list.env}}\n`);
        para = [];
        list = null;
    };
    for (const line of text.split("\n")) {
        const head = line.match(/^\s*(#{1,4})\s+(.*)$/);
        const item = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/);
        if (head) {
            flush();
            out.push(`\\${(head[1] ?? "").length > 2 ? "subsection" : "section"}{${inline((head[2] ?? "").replace(/^\d+(\.\d+)*\s+/, ""))}}\n`);
        } else if (!line.trim()) flush();
        else if (item) {
            const env = item[1] ? "itemize" : "enumerate";
            if (para.length || (list && list.env !== env)) flush();
            list ??= { env, items: [] };
            list.items.push(inline(item[3] ?? ""));
        } else {
            if (list) flush();
            para.push(inline(line.trim()));
        }
    }
    flush();
    return out.join("\n");
};

const host = (u: string) => {
    try {
        return new URL(u).hostname.replace(/^www\./, "");
    } catch {
        return u;
    }
};

const safe = async (u: string) => {
    let url: URL;
    try {
        url = new URL(u);
    } catch {
        return false;
    }
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    const found = await lookup(url.hostname, { all: true }).catch(() => []);
    return found.length > 0 && found.every(a => !reserved(a.address));
};

const get = async (u: string, hops = 3): Promise<Response | null> => {
    if (!(await safe(u))) return null;
    const r = await fetch(u, {
        redirect: "manual",
        signal: AbortSignal.timeout(6000),
        headers: { "user-agent": "Mozilla/5.0 (compatible; Mofufu)", accept: "text/html" },
    });
    if (r.status < 300 || r.status >= 400) return r;
    const next = r.headers.get("location");
    return next && hops > 0 ? get(new URL(next, u).toString(), hops - 1) : null;
};

const pages = new Map<string, Promise<{ title?: string; site?: string }>>();

const page = (u: string) => {
    let p = pages.get(u);
    if (!p) {
        p = get(u)
            .then(async r => {
                if (!r?.ok || !/html/.test(r.headers.get("content-type") ?? "")) return {};
                const html = (await r.text()).slice(0, 300_000);
                const meta = (k: string) =>
                    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']+)`, "i"))?.[1] ??
                    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${k}["']`, "i"))?.[1];
                const clean = (s?: string) => (s ? decode(s).replace(/\s+/g, " ").trim().slice(0, 160) : undefined);
                return { title: clean(meta("og:title") ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]), site: clean(meta("og:site_name")) };
            })
            .catch(() => ({}));
        pages.set(u, p);
        if (pages.size > 2000) pages.delete(pages.keys().next().value as string);
    }
    return p;
};

const NOTE: Record<string, string> = {
    Deleted: "原帖已被作者删除，引自红迪档案馆存档",
    Removed: "原帖已被版主移除，引自红迪档案馆存档",
    Gone: "原帖已不可见，引自红迪档案馆存档",
};

export const bibliography = async (refs: Ref[], accessed: string) =>
    Promise.all(
        refs.map(async r => {
            const sub = r.sub ? `Reddit ${r.sub}` : "Reddit";
            const note = NOTE[r.state] ? ` ${NOTE[r.state]}.` : "";
            if (r.kind === "post") return { n: r.n, text: `${r.author}. ${r.title}[EB/OL]. ${sub}, (${r.date})[${accessed}]. `, url: r.link, note };
            if (r.kind === "comment")
                return { n: r.n, text: `${r.author}. 对《${r.title}》的评论[EB/OL]. ${sub}, (${r.date})[${accessed}]. `, url: r.link, note };
            const p = await page(r.link);
            const site = p.site || host(r.link);
            const title = p.title && p.title !== site ? p.title : r.title && r.title !== host(r.link) && r.title !== site ? r.title : "";
            return { n: r.n, text: `${site}${title ? `. ${title}` : ""}[EB/OL]. [${accessed}]. `, url: r.link, note: "" };
        }),
    );

const split = (text: string) => {
    const parts = text.trim().split(/\n(?=\s*#{1,4}\s)/);
    const lead = parts.length > 1 && !/^\s*#/.test(parts[0] ?? "") ? (parts.shift() ?? "") : "";
    return { lead: lead.replace(/\s*(?:\[\d+\])+/g, "").trim(), rest: parts.join("\n") };
};

const issue = (d: Doc) => (d.number ? `${d.edition.slice(0, 4)} 年第 ${d.number} 期${d.total ? `（总第 ${d.total} 期）` : ""}` : d.edition);

const cite = (d: Doc) => `Mofufu. ${d.name} ${issue(d).replace(/（.*）/, "")}[J/OL]. 红迪档案馆, ${d.edition}[${d.edition}].${d.link ? ` ${d.link}.` : ""}`;

export const tex = async (d: Doc) => {
    const { lead, rest } = split(d.text);
    const bib = await bibliography(d.refs, d.edition);
    const font = (name: string) => `{${name}}[Path=${FONTS}/, Extension=.otf, UprightFont=*-Regular, BoldFont=*-Bold]`;
    const field = (label: string, body: string) => `\\noindent{\\sffamily\\bfseries ${label}}{\\zihao{-5}${body}}\\par`;
    return `\\documentclass[UTF8,a4paper,fontset=none,zihao=5]{ctexart}
\\usepackage[top=2.6cm,bottom=2.4cm,left=2.5cm,right=2.5cm,headsep=.7cm]{geometry}
\\setmainfont{texgyretermes}[Extension=.otf,UprightFont=*-regular,BoldFont=*-bold,ItalicFont=*-italic,BoldItalicFont=*-bolditalic]
\\setsansfont{texgyreheros}[Extension=.otf,UprightFont=*-regular,BoldFont=*-bold]
\\setCJKmainfont${font("NotoSerifCJKsc")}
\\setCJKsansfont${font("NotoSansCJKsc")}
\\setCJKmonofont${font("NotoSerifCJKsc")}
\\usepackage[super,square,comma,sort&compress]{natbib}
\\setlength{\\bibsep}{.25em}
\\usepackage{enumitem}
\\usepackage{xcolor}
\\definecolor{link}{HTML}{1A4F8B}
\\usepackage{fancyhdr}
\\usepackage{hyperref}
\\usepackage{xurl}
\\urlstyle{same}
\\hypersetup{colorlinks=true,linkcolor=link,citecolor=link,urlcolor=link,pdftitle={${esc(d.name)} ${esc(issue(d))}},pdfauthor={Mofufu},pdfkeywords={${esc(d.keywords ?? "")}}}
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[L]{\\zihao{-5}\\sffamily ${esc(d.name)}\\quad ${esc(issue(d))}}
\\fancyhead[R]{\\zihao{-5}\\sffamily 红迪档案馆}
\\fancyfoot[C]{\\zihao{-5}\\thepage}
\\renewcommand{\\headrulewidth}{0.4pt}
\\linespread{1.3}
\\setlength{\\emergencystretch}{2em}
\\ctexset{section={format=\\sffamily\\bfseries\\zihao{4}\\raggedright,beforeskip=1.1em,afterskip=.5em},subsection={format=\\sffamily\\bfseries\\zihao{-4}\\raggedright},bibname={参考文献}}
\\begin{document}
\\thispagestyle{plain}
\\begin{center}
{\\sffamily\\bfseries\\zihao{2}${esc(d.name)}}\\par\\vspace{.7em}
{\\zihao{4}${esc(issue(d))}}\\par\\vspace{.5em}
{\\zihao{5}Mofufu}\\par\\vspace{.2em}
{\\zihao{-5}（红迪档案馆，\\href{https://archive.open-run.org}{archive.open-run.org}）}\\par\\vspace{.2em}
{\\zihao{-5}${d.from && d.to ? `统计时段：${esc(d.from)} 至 ${esc(d.to)}\\qquad ` : ""}发布日期：${esc(d.edition)}}
\\end{center}
\\vspace{.6em}
${lead ? field("摘\\quad 要：", inline(lead)) : ""}
${d.keywords ? field("关键词：", esc(d.keywords)) : ""}
${field("引用格式：", esc(cite(d)))}
\\vspace{.4em}\\noindent\\rule{\\textwidth}{0.4pt}\\vspace{.4em}
${blocks(rest || d.text)}
${
    bib.length
        ? `{\\zihao{-5}\\sloppy\\emergencystretch=3em
\\begin{thebibliography}{${bib.length}}
${bib.map(b => `\\bibitem{r${b.n}} ${esc(b.text)}\\url{${link(b.url)}}.${esc(b.note)}`).join("\n")}
\\end{thebibliography}}`
        : ""
}
\\vfill
{\\zihao{-5}\\color{gray}${d.thanks ? `${esc(d.thanks)}\\par ` : ""}I am a bot with sources linking to \\href{https://archive.open-run.org}{archive.open-run.org}\\enspace\\textperiodcentered\\enspace\\href{https://clarelab.moe}{clareLab.moe}\\enspace\\textperiodcentered\\enspace\\href{https://ko-fi.com/clarelab}{ko-fi.com/clareLab}\\par}
\\end{document}
`;
};

export const markdown = async (d: Doc) => {
    const { lead: raw, rest: body } = split(d.text);
    const lead = raw.replace(/`([^`\n]+)`/g, "$1");
    let n = 0;
    const rest = body.replace(/`([^`\n]+)`/g, "$1").replace(/^##\s+(?:\d+(?:\.\d+)*\s+)?(.*)$/gm, (_, t: string) => `## ${++n} ${t}`);
    const bib = await bibliography(d.refs, d.edition);
    return [
        `# ${d.name} ${issue(d)}`,
        [
            "- 作者：Mofufu（红迪档案馆，archive.open-run.org）",
            d.from && d.to ? `- 统计时段：${d.from} 至 ${d.to}` : "",
            `- 发布日期：${d.edition}`,
            `- 引用格式：${cite(d)}`,
        ]
            .filter(Boolean)
            .join("\n"),
        lead ? `**摘要**：${lead}` : "",
        d.keywords ? `**关键词**：${d.keywords}` : "",
        rest || d.text,
        bib.length ? `## 参考文献\n\n${bib.map(b => `[${b.n}] ${b.text}${b.url}.${b.note}`).join("\n\n")}` : "",
        d.thanks ?? "",
        "I am a bot with sources linking to [archive.open-run.org](https://archive.open-run.org) · [clareLab.moe](https://clarelab.moe) · [ko-fi.com/clareLab](https://ko-fi.com/clarelab)",
    ]
        .filter(Boolean)
        .join("\n\n");
};

export const pdf = async (source: string) => {
    const dir = await mkdtemp(join(tmpdir(), "paper-"));
    try {
        await writeFile(join(dir, "paper.tex"), source);
        const p = Bun.spawn([TECTONIC, "-X", "compile", "paper.tex"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
        const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
        if (code !== 0) throw new Error(`tectonic exited ${code}: ${err.slice(-600)}`);
        return new Uint8Array(await readFile(join(dir, "paper.pdf")));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};
