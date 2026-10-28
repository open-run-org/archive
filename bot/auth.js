import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { loadEnv, userAgent } from "./src/env.js";

const file = process.argv[2];
if (!file) {
    console.error("usage: node auth.js <env file with REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET>");
    process.exit(2);
}
loadEnv(file);
const redirect = "http://127.0.0.1:8977/callback";
const state = randomBytes(16).toString("hex");
const scope = "identity read submit privatemessages history edit";
const auth = `Basic ${Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64")}`;

console.log(
    `https://www.reddit.com/api/v1/authorize?${new URLSearchParams({
        client_id: process.env.REDDIT_CLIENT_ID,
        response_type: "code",
        state,
        redirect_uri: redirect,
        duration: "permanent",
        scope,
    })}`,
);

const server = createServer(async (req, res) => {
    const url = new URL(req.url, redirect);
    if (url.pathname !== "/callback") return res.writeHead(404).end();
    if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
        return res.writeHead(400).end(url.searchParams.get("error") || "bad request");
    }
    const r = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent() },
        body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: redirect }),
    });
    const token = await r.json().catch(() => ({}));
    if (!token.refresh_token) {
        res.writeHead(500).end("token exchange failed");
        console.error(`token exchange failed: HTTP ${r.status} ${token.error || ""}`);
        process.exit(1);
    }
    const me = await fetch("https://oauth.reddit.com/api/v1/me", {
        headers: { authorization: `bearer ${token.access_token}`, "user-agent": userAgent() },
    }).then(x => x.json());
    const kept = readFileSync(file, "utf8")
        .split("\n")
        .filter(l => l && !l.startsWith("REDDIT_REFRESH_TOKEN=") && !l.startsWith("REDDIT_BOT_NAME="));
    writeFileSync(file, `${[...kept, `REDDIT_REFRESH_TOKEN=${token.refresh_token}`, `REDDIT_BOT_NAME=${me.name}`].join("\n")}\n`, { mode: 0o600 });
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(`Authorized as u/${me.name}. You can close this tab.`);
    console.log(`authorized as u/${me.name} (scope: ${token.scope})`);
    server.close();
    process.exit(0);
});
server.listen(8977, "127.0.0.1");
setTimeout(() => process.exit(3), 30 * 60 * 1000);
