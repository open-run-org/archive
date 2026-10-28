import { userAgent } from "./env";

const OAUTH = "https://oauth.reddit.com";

export type Thing = {
    kind: string;
    name: string;
    id: string;
    author: string;
    body?: string;
    title?: string;
    selftext?: string;
    url?: string;
    is_self?: boolean;
    subreddit: string;
    created_utc: number;
    parent_id?: string;
    link_id?: string;
    context?: string;
    type?: string;
    subject?: string;
    locked?: boolean;
    archived?: boolean;
    score?: number;
    removed_by_category?: string | null;
    replies?: Listing | "";
};
type Listing = { data?: { children?: { kind: string; data: Omit<Thing, "kind"> }[] } };

const kids = (listing: Listing | "" | undefined): Thing[] => (listing ? (listing.data?.children ?? []).map(c => ({ ...c.data, kind: c.kind }) as Thing) : []);

type Token = { value: string; until: number };

const token = async (body: Record<string, string>): Promise<Token> => {
    const auth = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64");
    const r = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() },
        body: new URLSearchParams(body),
    });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!j.access_token) throw new Error(`reddit token: HTTP ${r.status} ${j.error ?? ""}`);
    return { value: j.access_token, until: Date.now() + ((j.expires_in ?? 3600) - 120) * 1000 };
};

let user: Token | null = null;
let app: Token | null = null;

const call = async <T>(
    path: string,
    o: { method?: string; params?: Record<string, string>; form?: Record<string, string>; asApp?: boolean } = {},
): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
        if (o.asApp) {
            if (!app || Date.now() > app.until) app = await token({ grant_type: "client_credentials" });
        } else if (!user || Date.now() > user.until) {
            user = await token({ grant_type: "refresh_token", refresh_token: process.env.REDDIT_REFRESH_TOKEN ?? "" });
        }
        const t = (o.asApp ? app : user) as Token;
        const r = await fetch(`${OAUTH}${path}?${new URLSearchParams({ raw_json: "1", ...o.params })}`, {
            method: o.method ?? "GET",
            headers: {
                authorization: `bearer ${t.value}`,
                "user-agent": userAgent(),
                ...(o.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
            },
            body: o.form ? new URLSearchParams(o.form) : undefined,
        });
        if (r.status === 401 && attempt === 0) {
            if (o.asApp) app = null;
            else user = null;
            continue;
        }
        if ((r.status === 429 || r.status >= 500) && attempt < 3) {
            await Bun.sleep(Math.min(Number(r.headers.get("x-ratelimit-reset")) || 2 ** attempt * 10, 120) * 1000);
            continue;
        }
        if (!r.ok) throw new Error(`reddit ${o.method ?? "GET"} ${path}: HTTP ${r.status}`);
        return (await r.json()) as T;
    }
};

const errors = (r: { json?: { errors?: string[][] } }, what: string) => {
    const list = r.json?.errors ?? [];
    if (list.length) throw new Error(`reddit ${what}: ${list.map(e => e.join(" ")).join("; ")}`);
};

export const info = async (ids: string[]): Promise<Thing[]> => {
    const out: Thing[] = [];
    for (let i = 0; i < ids.length; i += 100)
        out.push(...kids(await call<Listing>("/api/info", { params: { id: ids.slice(i, i + 100).join(",") }, asApp: true })));
    return out;
};

export const inbox = async () => kids(await call<Listing>("/message/unread", { params: { limit: "100" } }));

export const markRead = async (names: string[]) => {
    if (names.length) await call("/api/read_message", { method: "POST", form: { id: names.join(",") } });
};

export const newPosts = async (subs: string, limit = 100) => kids(await call<Listing>(`/r/${subs}/new`, { params: { limit: String(limit) } }));

export type Thread = { post: Thing; chain: Thing[]; target: Thing };

export const thread = async (postId: string, commentId: string, fallback?: Thing): Promise<Thread | null> => {
    const params: Record<string, string> = commentId ? { comment: commentId, context: "8", depth: "1", limit: "20" } : { depth: "1", limit: "1" };
    const [posts, comments] = await call<[Listing, Listing]>(`/comments/${postId}`, { params });
    const post = kids(posts)[0];
    if (!post) return null;
    if (!commentId) return { post, chain: [], target: post };
    const all = new Map<string, Thing>();
    const walk = (items: Thing[]) => {
        for (const c of items) {
            if (c.kind !== "t1") continue;
            all.set(c.name, c);
            walk(kids(c.replies));
        }
    };
    walk(kids(comments));
    const target = all.get(`t1_${commentId}`);
    if (!target && fallback?.body) {
        const up = fallback.parent_id?.startsWith("t1_") ? await thread(postId, fallback.parent_id.slice(3)) : null;
        return { post, chain: up ? [...up.chain, up.target] : [], target: fallback };
    }
    if (!target) return null;
    const chain: Thing[] = [];
    for (let p = all.get(target.parent_id ?? ""); p; p = all.get(p.parent_id ?? "")) chain.unshift(p);
    return { post, chain, target };
};

export const reply = async (parent: string, text: string) => {
    const r = await call<{ json?: { errors?: string[][]; data?: { things?: { data?: { name?: string } }[] } } }>("/api/comment", {
        method: "POST",
        form: { api_type: "json", thing_id: parent, text },
    });
    errors(r, "comment");
    return r.json?.data?.things?.[0]?.data?.name ?? "";
};

export const edit = async (thing: string, text: string) => {
    errors(await call("/api/editusertext", { method: "POST", form: { api_type: "json", thing_id: thing, text } }), "edit");
};
