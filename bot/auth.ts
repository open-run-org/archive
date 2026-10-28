import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { loadEnv, userAgent } from "./src/env";

const file = process.argv[2];
if (!file) {
    console.error("usage: bun auth.ts <env file with REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET>");
    process.exit(2);
}
loadEnv(file);
const redirect = "http://127.0.0.1:8977/callback";
const state = randomBytes(16).toString("hex");
const scope = "identity read submit privatemessages history edit";
const basic = `Basic ${Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64")}`;

console.log(
    `https://www.reddit.com/api/v1/authorize?${new URLSearchParams({
        client_id: process.env.REDDIT_CLIENT_ID ?? "",
        response_type: "code",
        state,
        redirect_uri: redirect,
        duration: "permanent",
        scope,
    })}`,
);

const server = Bun.serve({
    port: 8977,
    hostname: "127.0.0.1",
    fetch: async req => {
        const url = new URL(req.url);
        if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
        const code = url.searchParams.get("code");
        if (url.searchParams.get("state") !== state || !code) return new Response(url.searchParams.get("error") ?? "bad request", { status: 400 });
        const r = await fetch("https://www.reddit.com/api/v1/access_token", {
            method: "POST",
            headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() },
            body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect }),
        });
        const token = (await r.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; scope?: string; error?: string };
        if (!token.refresh_token) {
            console.error(`token exchange failed: HTTP ${r.status} ${token.error ?? ""}`);
            setTimeout(() => process.exit(1), 100);
            return new Response("token exchange failed", { status: 500 });
        }
        const me = (await fetch("https://oauth.reddit.com/api/v1/me", {
            headers: { authorization: `bearer ${token.access_token}`, "user-agent": userAgent() },
        }).then(x => x.json())) as { name: string };
        const kept = readFileSync(file, "utf8")
            .split("\n")
            .filter(l => l && !l.startsWith("REDDIT_REFRESH_TOKEN=") && !l.startsWith("REDDIT_BOT_NAME="));
        writeFileSync(file, `${[...kept, `REDDIT_REFRESH_TOKEN=${token.refresh_token}`, `REDDIT_BOT_NAME=${me.name}`].join("\n")}\n`, { mode: 0o600 });
        console.log(`authorized as u/${me.name} (scope: ${token.scope})`);
        setTimeout(() => {
            server.stop();
            process.exit(0);
        }, 100);
        return new Response(`Authorized as u/${me.name}. You can close this tab.`, { headers: { "content-type": "text/plain; charset=utf-8" } });
    },
});
setTimeout(() => process.exit(3), 30 * 60 * 1000);
