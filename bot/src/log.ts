import { Database } from "bun:sqlite";
import { join } from "node:path";

const SCHEMA = `
create table if not exists chats (
    id integer primary key,
    at integer not null,
    source text not null,
    status text not null,
    visitor text,
    thread text,
    turn integer,
    ip text,
    edge text,
    country text,
    city text,
    region text,
    region_code text,
    postal text,
    lat real,
    lon real,
    timezone text,
    continent text,
    metro text,
    agent text,
    origin text,
    referer text,
    headers text,
    client text,
    author text,
    place text,
    link text,
    question text,
    history text,
    answer text,
    refs text,
    steps text,
    model text,
    turns integer,
    ms integer,
    error text,
    limits text
);
create index if not exists chats_at on chats (at);
create index if not exists chats_visitor on chats (visitor, at);
create index if not exists chats_ip on chats (ip, at);
create index if not exists chats_thread on chats (thread, turn);
`;

export type Chat = {
    at?: number;
    source: "site" | "reddit";
    status: string;
    visitor?: string | null;
    thread?: string | null;
    turn?: number | null;
    ip?: string | null;
    edge?: string | null;
    country?: string | null;
    city?: string | null;
    region?: string | null;
    region_code?: string | null;
    postal?: string | null;
    lat?: number | null;
    lon?: number | null;
    timezone?: string | null;
    continent?: string | null;
    metro?: string | null;
    agent?: string | null;
    origin?: string | null;
    referer?: string | null;
    headers?: unknown;
    client?: unknown;
    author?: string | null;
    place?: string | null;
    link?: string | null;
    question?: string | null;
    history?: unknown;
    answer?: string | null;
    refs?: unknown;
    steps?: unknown;
    model?: string | null;
    turns?: number | null;
    ms?: number | null;
    error?: string | null;
    limits?: unknown;
};

const COLUMNS = [
    "at",
    "source",
    "status",
    "visitor",
    "thread",
    "turn",
    "ip",
    "edge",
    "country",
    "city",
    "region",
    "region_code",
    "postal",
    "lat",
    "lon",
    "timezone",
    "continent",
    "metro",
    "agent",
    "origin",
    "referer",
    "headers",
    "client",
    "author",
    "place",
    "link",
    "question",
    "history",
    "answer",
    "refs",
    "steps",
    "model",
    "turns",
    "ms",
    "error",
    "limits",
] as const;

const JSONS = new Set(["headers", "client", "history", "refs", "steps", "limits"]);

const text = (value: string | null) => {
    const t = value?.trim();
    if (!t) return null;
    try {
        return t.includes("%") ? decodeURIComponent(t) : t;
    } catch {
        return t;
    }
};

const number = (value: string | null) => {
    const n = value === null || value.trim() === "" ? Number.NaN : Number(value);
    return Number.isFinite(n) ? n : null;
};

export const place = (req: Request) => {
    const h = (name: string) => req.headers.get(name);
    return {
        country: text(h("cf-ipcountry")),
        city: text(h("cf-ipcity")),
        region: text(h("cf-region")),
        region_code: text(h("cf-region-code")),
        postal: text(h("cf-postal-code")),
        lat: number(h("cf-iplatitude")),
        lon: number(h("cf-iplongitude")),
        timezone: text(h("cf-timezone")),
        continent: text(h("cf-ipcontinent")),
        metro: text(h("cf-metro-code")),
        agent: h("user-agent"),
        origin: h("origin"),
        referer: h("referer"),
        headers: Object.fromEntries(req.headers),
    };
};

export class Log {
    private readonly db: Database;
    private readonly insert;

    constructor(dir: string) {
        this.db = new Database(join(dir, "chats.db"), { create: true });
        this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
        this.db.exec(SCHEMA);
        this.insert = this.db.query(`insert into chats (${COLUMNS.join(", ")}) values (${COLUMNS.map(c => `$${c}`).join(", ")})`);
    }

    write(chat: Chat) {
        const row: Record<string, string | number | null> = {};
        for (const c of COLUMNS) {
            const v = c === "at" ? (chat.at ?? Date.now()) : chat[c];
            row[`$${c}`] = v === undefined || v === null ? null : JSONS.has(c) ? JSON.stringify(v) : (v as string | number);
        }
        try {
            this.insert.run(row);
        } catch (e) {
            console.error(`chat log: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
