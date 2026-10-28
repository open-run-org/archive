const API = "https://generativelanguage.googleapis.com/v1beta/models";
const SAFETY = ["HARASSMENT", "HATE_SPEECH", "SEXUALLY_EXPLICIT", "DANGEROUS_CONTENT"].map(c => ({
    category: `HARM_CATEGORY_${c}`,
    threshold: "OFF",
}));

export class QuotaError extends Error {}

const gap = {};
const next = {};

const wait = async model => {
    const at = next[model] || 0;
    next[model] = Math.max(Date.now(), at) + (gap[model] ?? 4000);
    if (at > Date.now()) await new Promise(ok => setTimeout(ok, at - Date.now()));
};

const quota = (model, body) => {
    const details = body.error?.details || [];
    const v = details.flatMap(d => d.violations || []).find(x => x.quotaId);
    const retry = parseFloat(details.find(d => d.retryDelay)?.retryDelay || "") || 60;
    const daily = /PerDay/i.test(v?.quotaId || "");
    const limit = Number(v?.quotaValue) || 0;
    if (!daily && limit) gap[model] = Math.ceil(60000 / limit) + 500;
    return Object.assign(new QuotaError(`${model}: ${v?.quotaId || body.error?.message || "quota exhausted"}`), { model, daily, limit, retry });
};

export const generate = async (model, { system, prompt, schema, thinking = "low", maxTokens = 4096 }) => {
    await wait(model);
    const r = await fetch(`${API}/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY || "", "content-type": "application/json" },
        body: JSON.stringify({
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                thinkingConfig: { thinkingLevel: thinking },
                maxOutputTokens: maxTokens,
                ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
            },
            safetySettings: SAFETY,
        }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 429) throw quota(model, body);
    if (!r.ok) throw new Error(`${model}: HTTP ${r.status} ${body.error?.message || ""}`);
    const c = body.candidates?.[0];
    const text = (c?.content?.parts || [])
        .filter(p => !p.thought)
        .map(p => p.text || "")
        .join("");
    if (!text) throw new Error(`${model}: empty response (${c?.finishReason || body.promptFeedback?.blockReason || "unknown"})`);
    return schema ? JSON.parse(text) : text;
};
