const CLOUDFLARE = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
];

const four = (ip: string) => {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let value = 0n;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
        value = (value << 8n) | BigInt(part);
    }
    return value;
};

const six = (ip: string) => {
    const halves = ip.split("::");
    if (halves.length > 2) return null;
    const words = (half: string) => (half === "" ? [] : half.split(":"));
    const head = words(halves[0] ?? "");
    const tail = words(halves[1] ?? "");
    const missing = 8 - head.length - tail.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    let value = 0n;
    for (const word of [...head, ...Array<string>(missing).fill("0"), ...tail]) {
        if (!/^[0-9a-f]{1,4}$/i.test(word)) return null;
        value = (value << 16n) | BigInt(Number.parseInt(word, 16));
    }
    return value;
};

const RESERVED = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/3",
    "::/127",
    "::ffff:0:0/96",
    "64:ff9b::/96",
    "100::/64",
    "2001:db8::/32",
    "2002::/16",
    "fc00::/7",
    "fe80::/10",
    "ff00::/8",
];

const parse = (ip: string) => {
    const plain = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? ip;
    const wide = plain.includes(":");
    const value = wide ? six(plain) : four(plain);
    return value === null ? null : { wide, value };
};

const blocks = (ranges: string[]) =>
    ranges.map(range => {
        const [base = "", size = "0"] = range.split("/");
        const wide = base.includes(":");
        return { wide, bits: wide ? 128n : 32n, size: BigInt(size), base: (wide ? six(base) : four(base)) ?? 0n };
    });

const hit = (list: ReturnType<typeof blocks>, ip: { wide: boolean; value: bigint }) =>
    list.some(b => b.wide === ip.wide && ip.value >> (b.bits - b.size) === b.base >> (b.bits - b.size));

const EDGE = blocks(CLOUDFLARE);
const LOCAL = blocks(RESERVED);

const cloudflare = (ip: string) => {
    const p = parse(ip);
    return p !== null && hit(EDGE, p);
};

export const reserved = (ip: string) => {
    const p = parse(ip);
    return p === null || hit(LOCAL, p);
};

const PRIVATE = /^(?:::ffff:)?(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)|^(?:::1|f[cd][0-9a-f]{2}:)/i;

export const client = (req: Request, peer: string) => {
    const hop = PRIVATE.test(peer) ? req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() : undefined;
    const edge = hop || peer;
    return (cloudflare(edge) && req.headers.get("cf-connecting-ip")?.trim()) || edge;
};

export const FREE = 2;

export type LimitState = { day: string; ips: Record<string, number[]> };
export type Status = { ok: boolean; used: number; until: number; span: number; reset: number };

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const midnight = (at: number) => Date.parse(`${day(at)}T00:00:00Z`) + 86400000;

export class Limiter {
    constructor(
        private readonly s: { limits?: LimitState },
        private readonly base: number,
    ) {}

    private times(ip: string, now: number) {
        if (this.s.limits?.day !== day(now)) this.s.limits = { day: day(now), ips: {} };
        const ips = this.s.limits.ips;
        let t = ips[ip];
        if (!t) {
            t = [];
            ips[ip] = t;
        }
        return t;
    }

    pause(n: number) {
        return n < FREE ? 0 : this.base * 2 ** (n - FREE);
    }

    status(ip: string, now = Date.now()): Status {
        const t = this.times(ip, now);
        const reset = midnight(now);
        const last = t.at(-1);
        const span = this.pause(t.length);
        const until = last === undefined || !span ? 0 : Math.min(last + span * 1000, reset);
        return { ok: until <= now, used: t.length, until: until > now ? until : 0, span, reset };
    }

    peek(ip: string, now = Date.now()): Status {
        const used = this.times(ip, now).length + 1;
        const reset = midnight(now);
        const span = this.pause(used);
        const until = span ? Math.min(now + span * 1000, reset) : 0;
        return { ok: until <= now, used, until: until > now ? until : 0, span, reset };
    }

    take(ip: string, now = Date.now()) {
        this.times(ip, now).push(now);
        return this.status(ip, now);
    }
}
