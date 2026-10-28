import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { Usage } from "./gemini";

type Price = { until?: string; input: number; output: number; cached: number };

const PRICES: Record<string, Price[]> = {
    "gemini-3.8-flash": [
        { until: "2027-01-01", input: 0.75, output: 3.75, cached: 0.075 },
        { input: 1.5, output: 7.5, cached: 0.15 },
    ],
    "gemini-3.5-flash-lite": [{ input: 0.3, output: 2.5, cached: 0.03 }],
    "gemini-4-argon": [
        { until: "2026-12-01", input: 2, output: 10, cached: 0.1 },
        { input: 4, output: 20, cached: 0.2 },
    ],
};
const FALLBACK = "gemini-3.8-flash";
const SEARCH_FREE = 5000;
const SEARCH_PRICE = 0.014;

const SCHEMA = `
create table if not exists spend (
    id integer primary key,
    at integer not null,
    month text not null,
    tag text not null,
    model text not null,
    input integer not null,
    cached integer not null,
    output integer not null,
    searches integer not null,
    usd real not null
);
create index if not exists spend_at on spend (at);
create index if not exists spend_tag on spend (tag, at);
create index if not exists spend_month on spend (month);
`;

const scope = new AsyncLocalStorage<string>();

export const charge = <T>(tag: string, fn: () => Promise<T>) => scope.run(tag, fn);
export const tagged = () => scope.getStore() ?? "other";

const price = (model: string, at: number) => {
    const day = new Date(at).toISOString().slice(0, 10);
    const list = PRICES[model] ?? PRICES[FALLBACK] ?? [];
    return list.find(p => !p.until || day < p.until) ?? (list.at(-1) as Price);
};

export class Ledger {
    private readonly db: Database;

    constructor(dir: string) {
        this.db = new Database(join(dir, "chats.db"), { create: true });
        this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
        this.db.exec(SCHEMA);
    }

    record(model: string, usage: Usage, searches: number, tag = tagged()) {
        const at = Date.now();
        const month = new Date(at).toISOString().slice(0, 7);
        const p = price(model, at);
        const input = (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0);
        const cached = Math.min(input, usage.cachedContentTokenCount ?? 0);
        const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
        const used = searches ? this.searches(month) : 0;
        const paid = Math.max(0, searches - Math.max(0, SEARCH_FREE - used));
        const usd = ((input - cached) * p.input + cached * p.cached + output * p.output) / 1e6 + paid * SEARCH_PRICE;
        try {
            this.db
                .query("insert into spend (at, month, tag, model, input, cached, output, searches, usd) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .run(at, month, tag, model, input, cached, output, searches, usd);
        } catch (e) {
            console.error(`ledger: ${e instanceof Error ? e.message : String(e)}`);
        }
        return usd;
    }

    searches(month: string) {
        return (this.db.query("select coalesce(sum(searches), 0) n from spend where month = ?").get(month) as { n: number }).n;
    }

    spent(since: number, o: { tag?: string; prefix?: string; except?: string } = {}) {
        const where = ["at >= ?"];
        const args: (string | number)[] = [since];
        if (o.tag) {
            where.push("tag = ?");
            args.push(o.tag);
        }
        if (o.prefix) {
            where.push("tag like ?");
            args.push(`${o.prefix}%`);
        }
        if (o.except) {
            where.push("tag not like ?");
            args.push(`${o.except}%`);
        }
        return (this.db.query(`select coalesce(sum(usd), 0) usd from spend where ${where.join(" and ")}`).get(...args) as { usd: number }).usd;
    }

    report(since: number) {
        return this.db
            .query(
                "select tag, count(*) calls, sum(input) input, sum(output) output, sum(searches) searches, round(sum(usd), 4) usd from spend where at >= ? group by tag order by usd desc",
            )
            .all(since);
    }
}
