import { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Ledger } from "./ledger";

const DAY = 86400000;
const PERIOD = 31 * DAY;
const GRACE = 3 * DAY;
const TEST = "00000000-1111-2222-3333-444444444444";

const KOFI_FEE = Number(process.env.KOFI_FEE ?? 0.05);
const PAY_FEE = Number(process.env.PAY_FEE ?? 0.03);
const PAY_FIXED = Number(process.env.PAY_FIXED ?? 0.3);
export const MARGIN = Number(process.env.MARGIN ?? 0.5);
const MEMBER = Number(process.env.TIER_MEMBER ?? 4);
const SPONSOR = Number(process.env.TIER_SPONSOR ?? 16);

const SCHEMA = `
create table if not exists payments (
    id integer primary key,
    at integer not null,
    received integer not null,
    message_id text unique,
    transaction_id text,
    type text,
    tier text,
    amount real not null,
    currency text not null,
    email text,
    name text,
    public integer not null default 0,
    subscription integer not null default 0,
    first integer not null default 0,
    test integer not null default 0,
    raw text
);
create index if not exists payments_email on payments (email, at);
create index if not exists payments_at on payments (at);
create table if not exists people (
    email text primary key,
    weekly integer not null default 0,
    daily integer not null default 0,
    token text not null unique,
    since integer not null,
    changed integer not null
);
`;

export type Tier = "owner" | "sponsor" | "member";
export type Standing = { tier: Tier; email: string; name: string | null; since: number; until: number; cap: number; amount: number; public: boolean };
export type Person = { email: string; weekly: number; daily: number; token: string; since: number; changed: number };
type Payment = { at: number; amount: number; currency: string; email: string; name: string | null; public: number };

const list = (v: string | undefined) =>
    (v ?? "")
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
const OWNER_DOMAINS = list(process.env.OWNER_DOMAINS);
const OWNER_REDDIT = list(process.env.OWNER_REDDIT);

export const ownerMail = (email: string) => {
    const d = email.split("@")[1]?.toLowerCase() ?? "";
    return Boolean(d) && OWNER_DOMAINS.some(o => d === o || d.endsWith(`.${o}`));
};
export const ownerReddit = (name: string) => OWNER_REDDIT.includes(name.toLowerCase());

const same = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

export class Money {
    private readonly db: Database;
    private rates: Record<string, number> = { USD: Number(process.env.EUR_USD) || 1.1 };
    private ratesAt = 0;

    constructor(
        dir: string,
        private readonly ledger: Ledger,
    ) {
        this.db = new Database(join(dir, "chats.db"), { create: true });
        this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
        this.db.exec(SCHEMA);
    }

    async refresh() {
        if (Date.now() - this.ratesAt < 12 * 3600_000) return;
        this.ratesAt = Date.now();
        try {
            const xml = await (await fetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml")).text();
            const found = Object.fromEntries([...xml.matchAll(/currency='([A-Z]{3})' rate='([\d.]+)'/g)].map(m => [m[1], Number(m[2])]));
            if (found.USD) this.rates = found;
            else this.ratesAt = Date.now() - 11 * 3600_000;
        } catch {
            this.ratesAt = Date.now() - 11 * 3600_000;
        }
    }

    get usd() {
        return this.rates.USD ?? 1.1;
    }

    eur(amount: number, currency: string) {
        if (currency.toUpperCase() === "EUR") return amount;
        const r = this.rates[currency.toUpperCase()];
        return r ? amount / r : amount;
    }

    fee(eur: number) {
        return eur * (KOFI_FEE + PAY_FEE) + PAY_FIXED;
    }

    accept(raw: string) {
        let d: Record<string, unknown>;
        try {
            d = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return { status: "bad" as const };
        }
        if (!d || typeof d !== "object") return { status: "bad" as const };
        if (!same(String(d.verification_token ?? ""), process.env.KOFI_TOKEN ?? "")) return { status: "forbidden" as const };
        const email = String(d.email ?? "")
            .trim()
            .toLowerCase();
        const test = d.kofi_transaction_id === TEST || /@example\.(com|org|net)$/.test(email);
        const subscription = d.is_subscription_payment === true;
        const first = d.is_first_subscription_payment === true;
        const at = Date.parse(String(d.timestamp ?? "")) || Date.now();
        const changes = this.db
            .query(
                `insert or ignore into payments (at, received, message_id, transaction_id, type, tier, amount, currency, email, name, public, subscription, first, test, raw)
                 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                at,
                Date.now(),
                String(d.message_id ?? crypto.randomUUID()),
                String(d.kofi_transaction_id ?? ""),
                String(d.type ?? ""),
                d.tier_name ? String(d.tier_name) : null,
                Number(d.amount) || 0,
                String(d.currency ?? "EUR"),
                email || null,
                d.from_name ? String(d.from_name) : null,
                d.is_public === false ? 0 : 1,
                subscription ? 1 : 0,
                first ? 1 : 0,
                test ? 1 : 0,
                raw,
            ).changes;
        if (!changes) return { status: "duplicate" as const };
        if (test) return { status: "test" as const };
        const standing = email ? this.standing(email) : null;
        if (standing && first) this.subscribe(email, { weekly: true });
        return { status: "ok" as const, email, standing, first };
    }

    standing(email: string, now = Date.now()): Standing | null {
        const e = email.toLowerCase();
        if (ownerMail(e))
            return { tier: "owner", email: e, name: null, since: 0, until: Number.POSITIVE_INFINITY, cap: Number.POSITIVE_INFINITY, amount: 0, public: false };
        const p = this.db
            .query(
                "select at, amount, currency, email, name, public from payments where email = ? and subscription = 1 and test = 0 and at > ? order by at desc limit 1",
            )
            .get(e, now - PERIOD - GRACE) as Payment | null;
        if (!p) return null;
        const eur = this.eur(p.amount, p.currency);
        if (eur < MEMBER - 0.005) return null;
        return {
            tier: eur >= SPONSOR - 0.005 ? "sponsor" : "member",
            email: e,
            name: p.name,
            since: p.at,
            until: p.at + PERIOD + GRACE,
            cap: Math.max(0, (MARGIN * eur - this.fee(eur)) * this.usd),
            amount: eur,
            public: Boolean(p.public),
        };
    }

    left(s: Standing) {
        if (s.tier === "owner") return Number.POSITIVE_INFINITY;
        return s.cap - this.ledger.spent(s.since, { tag: `member:${s.email}` });
    }

    budget(now = Date.now()) {
        const since = now - 31 * DAY;
        let revenue = 0;
        let fees = 0;
        for (const r of this.db.query("select amount, currency from payments where test = 0 and at >= ?").all(since) as Payment[]) {
            const e = this.eur(r.amount, r.currency);
            revenue += e;
            fees += this.fee(e);
        }
        const allowance = (MARGIN * revenue - fees) * this.usd;
        const spent = this.ledger.spent(since, { except: "owner" });
        return { revenue, fees, allowance, spent, surplus: allowance - spent };
    }

    sponsors(now = Date.now()) {
        const rows = this.db
            .query("select email, max(at) at from payments where subscription = 1 and test = 0 and at > ? group by email")
            .all(now - PERIOD - GRACE) as { email: string }[];
        const active = rows.map(r => this.standing(r.email, now)).filter((s): s is Standing => s?.tier === "sponsor");
        return { names: active.filter(s => s.public && s.name).map(s => s.name as string), hidden: active.filter(s => !s.public || !s.name).length };
    }

    person(email: string) {
        return (this.db.query("select * from people where email = ?").get(email.toLowerCase()) as Person | null) ?? null;
    }

    subscribe(email: string, o: { weekly?: boolean; daily?: boolean }) {
        const e = email.toLowerCase();
        const now = Date.now();
        this.db
            .query("insert or ignore into people (email, weekly, daily, token, since, changed) values (?, 0, 0, ?, ?, ?)")
            .run(e, randomBytes(16).toString("hex"), now, now);
        if (o.weekly !== undefined) this.db.query("update people set weekly = ?, changed = ? where email = ?").run(o.weekly ? 1 : 0, now, e);
        if (o.daily !== undefined) this.db.query("update people set daily = ?, changed = ? where email = ?").run(o.daily ? 1 : 0, now, e);
        return this.person(e) as Person;
    }

    byToken(token: string) {
        return /^[0-9a-f]{32}$/.test(token) ? ((this.db.query("select * from people where token = ?").get(token) as Person | null) ?? null) : null;
    }

    readers(kind: "weekly" | "daily") {
        return this.db.query(`select * from people where ${kind} = 1 order by since`).all() as Person[];
    }
}
