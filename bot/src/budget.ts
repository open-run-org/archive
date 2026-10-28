const ZONE = "America/Los_Angeles";

const clock = () => {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-CA", {
            timeZone: ZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
        })
            .formatToParts(new Date())
            .map(p => [p.type, p.value]),
    );
    const elapsed = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
    return { day: `${parts.year}-${parts.month}-${parts.day}`, left: Math.max(60, 86400 - elapsed) };
};

export type BudgetState = {
    day: string;
    used: Record<string, number>;
    limits: Record<string, number>;
    known?: Record<string, number>;
    hit: Record<string, boolean>;
    credit: number;
    at: number;
    random: number;
    interactive?: number[];
};

export class Budget {
    readonly b: BudgetState;

    constructor(
        state: { budget?: BudgetState },
        private readonly defaults: Record<string, number>,
    ) {
        state.budget ??= { day: "", used: {}, limits: {}, hit: {}, credit: 0, at: 0, random: 0 };
        this.b = state.budget;
        this.roll();
    }

    roll() {
        const b = this.b;
        const { day } = clock();
        if (b.day !== day) {
            for (const [model, used] of Object.entries(b.used)) {
                const limit = this.limit(model);
                if (!b.hit[model] && used >= 0.9 * limit) b.limits[model] = Math.min(b.known?.[model] ?? Number.POSITIVE_INFINITY, Math.ceil(limit * 1.25));
            }
            Object.assign(b, { day, used: {}, hit: {}, credit: 0, random: 0 });
        }
        b.interactive = (b.interactive ?? []).filter(t => t > Date.now() - 86400000);
    }

    limit(model: string) {
        return this.b.limits[model] ?? this.defaults[model] ?? 100;
    }

    left(model: string) {
        this.roll();
        return this.limit(model) - (this.b.used[model] ?? 0);
    }

    spend(model: string) {
        this.b.used[model] = (this.b.used[model] ?? 0) + 1;
    }

    exhausted(model: string, limit: number) {
        const b = this.b;
        b.hit[model] = true;
        if (limit) b.known = { ...b.known, [model]: limit };
        b.limits[model] = Math.max(1, limit || b.used[model] || 0);
        b.used[model] = Math.max(b.used[model] ?? 0, b.limits[model] ?? 0);
    }

    interactive() {
        this.b.interactive?.push(Date.now());
    }

    randomCredit(model: string, perReply: number) {
        this.roll();
        const b = this.b;
        const now = Date.now();
        const dt = b.at ? Math.min(3600, (now - b.at) / 1000) : 0;
        b.at = now;
        const { left } = clock();
        const reserve = Math.ceil(((b.interactive?.length ?? 0) / 86400) * left * perReply) + 10;
        const replies = Math.max(0, (this.left(model) - reserve) / perReply);
        b.credit += (0.5 * replies * dt) / left;
        return Math.floor(b.credit);
    }

    useCredit() {
        this.b.credit = Math.max(0, this.b.credit - 1);
        this.b.random += 1;
    }

    randomToday() {
        this.roll();
        return this.b.random;
    }
}
