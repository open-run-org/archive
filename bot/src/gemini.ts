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

export type Usage = {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
    cachedContentTokenCount?: number;
};

type Candidate = {
    content?: { parts?: Part[] };
    finishReason?: string;
    urlContextMetadata?: { urlMetadata?: { retrievedUrl: string; urlRetrievalStatus: string }[] };
    groundingMetadata?: {
        webSearchQueries?: string[];
        groundingChunks?: { web?: { uri?: string; title?: string } }[];
        groundingSupports?: { segment?: { text?: string }; groundingChunkIndices?: number[] }[];
    };
};

type Reply = {
    candidates?: Candidate[];
    usageMetadata?: Usage;
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

let meter: ((model: string, usage: Usage, searches: number) => void) | null = null;
export const setMeter = (fn: (model: string, usage: Usage, searches: number) => void) => {
    meter = fn;
};

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
    meter?.(model, body.usageMetadata ?? {}, body.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length ?? 0);
    return body;
};

const empty = (model: string, body: Reply) =>
    new Error(`${model}: empty response (${body.candidates?.[0]?.finishReason ?? body.promptFeedback?.blockReason ?? "unknown"})`);

const retrieved = (c: Candidate | undefined) => [
    ...new Set([
        ...(c?.content?.parts ?? []).flatMap(p => {
            const call = p.toolCall as { toolType?: string; args?: { urls?: string[] } } | undefined;
            return call?.toolType === "URL_CONTEXT" ? (call.args?.urls ?? []) : [];
        }),
        ...(c?.urlContextMetadata?.urlMetadata ?? []).filter(u => /SUCCESS/.test(u.urlRetrievalStatus)).map(u => u.retrievedUrl),
    ]),
];

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
    const text = textOf(body.candidates?.[0]?.content?.parts ?? []);
    if (!text) throw empty(model, body);
    return JSON.parse(text) as T;
};

export const write = async (model: string, o: { system: string; prompt: string; thinking?: Thinking; maxTokens?: number }) => {
    const body = await post(model, {
        systemInstruction: { parts: [{ text: o.system }] },
        contents: [{ role: "user", parts: [{ text: o.prompt }] }],
        generationConfig: { thinkingConfig: { thinkingLevel: o.thinking ?? "low" }, maxOutputTokens: o.maxTokens ?? 16384 },
    });
    const text = textOf(body.candidates?.[0]?.content?.parts ?? []);
    if (!text.trim()) throw empty(model, body);
    if (body.candidates?.[0]?.finishReason === "MAX_TOKENS") throw new Error(`${model}: cut off at the token limit`);
    return text.trim();
};

export type Turn = {
    content: Content;
    calls: Call[];
    text: string;
    urls: string[];
    queries: string[];
    sources: { uri: string; title: string }[];
    supports: { text: string; sources: number[] }[];
};

export const turn = async (
    model: string,
    o: { system: string; contents: Content[]; tools: Declaration[]; thinking?: Thinking; final?: boolean; search?: boolean },
): Promise<Turn> => {
    const body = await post(model, {
        systemInstruction: { parts: [{ text: o.system }] },
        contents: o.contents,
        tools: [{ functionDeclarations: o.tools }, ...(o.search ? [{ googleSearch: {} }] : []), { urlContext: {} }],
        toolConfig: { includeServerSideToolInvocations: true, functionCallingConfig: { mode: o.final ? "NONE" : "AUTO" } },
        generationConfig: { thinkingConfig: { thinkingLevel: o.thinking ?? "low" }, maxOutputTokens: 16384 },
    });
    const c = body.candidates?.[0];
    const parts = c?.content?.parts ?? [];
    if (!parts.length) throw empty(model, body);
    const g = c?.groundingMetadata ?? {};
    const calls = parts.flatMap(p => (p.functionCall ? [p.functionCall] : []));
    if (c?.finishReason === "MAX_TOKENS" && !calls.length) throw new Error(`${model}: cut off at the token limit`);
    return {
        content: { role: "model", parts },
        calls,
        text: textOf(parts),
        urls: retrieved(c),
        queries: g.webSearchQueries ?? [],
        sources: (g.groundingChunks ?? []).map(x => ({ uri: x.web?.uri ?? "", title: x.web?.title ?? "" })),
        supports: (g.groundingSupports ?? []).map(x => ({ text: x.segment?.text ?? "", sources: x.groundingChunkIndices ?? [] })),
    };
};
