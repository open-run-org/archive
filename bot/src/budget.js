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

export class Budget {
    constructor(state, defaults) {
        this.s = state;
        this.defaults = defaults;
        this.s.budget ??= { day: "", used: {}, limits: {}, hit: {}, credit: 0, at: 0, random: 0 };
        this.roll();
    }

    roll() {
        const b = this.s.budget;
        const { day } = clock();
        if (b.day !== day) {
            for (const [model, used] of Object.entries(b.used || {})) {
                const limit = this.limit(model);
                if (!b.hit?.[model] && used >= 0.9 * limit) b.limits[model] = Math.min(b.known?.[model] || Infinity, Math.ceil(limit * 1.25));
            }
            Object.assign(b, { day, used: {}, hit: {}, credit: 0, random: 0 });
        }
        b.interactive = (b.interactive || []).filter(t => t > Date.now() - 86400000);
    }

    limit(model) {
        return this.s.budget.limits[model] ?? this.defaults[model] ?? 100;
    }

    left(model) {
        this.roll();
        return this.limit(model) - (this.s.budget.used[model] || 0);
    }

    can(calls) {
        return Object.entries(calls).every(([model, n]) => this.left(model) >= n);
    }

    spend(model) {
        this.s.budget.used[model] = (this.s.budget.used[model] || 0) + 1;
    }

    exhausted(model, limit) {
        const b = this.s.budget;
        b.hit[model] = true;
        if (limit) b.known = { ...b.known, [model]: limit };
        b.limits[model] = Math.max(1, limit || b.used[model] || 0);
        b.used[model] = Math.max(b.used[model] || 0, b.limits[model]);
    }

    interactive() {
        this.s.budget.interactive.push(Date.now());
    }

    randomCredit(fast, main) {
        this.roll();
        const b = this.s.budget;
        const now = Date.now();
        const dt = b.at ? Math.min(3600, (now - b.at) / 1000) : 0;
        b.at = now;
        const { left } = clock();
        const reserve = Math.ceil((b.interactive.length / 86400) * left * 2) + 10;
        const both = Math.min(this.left(main), this.left(fast)) - reserve;
        const replies = Math.max(0, both > 0 ? both : Math.floor((this.left(fast) - reserve) / 2));
        b.credit += (0.5 * replies * dt) / left;
        return Math.floor(b.credit);
    }

    useCredit() {
        this.s.budget.credit = Math.max(0, this.s.budget.credit - 1);
        this.s.budget.random += 1;
    }

    randomToday() {
        this.roll();
        return this.s.budget.random;
    }
}
