import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CHAT_SYSTEM_PROMPT = `あなたは、ユーザーが日々感じた気づきや学びを言葉にするのを手伝う、聞き上手な対話相手です。
ユーザーの発言に対して、まず短く相槌や共感を示し、そのうえで「それはなぜだと思いますか」「具体的にはどんな場面でしたか」のように、本質を深掘りする質問を1つだけ返してください。
説教や一般論のアドバイスは避け、ユーザー自身の言葉で気づきが深まるように促してください。返答は3〜4文程度で簡潔にしてください。`;

const SUMMARIZE_SYSTEM_PROMPT = `これまでの対話全体を振り返り、ユーザーの気づき・学びを1件のデータベース記録としてまとめてください。
本文(content)はユーザー自身の言葉やニュアンスを尊重し、要約しすぎず自然な文章にしてください。
対話の内容が明確に「これからも続けたいこと」であれば tags に「続けたい」を、明確に「減らしたい・やめたいこと」であれば「減らしたい」を含めてください。どちらとも言えない場合は無理に付けないでください。
必ず save_entry ツールを呼び出して結果を返してください。`;

const SAVE_ENTRY_TOOL = {
  name: "save_entry",
  description: "対話から抽出した気づき・学びをデータベースに保存できる形式にまとめる",
  input_schema: {
    type: "object",
    properties: {
      entry_type: { type: "string", enum: ["insight", "learning"], description: "「気づき」か「学び」か" },
      title: { type: "string", description: "一言のタイトル" },
      content: { type: "string", description: "対話の内容をふまえた本文" },
      tags: { type: "array", items: { type: "string" }, description: "内容に関連するタグ。続けたいことなら'続けたい'、減らしたいことなら'減らしたい'を含めてよい" },
      source: { type: "string", description: "きっかけ。例: 'Claudeとの壁打ち'" },
    },
    required: ["entry_type", "title", "content"],
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function callClaude(payload: Record<string, unknown>) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(typeof data === "string" ? data : JSON.stringify(data));
  }
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured on this Edge Function" }, 500);
  }

  let body: { action?: string; messages?: { role: string; content: string }[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const { action, messages } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: "messages is required" }, 400);
  }

  try {
    if (action === "summarize") {
      // Claude Sonnet 5 requires the conversation to end with a user message
      // (assistant message prefill is not supported), so append a closing
      // instruction regardless of how the dialogue itself ended.
      const summarizeMessages = [
        ...messages,
        { role: "user", content: "ここまでの対話を振り返り、save_entryツールで気づき・学びとしてまとめてください。" },
      ];
      const data = await callClaude({
        model: MODEL,
        max_tokens: 1024,
        system: SUMMARIZE_SYSTEM_PROMPT,
        messages: summarizeMessages,
        tools: [SAVE_ENTRY_TOOL],
        tool_choice: { type: "tool", name: "save_entry" },
      });
      const toolUse = data.content?.find((b: { type: string }) => b.type === "tool_use");
      if (!toolUse) return jsonResponse({ error: "no structured result from Claude" }, 502);
      return jsonResponse({ entry: toolUse.input });
    }

    const data = await callClaude({
      model: MODEL,
      max_tokens: 512,
      system: CHAT_SYSTEM_PROMPT,
      messages,
    });
    const text = data.content?.find((b: { type: string }) => b.type === "text")?.text ?? "";
    return jsonResponse({ reply: text });
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 502);
  }
});
