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
これは確認なしにそのまま保存されるため、対話の内容を漏れなく反映してください。
必ず save_entry ツールを呼び出して結果を返してください。`;

const REFLECT_SYSTEM_PROMPT = `以下は、ユーザーがこれまでに記録した「気づき」「学び」の一覧です（日付・種類・タイトル・本文・タグ）。
これらに繰り返し現れる価値観、大切にしていること、判断や行動の軸になっていそうなものを見つけ出してください。
一般論やありきたりな性格診断ではなく、実際の記録の言葉や具体的なエピソードに基づいた洞察を書いてください。
「〜な人ですね」と決めつけるのではなく、記録から読み取れる傾向を、ユーザー自身が読んで自分を思い出せるような、あたたかく具体的な文章でまとめてください。
必ず save_axis ツールを呼び出して結果を返してください。`;

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

const SAVE_AXIS_TOOL = {
  name: "save_axis",
  description: "蓄積された記録から、ユーザーの価値観・大切にしていることを1件の振り返りとしてまとめる",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "軸を一言で表すタイトル" },
      content: { type: "string", description: "記録に基づいた具体的な振り返り文章" },
    },
    required: ["title", "content"],
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

function extractToolInput(data: { content?: { type: string }[] }) {
  const toolUse = data.content?.find((b: { type: string }) => b.type === "tool_use");
  return toolUse ? (toolUse as unknown as { input: unknown }).input : null;
}

type ChatMessage = { role: string; content: string };
type EntrySummary = { created_at?: string; entry_type?: string; title?: string; content?: string; tags?: string[] };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured on this Edge Function" }, 500);
  }

  let body: { action?: string; messages?: ChatMessage[]; entries?: EntrySummary[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const { action } = body;

  try {
    if (action === "reflect") {
      const entries = body.entries;
      if (!Array.isArray(entries) || entries.length === 0) {
        return jsonResponse({ error: "entries is required" }, 400);
      }
      const entriesText = entries
        .map((e) => `[${e.created_at ?? ""}] (${e.entry_type ?? ""}) ${e.title ?? ""}\n${e.content ?? ""}\nタグ: ${(e.tags || []).join(", ")}`)
        .join("\n\n---\n\n");

      const data = await callClaude({
        model: MODEL,
        max_tokens: 1024,
        system: REFLECT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: entriesText }],
        tools: [SAVE_AXIS_TOOL],
        tool_choice: { type: "tool", name: "save_axis" },
      });
      const input = extractToolInput(data);
      if (!input) return jsonResponse({ error: "no structured result from Claude" }, 502);
      return jsonResponse({ axis: input });
    }

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return jsonResponse({ error: "messages is required" }, 400);
    }

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
      const input = extractToolInput(data);
      if (!input) return jsonResponse({ error: "no structured result from Claude" }, 502);
      return jsonResponse({ entry: input });
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
