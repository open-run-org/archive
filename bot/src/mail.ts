import { Database } from "bun:sqlite";
import { lookup, resolveMx } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer, { type SendMailOptions } from "nodemailer";
import PostalMime from "postal-mime";
import { reserved } from "./limit";

export const ADDRESS = (process.env.MAIL_ADDRESS || "bot.mofufu@clarelab.moe").toLowerCase();
const DOMAIN = ADDRESS.split("@")[1] ?? "clarelab.moe";
const QUEUE = Number(process.env.MAIL_QUEUE) || 4;
const SIGNED = [
    "From:Sender:Reply-To:Subject:Date:Message-ID:To:Cc:MIME-Version:Content-Type:Content-Transfer-Encoding:Content-ID:Content-Description",
    "Resent-Date:Resent-From:Resent-Sender:Resent-To:Resent-Cc:Resent-Message-ID:In-Reply-To:References",
    "List-Id:List-Help:List-Unsubscribe:List-Unsubscribe-Post:List-Subscribe:List-Post:List-Owner:List-Archive",
].join(":");
const AUTHSERV = (process.env.MAIL_AUTHSERV || "mx.cloudflare.net").toLowerCase();

const SCHEMA = `
create table if not exists mail (
    id integer primary key,
    at integer not null,
    status text not null,
    reason text,
    sender text,
    name text,
    envelope_from text,
    envelope_to text,
    message_id text,
    thread text,
    in_reply_to text,
    refs text,
    subject text,
    text text,
    headers text,
    auth text,
    size integer,
    raw blob,
    attempts integer not null default 0,
    answered_at integer,
    reply_id text,
    reply text,
    reply_refs text,
    error text
);
create index if not exists mail_status on mail (status, at);
create index if not exists mail_sender on mail (sender, status);
create index if not exists mail_thread on mail (thread, at);
create table if not exists sends (
    id integer primary key,
    at integer not null,
    kind text not null,
    recipient text not null,
    message_id text not null,
    subject text,
    text text,
    refs text,
    via text,
    error text
);
create index if not exists sends_message on sends (message_id);
create index if not exists sends_recipient on sends (recipient, at);
`;

export type Letter = {
    id: number;
    at: number;
    sender: string;
    name: string | null;
    message_id: string | null;
    thread: string;
    refs: string | null;
    subject: string | null;
    text: string;
    headers: string;
    auth: string;
    attempts: number;
};

const ids = (s: string | undefined | null) => (s ?? "").match(/<[^<>\s]+>/g) ?? [];

const authenticated = (headers: { key: string; value: string }[], sender: string) => {
    const domain = sender.split("@")[1] ?? "";
    const aligned = (d: string) => d === domain || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`);
    const top = headers.find(h => h.key === "authentication-results")?.value.toLowerCase() ?? "";
    const line = /^\s*([^\s;]+)/.exec(top)?.[1] === AUTHSERV ? top : "";
    const dkim = [...line.matchAll(/dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/g)].some(m => aligned(m[1] ?? ""));
    const spf = [...line.matchAll(/spf=pass[^;]*?smtp\.mailfrom=(?:[^@;\s]*@)?([a-z0-9.-]+)/g)].some(m => aligned(m[1] ?? ""));
    const dmarc = [...line.matchAll(/dmarc=pass[^;]*?header\.from=([a-z0-9.-]+)/g)].some(m => m[1] === domain);
    return { dkim, spf, dmarc, ok: dkim || spf || dmarc, lines: top ? [top] : [] };
};

const automated = (headers: { key: string; value: string }[], sender: string, envelope: string, type: string) => {
    const get = (k: string) =>
        headers
            .find(h => h.key === k)
            ?.value.trim()
            .toLowerCase() ?? "";
    if (sender === ADDRESS) return "from myself";
    if (!envelope || envelope === "<>") return "bounce";
    if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)([+.@-]|$)/.test(sender)) return "system sender";
    const auto = get("auto-submitted");
    if (auto && auto !== "no") return `auto-submitted ${auto}`;
    if (/^(bulk|junk|list)$/.test(get("precedence"))) return `precedence ${get("precedence")}`;
    if (get("list-id") || get("list-unsubscribe")) return "mailing list";
    if (/multipart\/report/.test(type)) return "delivery report";
    return null;
};

export const fresh = (text: string) => {
    const lines = text.split("\n");
    const cut = lines.findIndex(
        (l, i) =>
            i > 0 &&
            /^(On .+wrote:|在.+写道[:：]|.+于.+写道[:：]|.+於.+寫道[:：]|-{2,}\s*(Original|Forwarded) Message\s*-{2,}|发件人[:：].*|From: .+)$/i.test(l.trim()),
    );
    const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter(l => !/^\s*>/.test(l));
    return kept.join("\n").trim() || text.trim();
};

const html = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export type Ref = { n: number; kind: string; title: string; link: string; author: string; date: string; state: string; sub?: string };

const markup = (text: string, refs: Ref[]) => {
    const inline = (raw: string) => {
        const urls: string[] = [];
        const s = raw.replace(/`([^`\n]+)`/g, "$1").replace(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'()+,;=%]+/g, u => {
            let url = u.replace(/[.,;:!?']+$/, "");
            while (url.endsWith(")") && (url.match(/\)/g) ?? []).length > (url.match(/\(/g) ?? []).length) url = url.slice(0, -1);
            urls.push(url);
            return `\uE100${urls.length - 1}\uE101${u.slice(url.length)}`;
        });
        return html(s)
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/(?:\[\d+\])+/g, group => {
                const links = [...group.matchAll(/\[(\d+)\]/g)]
                    .map(([, n]) => refs[Number(n) - 1])
                    .filter((r): r is Ref => Boolean(r))
                    .map(r => `<a href="${html(r.link)}" style="color:#0b63c4;text-decoration:none">${r.n}</a>`);
                return links.length ? `<sup style="font-size:.72em;line-height:0">${links.join(",")}</sup>` : group;
            })
            .replace(/\uE100(\d+)\uE101/g, (_, i) => {
                const url = html(urls[Number(i)] ?? "");
                return `<a href="${url}" style="color:#0b63c4;text-decoration:none">${url}</a>`;
            });
    };
    const out: string[] = [];
    let para: string[] = [];
    let list: { tag: string; start: number; items: string[] } | null = null;
    const flush = () => {
        if (para.length) out.push(`<p style="margin:0 0 .7em">${para.join("<br>")}</p>`);
        if (list)
            out.push(
                `<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ""} style="margin:0 0 .7em;padding-left:1.4em">${list.items.map(i => `<li>${i}</li>`).join("")}</${list.tag}>`,
            );
        para = [];
        list = null;
    };
    for (const line of text.split("\n")) {
        const item = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/);
        const head = line.match(/^\s*#{1,4}\s+(.*)$/);
        if (head) {
            flush();
            out.push(`<h3 style="margin:1.3em 0 .5em;font-size:1.05em">${inline(head[1] ?? "")}</h3>`);
        } else if (!line.trim()) flush();
        else if (item) {
            const tag = item[1] ? "ul" : "ol";
            if (para.length || (list && list.tag !== tag)) flush();
            list ??= { tag, start: Number(item[2]) || 1, items: [] };
            list.items.push(inline(item[3] ?? ""));
        } else {
            if (list) flush();
            para.push(inline(line.trim()));
        }
    }
    flush();
    return out.join("");
};

export type Signature = { weekly?: boolean; daily?: boolean | null; quota?: string | null; guide?: string };

const LINK = 'style="color:#0b63c4;text-decoration:none"';

const sign = (s: Signature = {}) => {
    const rows: { label: string; text: string; html: string }[] = [];
    const toggle = (label: string, on: boolean, name: string) =>
        rows.push({
            label,
            text: on ? `On · reply "${name} off" to stop` : `Off · reply "${name} on" to subscribe`,
            html: on ? `On · reply <b>${name} off</b> to stop` : `Off · reply <b>${name} on</b> to subscribe`,
        });
    if (s.weekly !== undefined) toggle("Weekly", s.weekly, "weekly");
    if (typeof s.daily === "boolean") toggle("Daily", s.daily, "daily");
    if (s.quota) rows.push({ label: "Quota", text: s.quota, html: html(s.quota) });
    const links: [string, string][] = [
        ["clareLab.moe", "https://clarelab.moe"],
        ["Ko-fi", "https://ko-fi.com/clarelab"],
        ...(s.guide ? ([["Guide", s.guide]] as [string, string][]) : []),
    ];
    return {
        text: [
            "I am a bot with sources linking to archive.open-run.org",
            ...rows.map(r => `${r.label.padEnd(8)}${r.text}`),
            `clareLab.moe · ko-fi.com/clareLab${s.guide ? ` · Guide: ${s.guide}` : ""}`,
        ].join("\n"),
        html: [
            '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:2em 0 0;border-top:1px solid #e3e5e8;font-size:12px;line-height:1.75;color:#6b7078;border-collapse:collapse">',
            `<tr><td colspan="2" style="padding:.9em 0 .2em">I am a bot with sources linking to <a href="https://archive.open-run.org" ${LINK}>archive.open-run.org</a></td></tr>`,
            ...rows.map(r => `<tr><td style="padding-right:14px;color:#9a9ea6;vertical-align:top">${r.label}</td><td>${r.html}</td></tr>`),
            `<tr><td colspan="2" style="padding-top:.3em">${links.map(([t, u]) => `<a href="${html(u)}" ${LINK}>${t}</a>`).join(" · ")}</td></tr>`,
            "</table>",
        ].join(""),
    };
};

const PAGE_CSS = `:root{--bg:#f6f7f9;--card:#fff;--ink:#2b2d31;--mute:#6b7078;--line:#e3e5e8;--accent:#0b63c4}@media (prefers-color-scheme:dark){:root{--bg:#141518;--card:#1c1d21;--ink:#e4e5e8;--mute:#9a9ea6;--line:#2c2e33;--accent:#5aa2f0}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}main{width:100%;max-width:26rem;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}.eyebrow{margin:0;color:var(--mute);font-size:13px;letter-spacing:.04em}h1{margin:.2em 0 .5em;font-size:22px}p{margin:.4em 0;color:var(--mute)}b{color:var(--ink);font-weight:600}button{margin-top:1.2em;width:100%;font:inherit;font-weight:600;padding:.7em 1em;border-radius:10px;border:0;background:var(--accent);color:#fff;cursor:pointer}`;

const webpage = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_CSS}</style></head><body><main><p class="eyebrow">Mofufu</p>${body}</main></body></html>`;

export type List = "weekly" | "daily";
const LISTS: Record<List, string> = { weekly: "润学周报", daily: "润学日报" };
const named = (list?: List) => (list ? LISTS[list] : `${LISTS.weekly} and ${LISTS.daily}`);

export const PAGES = {
    invalid: () => webpage("Link not valid", `<h1>Link not valid</h1><p>Reply <b>weekly off</b> or <b>daily off</b> to any mail from Mofufu instead.</p>`),
    ask: (email: string, list?: List) =>
        webpage(
            "Unsubscribe",
            `<h1>Unsubscribe?</h1><p><b>${html(email)}</b> will stop getting ${named(list)}.</p><form method="post"><button>Unsubscribe</button></form>`,
        ),
    done: (email: string, list?: List) =>
        webpage(
            "Unsubscribed",
            `<h1>Unsubscribed</h1><p><b>${html(email)}</b> no longer gets ${named(list)}. To come back, reply <b>${list ?? "weekly"} on</b> to any mail from Mofufu.</p>`,
        ),
};

export type Change = { weekly?: boolean; daily?: boolean };

const COMMANDS: { re: RegExp; set: Change }[] = [
    { re: /^(weekly on|subscribe|订阅周报|开启周报)$/, set: { weekly: true } },
    { re: /^(weekly off|退订周报|关闭周报)$/, set: { weekly: false } },
    { re: /^(daily on|订阅日报|开启日报)$/, set: { daily: true } },
    { re: /^(daily off|退订日报|关闭日报)$/, set: { daily: false } },
    { re: /^(unsubscribe|退订)$/, set: { weekly: false, daily: false } },
];

export type Command = { set?: Change; lists: List[]; issues: { list: List; edition: string }[] };

const KINDS: Record<string, List> = { weekly: "weekly", daily: "daily", 周报: "weekly", 日报: "daily" };

type Part = { set?: Change; list?: List; issue?: { list: List; edition: string } };

const one = (x: string): Part | null => {
    const set = COMMANDS.find(c => c.re.test(x))?.set;
    if (set) return { set };
    const list = x.match(/^(weekly|daily) list$|^往期(周报|日报)$|^(周报|日报)列表$/);
    const listed = list && KINDS[list[1] ?? list[2] ?? list[3] ?? ""];
    if (listed) return { list: listed };
    const issue = x.match(/^(weekly|daily|周报|日报) ?(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
    const kind = issue && KINDS[issue[1] ?? ""];
    if (issue && kind) return { issue: { list: kind, edition: `${issue[2]}-${(issue[3] ?? "").padStart(2, "0")}-${(issue[4] ?? "").padStart(2, "0")}` } };
    return null;
};

export const commands = (subject: string, body: string): Command | null => {
    const parse = (s: string) => {
        const parts = s
            .toLowerCase()
            .split(/[\n,，、;；]+/)
            .map(x =>
                x
                    .replace(/["“”'‘’]/g, "")
                    .replace(/[。.!！?？]+$/, "")
                    .replace(/\s+/g, " ")
                    .trim(),
            )
            .filter(Boolean);
        if (!parts.length) return null;
        const found = parts.map(one);
        if (!found.every(Boolean)) return null;
        const out: Command = { lists: [], issues: [] };
        for (const c of found) {
            if (c?.set) out.set = { ...out.set, ...c.set };
            if (c?.list && !out.lists.includes(c.list)) out.lists.push(c.list);
            if (c?.issue && !out.issues.some(i => i.list === c.issue?.list && i.edition === c.issue?.edition)) out.issues.push(c.issue);
        }
        return out;
    };
    return parse(body) ?? (body.trim() ? null : parse(subject.replace(/^\s*(re|回复|答复)\s*[:：]\s*/i, "")));
};

export type Footer = { text: string; html: string };

export const compose = (text: string, refs: Ref[], footer?: Footer, sig?: Signature) => {
    const about = (r: Ref) => (r.kind === "web" ? "web page" : [`${r.kind} by ${r.author}`, r.date, r.state].filter(Boolean).join(" · "));
    const plain = [
        text,
        refs.length ? `Sources\n${refs.map(r => `[${r.n}] ${r.title} (${about(r)})\n    ${r.link}`).join("\n")}` : "",
        footer?.text ?? "",
        `-- \n${sign(sig).text}`,
    ]
        .filter(Boolean)
        .join("\n\n");
    const list = refs.length
        ? `<ol style="margin:1em 0 0;padding-left:1.4em;font-size:.78em;color:#6b7078">${refs.map(r => `<li><a href="${html(r.link)}" style="color:#0b63c4;text-decoration:none">${html(r.title || r.link)}</a> · ${html(about(r))}</li>`).join("")}</ol>`
        : "";
    const body = `<div style="font:15px/1.65 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#2b2d31;max-width:42em">${markup(text, refs)}${list}${footer?.html ?? ""}${sign(sig).html}</div>`;
    return { text: plain, html: body };
};

export class Mailbox {
    private readonly db: Database;
    private readonly key: string | null;

    constructor(dir: string) {
        this.db = new Database(join(dir, "chats.db"), { create: true });
        this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
        this.db.exec(SCHEMA);
        const path = process.env.MAIL_DKIM_KEY || "/dkim/mofufu.pem";
        this.key = existsSync(path) ? readFileSync(path, "utf8") : null;
        if (!this.key) console.warn(`mail: no DKIM key at ${path}, replies will be unsigned`);
    }

    async receive(raw: Uint8Array, envelope: { from: string; to: string }, o: { unlimited?: (sender: string) => boolean } = {}) {
        const parsed = await PostalMime.parse(raw);
        const sender = (parsed.from?.address || envelope.from || "").toLowerCase();
        const headers = parsed.headers ?? [];
        const auth = authenticated(headers, sender);
        const type = headers.find(h => h.key === "content-type")?.value ?? "";
        const messageId = parsed.messageId || null;
        const references = ids(parsed.references);
        const inReplyTo = ids(parsed.inReplyTo)[0] ?? null;
        const thread = references[0] ?? inReplyTo ?? messageId ?? `<${Date.now()}@${DOMAIN}>`;
        const text = (parsed.text || (parsed.html ?? "").replace(/<[^>]+>/g, " ")).replace(/\r\n/g, "\n").trim();
        const skip = automated(headers, sender, envelope.from, type);
        const waiting = (this.db.query("select count(*) n from mail where sender = ? and status = 'queued'").get(sender) as { n: number }).n;
        const full = waiting >= QUEUE && !(auth.ok && o.unlimited?.(sender));
        const command = !skip && auth.ok ? commands(parsed.subject ?? "", fresh(text)) : null;
        const status = skip ? "ignored" : !auth.ok ? "unauthenticated" : command ? "command" : !text ? "empty" : full ? "dropped" : "queued";
        const reason =
            skip ??
            (!auth.ok ? "no aligned SPF, DKIM or DMARC pass" : command ? JSON.stringify(command) : !text ? "no text" : full ? `queue full (${waiting})` : null);
        const row = this.db
            .query(
                `insert into mail (at, status, reason, sender, name, envelope_from, envelope_to, message_id, thread, in_reply_to, refs, subject, text, headers, auth, size, raw)
                 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
            )
            .get(
                Date.now(),
                status,
                reason,
                sender,
                parsed.from?.name || null,
                envelope.from,
                envelope.to,
                messageId,
                thread,
                inReplyTo,
                [...references, ...(messageId ? [messageId] : [])].join(" ") || null,
                parsed.subject ?? null,
                text,
                JSON.stringify(headers),
                JSON.stringify({ dkim: auth.dkim, spf: auth.spf, dmarc: auth.dmarc, results: auth.lines }),
                raw.byteLength,
                raw,
            ) as { id: number };
        return { id: row.id, status, reason, sender, command };
    }

    letter(id: number) {
        return (this.db.query("select * from mail where id = ?").get(id) as Letter | null) ?? null;
    }

    queued(): Letter[] {
        return this.db.query("select * from mail where status = 'queued' order by at").all() as Letter[];
    }

    recent(sender: string, k = 8) {
        return (
            this.db.query("select subject, text, reply, at from mail where sender = ? and status = 'answered' order by at desc limit ?").all(sender, k) as {
                subject: string | null;
                text: string;
                reply: string;
                at: number;
            }[]
        ).reverse();
    }

    sent(letter: Letter) {
        const ids = [...new Set([...(letter.refs ?? "").split(" "), letter.thread].filter(Boolean))];
        if (!ids.length) return null;
        return (
            (this.db
                .query(
                    `select kind, subject, text, at from sends where message_id in (${ids.map(() => "?").join(", ")}) and recipient = ? order by at desc limit 1`,
                )
                .get(...ids, letter.sender) as { kind: string; subject: string; text: string; at: number } | null) ?? null
        );
    }

    history(letter: Letter) {
        const rows = this.db
            .query("select text, reply from mail where thread = ? and sender = ? and status = 'answered' and id < ? order by at")
            .all(letter.thread, letter.sender, letter.id) as { text: string; reply: string }[];
        return rows.flatMap(r => [
            { role: "visitor" as const, text: r.text },
            { role: "you" as const, text: r.reply },
        ]);
    }

    mark(id: number, fields: Record<string, string | number | null>) {
        const keys = Object.keys(fields);
        this.db.query(`update mail set ${keys.map(k => `${k} = ?`).join(", ")} where id = ?`).run(...keys.map(k => fields[k] ?? null), id);
    }

    async send(letter: Letter, text: string, refs: Ref[], sig?: Signature) {
        const subject = /^\s*re:/i.test(letter.subject ?? "") ? (letter.subject ?? "") : `Re: ${letter.subject || "(no subject)"}`;
        const id = `<${crypto.randomUUID()}@${DOMAIN}>`;
        return await this.transmit({
            from: { name: "Mofufu", address: ADDRESS },
            to: letter.name ? { name: letter.name, address: letter.sender } : letter.sender,
            subject,
            messageId: id,
            ...(letter.message_id ? { inReplyTo: letter.message_id } : {}),
            ...(letter.refs ? { references: letter.refs.split(" ").slice(-20) } : {}),
            headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
            ...compose(text, refs, undefined, sig),
        });
    }

    async post(
        to: string,
        o: {
            kind: string;
            subject: string;
            text: string;
            refs: Ref[];
            footer?: Footer;
            list?: { url: string; command: string };
            sig?: Signature;
            files?: { filename: string; content: Uint8Array | string; contentType: string }[];
        },
    ) {
        const id = `<${crypto.randomUUID()}@${DOMAIN}>`;
        const headers: Record<string, string> = { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" };
        if (o.list) {
            headers["List-Unsubscribe"] = `<${o.list.url}>, <mailto:${ADDRESS}?subject=${encodeURIComponent(o.list.command)}>`;
            headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
            headers.Precedence = "bulk";
        }
        let via = "";
        let error: string | null = null;
        try {
            via = (
                await this.transmit({
                    from: { name: "Mofufu", address: ADDRESS },
                    to,
                    subject: o.subject,
                    messageId: id,
                    headers,
                    ...compose(o.text, o.refs, o.footer, o.sig),
                    ...(o.files?.length
                        ? {
                              attachments: o.files.map(f => ({
                                  filename: f.filename,
                                  content: typeof f.content === "string" ? f.content : Buffer.from(f.content),
                                  contentType: f.contentType,
                              })),
                          }
                        : {}),
                })
            ).via;
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
        this.db
            .query("insert into sends (at, kind, recipient, message_id, subject, text, refs, via, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(Date.now(), o.kind, to.toLowerCase(), id, o.subject, o.text, JSON.stringify(o.refs), via, error);
        if (error) throw new Error(error);
        return { id, via };
    }

    private async transmit(message: SendMailOptions & { messageId: string; to: string | { name: string; address: string } }) {
        const id = message.messageId;
        const recipient = typeof message.to === "string" ? message.to : message.to.address;
        if (process.env.MAIL_DRY === "1") {
            console.log(JSON.stringify({ mail: "dry", to: recipient, subject: message.subject, id }));
            return { id, via: "dry" };
        }
        const domain = recipient.split("@")[1] ?? "";
        const exchanges = (await resolveMx(domain).catch((e: { code?: string }) => (e?.code === "ENODATA" ? [] : Promise.reject(e)))).sort(
            (a, b) => a.priority - b.priority,
        );
        if (!exchanges.length) exchanges.push({ exchange: domain, priority: 0 });
        let last: unknown = null;
        for (const { exchange } of exchanges) {
            const hosts = (await lookup(exchange, { all: true }).catch(() => []))
                .sort((a, b) => a.family - b.family)
                .map(a => a.address)
                .filter(a => !reserved(a));
            if (!hosts.length) last = new Error(`${exchange} has no public address`);
            for (const host of hosts) {
                const transport = nodemailer.createTransport({
                    host,
                    port: 25,
                    secure: false,
                    name: process.env.MAIL_HELO || DOMAIN,
                    connectionTimeout: 15000,
                    greetingTimeout: 15000,
                    socketTimeout: 30000,
                    tls: { servername: exchange },
                    ...(this.key
                        ? {
                              dkim: {
                                  domainName: DOMAIN,
                                  keySelector: process.env.MAIL_DKIM_SELECTOR || "mofufu",
                                  privateKey: this.key,
                                  headerFieldNames: SIGNED,
                              },
                          }
                        : {}),
                });
                try {
                    const info = await transport.sendMail(message);
                    return { id, via: `${exchange} ${host}: ${info.response ?? ""}`.trim() };
                } catch (e) {
                    last = e;
                    const code = (e as { responseCode?: number })?.responseCode;
                    if (typeof code === "number" && code >= 500) throw Object.assign(e as Error, { permanent: true });
                } finally {
                    transport.close();
                }
            }
        }
        throw last ?? new Error("delivery failed");
    }
}
