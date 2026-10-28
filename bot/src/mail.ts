import { Database } from "bun:sqlite";
import { lookup, resolveMx } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import PostalMime from "postal-mime";
import { reserved } from "./limit";

export const ADDRESS = (process.env.MAIL_ADDRESS || "bot.mofufu@clarelab.moe").toLowerCase();
const DOMAIN = ADDRESS.split("@")[1] ?? "clarelab.moe";
const QUEUE = Number(process.env.MAIL_QUEUE) || 4;
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
        (l, i) => i > 0 && /^(On .+wrote:|在.+写道[:：]|.+於.+寫道[:：]|-{2,}\s*(Original|Forwarded) Message\s*-{2,}|发件人[:：].*|From: .+)$/i.test(l.trim()),
    );
    const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter(l => !/^\s*>/.test(l));
    return kept.join("\n").trim() || text.trim();
};

const html = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export type Ref = { n: number; kind: string; title: string; link: string; author: string; date: string; state: string };

const markup = (text: string, refs: Ref[]) => {
    const inline = (s: string) =>
        html(s)
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/(?:\[\d+\])+/g, group => {
                const links = [...group.matchAll(/\[(\d+)\]/g)]
                    .map(([, n]) => refs[Number(n) - 1])
                    .filter((r): r is Ref => Boolean(r))
                    .map(r => `<a href="${html(r.link)}" style="color:#0b63c4;text-decoration:none">${r.n}</a>`);
                return links.length ? `<sup style="font-size:.72em;line-height:0">${links.join(",")}</sup>` : group;
            });
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
        if (!line.trim()) flush();
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

const SIGN_TEXT = "I am a bot with sources linking to archive.open-run.org\nContact: clareLab.moe · Support: ko-fi.com/clareLab";
const SIGN_HTML =
    '<p style="margin:1.2em 0 0;font-size:.75em;font-style:italic;color:#6b7078">I am a bot with sources linking to <a href="https://archive.open-run.org" style="color:#0b63c4">archive.open-run.org</a><br>• Contact: <a href="https://clarelab.moe" style="color:#0b63c4">clareLab.moe</a><br>• Support: <a href="https://ko-fi.com/clarelab" style="color:#0b63c4">ko-fi.com/clareLab</a></p>';

export const compose = (text: string, refs: Ref[]) => {
    const about = (r: Ref) => (r.kind === "web" ? "web page" : [`${r.kind} by ${r.author}`, r.date, r.state].filter(Boolean).join(" · "));
    const plain = [text, refs.length ? `Sources\n${refs.map(r => `[${r.n}] ${r.title} (${about(r)})\n    ${r.link}`).join("\n")}` : "", `-- \n${SIGN_TEXT}`]
        .filter(Boolean)
        .join("\n\n");
    const list = refs.length
        ? `<ol style="margin:1em 0 0;padding-left:1.4em;font-size:.78em;color:#6b7078">${refs.map(r => `<li><a href="${html(r.link)}" style="color:#0b63c4;text-decoration:none">${html(r.title || r.link)}</a> · ${html(about(r))}</li>`).join("")}</ol>`
        : "";
    const body = `<div style="font:15px/1.65 -apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#2b2d31;max-width:42em">${markup(text, refs)}${list}${SIGN_HTML}</div>`;
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

    async receive(raw: Uint8Array, envelope: { from: string; to: string }) {
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
        const status = skip ? "ignored" : !auth.ok ? "unauthenticated" : !text ? "empty" : waiting >= QUEUE ? "dropped" : "queued";
        const reason = skip ?? (!auth.ok ? "no aligned SPF, DKIM or DMARC pass" : !text ? "no text" : waiting >= QUEUE ? `queue full (${waiting})` : null);
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
        return { id: row.id, status, reason, sender };
    }

    queued(): Letter[] {
        return this.db.query("select * from mail where status = 'queued' order by at").all() as Letter[];
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

    async send(letter: Letter, text: string, refs: Ref[]) {
        const subject = /^\s*re:/i.test(letter.subject ?? "") ? (letter.subject ?? "") : `Re: ${letter.subject || "(no subject)"}`;
        const id = `<${crypto.randomUUID()}@${DOMAIN}>`;
        const message = {
            from: { name: "Mofufu", address: ADDRESS },
            to: letter.name ? { name: letter.name, address: letter.sender } : letter.sender,
            subject,
            messageId: id,
            ...(letter.message_id ? { inReplyTo: letter.message_id } : {}),
            ...(letter.refs ? { references: letter.refs.split(" ").slice(-20) } : {}),
            headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
            ...compose(text, refs),
        };
        if (process.env.MAIL_DRY === "1") {
            console.log(JSON.stringify({ mail: "dry", to: letter.sender, subject, id }));
            return { id, via: "dry" };
        }
        const domain = letter.sender.split("@")[1] ?? "";
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
                    ...(this.key ? { dkim: { domainName: DOMAIN, keySelector: process.env.MAIL_DKIM_SELECTOR || "mofufu", privateKey: this.key } } : {}),
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
