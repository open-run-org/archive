const API = "https://generativelanguage.googleapis.com/v1beta/models";
const SAFETY = ["HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT", "DANGEROUS_CONTENT"].map(c => ({
    category: `HARM_CATEGORY_${c}`,
    threshold: "OFF",
}));

export type Call = { name: string; args?: Record<string, unknown>; id?: string };
export type Part = {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    functionCall?: Call;
    functionResponse?: { name: string; id?: string; response: unknown };
    [key: string]: unknown;
};
export type Content = { role: "user" | "model"; parts: Part[] };
export type Declaration = { name: string; description: string; parameters: Record<string, unknown> };
export type Thinking = "minimal" | "low" | "medium" | "high";

type Reply = {
    candidates?: {
        content?: { parts?: Part[] };
        finishReason?: string;
        urlContextMetadata?: { urlMetadata?: { retrievedUrl: string; urlRetrievalStatus: string }[] };
    }[];
    promptFeedback?: { blockReason?: string };
    error?: { message?: string; details?: { violations?: { quotaId?: string; quotaValue?: string }[]; retryDelay?: string }[] };
};

export class QuotaError extends Error {
    constructor(
        message: string,
        readonly model: string,
        readonly daily: boolean,
        readonly limit: number,
    ) {
        super(message);
    }
}

const gap: Record<string, number> = {};
const next: Record<string, number> = {};

const pace = async (model: string) => {
    const at = next[model] ?? 0;
    next[model] = Math.max(Date.now(), at) + (gap[model] ?? 4000);
    if (at > Date.now()) await Bun.sleep(at - Date.now());
};

const quota = (model: string, body: Reply) => {
    const details = body.error?.details ?? [];
    const v = details.flatMap(d => d.violations ?? []).find(x => x.quotaId);
    const daily = /PerDay/i.test(v?.quotaId ?? "");
    const limit = Number(v?.quotaValue) || 0;
    if (!daily && limit) gap[model] = Math.ceil(60000 / limit) + 500;
    return new QuotaError(`${model}: ${v?.quotaId ?? body.error?.message ?? "quota exhausted"}`, model, daily, limit);
};

const post = async (model: string, request: Record<string, unknown>): Promise<Reply> => {
    await pace(model);
    const r = await fetch(`${API}/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "", "content-type": "application/json" },
        body: JSON.stringify({ ...request, safetySettings: SAFETY }),
    });
    const body = (await r.json().catch(() => ({}))) as Reply;
    if (r.status === 429) throw quota(model, body);
    if (!r.ok) throw new Error(`${model}: HTTP ${r.status} ${body.error?.message ?? ""}`);
    return body;
};

const textOf = (parts: Part[]) =>
    parts
        .filter(p => p.text && !p.thought)
        .map(p => p.text)
        .join("");

export const generate = async <T>(
    model: string,
    o: { system: string; prompt: string; schema: Record<string, unknown>; thinking?: Thinking; maxTokens?: number },
): Promise<T> => {
    const body = await post(model, {
        systemInstruction: { parts: [{ text: o.system }] },
        contents: [{ role: "user", parts: [{ text: o.prompt }] }],
        generationConfig: {
            thinkingConfig: { thinkingLevel: o.thinking ?? "low" },
            maxOutputTokens: o.maxTokens ?? 4096,
            responseMimeType: "application/json",
            responseSchema: o.schema,
        },
    });
    const c = body.candidates?.[0];
    const text = textOf(c?.content?.parts ?? []);
    if (!text) throw new Error(`${model}: empty response (${c?.finishReason ?? body.promptFeedback?.blockReason ?? "unknown"})`);
    return JSON.parse(text) as T;
};

export type Turn = { content: Content; calls: Call[]; text: string; urls: string[] };

export const turn = async (
    model: string,
    o: { system: string; contents: Content[]; tools: Declaration[]; thinking?: Thinking; final?: boolean },
): Promise<Turn> => {
    const body = await post(model, {
        systemInstruction: { parts: [{ text: o.system }] },
        contents: o.contents,
        tools: [{ functionDeclarations: o.tools }, { urlContext: {} }],
        toolConfig: { includeServerSideToolInvocations: true, functionCallingConfig: { mode: o.final ? "NONE" : "AUTO" } },
        generationConfig: { thinkingConfig: { thinkingLevel: o.thinking ?? "low" }, maxOutputTokens: 8192 },
    });
    const c = body.candidates?.[0];
    const parts = c?.content?.parts ?? [];
    if (!parts.length) throw new Error(`${model}: empty response (${c?.finishReason ?? body.promptFeedback?.blockReason ?? "unknown"})`);
    return {
        content: { role: "model", parts },
        calls: parts.flatMap(p => (p.functionCall ? [p.functionCall] : [])),
        text: textOf(parts),
        urls: [
            ...new Set([
                ...parts.flatMap(p => {
                    const call = p.toolCall as { toolType?: string; args?: { urls?: string[] } } | undefined;
                    return call?.toolType === "URL_CONTEXT" ? (call.args?.urls ?? []) : [];
                }),
                ...(c?.urlContextMetadata?.urlMetadata ?? []).filter(u => /SUCCESS/.test(u.urlRetrievalStatus)).map(u => u.retrievedUrl),
            ]),
        ],
    };
};
