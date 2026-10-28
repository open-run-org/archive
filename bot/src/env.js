import { readFileSync } from "node:fs";

export const loadEnv = file => {
    for (const line of readFileSync(file, "utf8").split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
    }
};

export const userAgent = () => process.env.REDDIT_USER_AGENT || "linux:open-run-archive-bot:0.1 (by /u/mofufu-bot)";
