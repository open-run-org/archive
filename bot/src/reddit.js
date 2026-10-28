import { userAgent } from "./env.js";

const OAUTH = "https://oauth.reddit.com";
let token = null;

const refresh = async () => {
    const auth = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64");
    const r = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: process.env.REDDIT_REFRESH_TOKEN || "" }),
    });
    const body = await r.json().catch(() => ({}));
    if (!body.access_token) throw new Error(`reddit token: HTTP ${r.status} ${body.error || ""}`);
    token = { value: body.access_token, until: Date.now() + (body.expires_in - 120) * 1000 };
};

const call = async (path, { method = "GET", params, form } = {}) => {
    for (let attempt = 0; ; attempt++) {
        if (!token || Date.now() > token.until) await refresh();
        const url = `${OAUTH}${path}${params ? `?${new URLSearchParams({ raw_json: "1", ...params })}` : "?raw_json=1"}`;
        const r = await fetch(url, {
            method,
            headers: {
                authorization: `bearer ${token.value}`,
                "user-agent": userAgent(),
                ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
            },
            body: form ? new URLSearchParams(form) : undefined,
        });
        if (r.status === 401 && attempt === 0) {
            token = null;
            continue;
        }
        if ((r.status === 429 || r.status >= 500) && attempt < 3) {
            const wait = Number(r.headers.get("x-ratelimit-reset")) || 2 ** attempt * 10;
            await new Promise(ok => setTimeout(ok, Math.min(wait, 120) * 1000));
            continue;
        }
        if (!r.ok) throw new Error(`reddit ${method} ${path}: HTTP ${r.status}`);
        return r.json();
    }
};

const kids = listing => (listing?.data?.children || []).map(c => ({ kind: c.kind, ...c.data }));

let appToken = null;

export const info = async ids => {
    if (!ids.length) return [];
    if (!appToken || Date.now() > appToken.until) {
        const auth = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64");
        const r = await fetch("https://www.reddit.com/api/v1/access_token", {
            method: "POST",
            headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() },
            body: new URLSearchParams({ grant_type: "client_credentials" }),
        });
        const body = await r.json().catch(() => ({}));
        if (!body.access_token) throw new Error(`reddit app token: HTTP ${r.status}`);
        appToken = { value: body.access_token, until: Date.now() + (body.expires_in - 120) * 1000 };
    }
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
        const r = await fetch(`${OAUTH}/api/info?raw_json=1&id=${ids.slice(i, i + 100).join(",")}`, {
            headers: { authorization: `bearer ${appToken.value}`, "user-agent": userAgent() },
        });
        if (!r.ok) throw new Error(`reddit info: HTTP ${r.status}`);
        out.push(...kids(await r.json()));
    }
    return out;
};

export const inbox = () => call("/message/unread", { params: { limit: "100" } }).then(kids);

export const markRead = names => (names.length ? call("/api/read_message", { method: "POST", form: { id: names.join(",") } }) : null);

export const newPosts = (sub, limit = 50) => call(`/r/${sub}/new`, { params: { limit: String(limit) } }).then(kids);

export const newComments = sub => call(`/r/${sub}/comments`, { params: { limit: "100" } }).then(kids);

export const myComments = name => call(`/user/${name}/comments`, { params: { limit: "100", sort: "new" } }).then(kids);

export const thread = async (postId, commentId, fallback) => {
    const params = commentId ? { comment: commentId, context: "8", depth: "1", limit: "20" } : { depth: "1", limit: "1" };
    const [posts, comments] = await call(`/comments/${postId}`, { params });
    const post = kids(posts)[0];
    if (!commentId) return { post, chain: [], target: post };
    const all = new Map();
    const walk = items => {
        for (const c of items) {
            if (c.kind !== "t1") continue;
            all.set(c.name, c);
            if (c.replies) walk(kids(c.replies));
        }
    };
    walk(kids(comments));
    const target = all.get(`t1_${commentId}`);
    if (!target && fallback?.body) {
        const up = fallback.parent_id?.startsWith("t1_") ? await thread(postId, fallback.parent_id.slice(3)) : null;
        return { post, chain: up?.target ? [...up.chain, up.target] : [], target: fallback };
    }
    if (!target) return null;
    const chain = [];
    for (let p = all.get(target.parent_id); p; p = all.get(p.parent_id)) chain.unshift(p);
    return { post, chain, target };
};

export const edit = async (thing, text) => {
    const r = await call("/api/editusertext", { method: "POST", form: { api_type: "json", thing_id: thing, text } });
    const errors = r?.json?.errors || [];
    if (errors.length) throw new Error(`reddit edit: ${errors.map(e => e.join(" ")).join("; ")}`);
};

export const reply = async (parent, text) => {
    const r = await call("/api/comment", { method: "POST", form: { api_type: "json", thing_id: parent, text } });
    const errors = r?.json?.errors || [];
    if (errors.length) throw new Error(`reddit comment: ${errors.map(e => e.join(" ")).join("; ")}`);
    return r?.json?.data?.things?.[0]?.data?.name || "";
};
