import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ref } from "./mail";

const TECTONIC = process.env.TECTONIC || "tectonic";
const FONTS = (process.env.PAPER_FONTS || "/fonts").replace(/\/$/, "");

const PICTO = /\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu;

const esc = (s: string) =>
    s
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

const link = (u: string) => encodeURI(decodeURI(u.replace(/[{}\\\s]/g, ""))).replace(/[%#]/g, c => `\\${c}`);

const inline = (s: string) =>
    esc(s)
        .replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}")
        .replace(/(?:\[\d+\])+/g, group => `\\textsuperscript{${[...group.matchAll(/\[(\d+)\]/g)].map(([, n]) => `\\hyperlink{ref-${n}}{${n}}`).join(",")}}`);

const body = (text: string) => {
    const out: string[] = [];
    let para: string[] = [];
    let list: { env: string; items: string[] } | null = null;
    const flush = () => {
        if (para.length) out.push(`${para.join("\n")}\n`);
        if (list) out.push(`\\begin{${list.env}}[leftmargin=1.6em,itemsep=.2em]\n${list.items.map(i => `\\item ${i}`).join("\n")}\n\\end{${list.env}}\n`);
        para = [];
        list = null;
    };
    for (const line of text.split("\n")) {
        const head = line.match(/^\s*(#{1,4})\s+(.*)$/);
        const item = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/);
        if (head) {
            flush();
            out.push(`\\${(head[1] ?? "").length > 2 ? "subsection" : "section"}{${inline(head[2] ?? "")}}\n`);
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

const about = (r: Ref) => (r.kind === "web" ? "web page" : [`${r.kind} by ${r.author}`, r.date, r.state].filter(Boolean).join(" · "));

export const tex = (o: { name: string; edition: string; text: string; refs: Ref[]; thanks?: string }) => {
    const parts = o.text.trim().split(/\n(?=\s*#{1,4}\s)/);
    const lead = parts.length > 1 && !/^\s*#/.test(parts[0] ?? "") ? (parts.shift() ?? "") : "";
    const font = (name: string) => `{${name}}[Path=${FONTS}/, Extension=.otf, UprightFont=*-Regular, BoldFont=*-Bold]`;
    return `\\documentclass[UTF8,a4paper,11pt,fontset=none,zihao=false]{ctexart}
\\usepackage[margin=2.4cm,top=2.6cm,bottom=2.4cm]{geometry}
\\setCJKmainfont${font("NotoSerifCJKsc")}
\\setCJKsansfont${font("NotoSerifCJKsc")}
\\setCJKmonofont${font("NotoSerifCJKsc")}
\\usepackage{enumitem}
\\usepackage{xcolor}
\\definecolor{accent}{HTML}{0B63C4}
\\definecolor{mute}{HTML}{6B7078}
\\usepackage{fancyhdr}
\\usepackage{hyperref}
\\usepackage{xurl}
\\urlstyle{same}
\\hypersetup{colorlinks=true,linkcolor=accent,urlcolor=accent,pdftitle={${esc(o.name)} ${esc(o.edition)}},pdfauthor={Mofufu}}
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[L]{\\small\\color{mute}${esc(o.name)}}
\\fancyhead[R]{\\small\\color{mute}${esc(o.edition)}}
\\fancyfoot[C]{\\small\\color{mute}\\thepage}
\\renewcommand{\\headrulewidth}{0.3pt}
\\linespread{1.4}
\\setlength{\\parskip}{.45em}
\\ctexset{section={format=\\large\\bfseries\\raggedright,beforeskip=1.4em,afterskip=.6em},subsection={format=\\normalsize\\bfseries\\raggedright}}
\\begin{document}
\\thispagestyle{empty}
\\begin{center}
{\\LARGE\\bfseries ${esc(o.name)}}\\par\\vspace{.5em}
{\\large ${esc(o.edition)}}\\par\\vspace{.4em}
{\\small\\color{mute}Mofufu\\enspace\\textperiodcentered\\enspace\\href{https://archive.open-run.org}{archive.open-run.org}}
\\end{center}
${lead.trim() ? `\\begin{abstract}\n${body(lead)}\\end{abstract}\n` : ""}
${body(parts.join("\n"))}
${
    o.refs.length
        ? `\\section*{参考来源}
{\\small\\sloppy\\emergencystretch=3em
\\begin{enumerate}[label={[\\arabic*]},leftmargin=2.4em,itemsep=.15em]
${o.refs.map(r => `\\item \\hypertarget{ref-${r.n}}{}${esc(r.title || r.link)}\\ {\\color{mute}(${esc(about(r))})}\\\\\\url{${link(r.link)}}`).join("\n")}
\\end{enumerate}}`
        : ""
}
\\vfill
{\\footnotesize\\color{mute}${o.thanks ? `${esc(o.thanks)}\\par ` : ""}I am a bot with sources linking to \\href{https://archive.open-run.org}{archive.open-run.org}\\enspace\\textperiodcentered\\enspace\\href{https://clarelab.moe}{clareLab.moe}\\enspace\\textperiodcentered\\enspace\\href{https://ko-fi.com/clarelab}{ko-fi.com/clareLab}\\par}
\\end{document}
`;
};

export const markdown = (o: { name: string; edition: string; text: string; refs: Ref[]; thanks?: string }) =>
    [
        `# ${o.name} · ${o.edition}`,
        o.text.trim(),
        o.refs.length ? `## 参考来源\n\n${o.refs.map(r => `${r.n}. [${r.title || r.link}](${r.link}) · ${about(r)}`).join("\n")}` : "",
        o.thanks ?? "",
        "I am a bot with sources linking to [archive.open-run.org](https://archive.open-run.org) · [clareLab.moe](https://clarelab.moe) · [ko-fi.com/clareLab](https://ko-fi.com/clarelab)",
    ]
        .filter(Boolean)
        .join("\n\n");

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
