type Message = { from: string; to: string; raw: ReadableStream; rawSize: number };
type Env = { API: string; SECRET: string };

export default {
    async email(message: Message, env: Env) {
        const r = await fetch(env.API, {
            method: "POST",
            headers: {
                "content-type": "message/rfc822",
                "x-mail-secret": env.SECRET,
                "x-envelope-from": message.from,
                "x-envelope-to": message.to,
            },
            body: await new Response(message.raw).arrayBuffer(),
        });
        if (!r.ok) throw new Error(`Mofufu mail API answered HTTP ${r.status}`);
    },
};
