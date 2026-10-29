// ============================================================
// Vercel 无服务器函数：流式 AI 起名
// - 调用 SiliconFlow（OpenAI 兼容接口）做流式生成
// - 把增量文本实时透传给前端（text/plain 流）
// - 流结束后把「需求 / 名字方案 / 使用模型」写入 Supabase
// - 所有密钥均从环境变量读取，未写死
// ============================================================

import { createClient } from "@supabase/supabase-js";

const SILICONFLOW_API_URL = "https://api.siliconflow.cn/v1/chat/completions";

export default async function handler(req, res) {
  // ---------- CORS（本地开发 / 跨域调试用）----------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "仅支持 POST" });
    return;
  }

  // ---------- 读取密钥（来自环境变量，未写死）----------
  const apiKey = process.env.SILICONFLOW_API_KEY;
  const model = process.env.SILICONFLOW_MODEL || "deepseek-ai/DeepSeek-V3";
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!apiKey) {
    res.status(500).json({ error: "缺少环境变量 SILICONFLOW_API_KEY，请在 Vercel 中配置" });
    return;
  }

  // ---------- 解析前端提交的用户需求 ----------
  let body;
  try {
    body = JSON.parse(await readRequestBody(req));
  } catch (e) {
    res.status(400).json({ error: "请求体不是合法 JSON" });
    return;
  }
  const requirement = (body && typeof body.requirement === "string" ? body.requirement : "").trim();
  if (!requirement) {
    res.status(400).json({ error: "请填写起名需求" });
    return;
  }

  // ---------- 构造起名提示词（要求输出结构化 JSON 数组）----------
  const systemPrompt = `你是资深起名顾问，精通中文取名文化、五行、音韵与寓意。
根据用户的需求给出 3~5 个名字方案，每个名字都要有贴切的寓意解释。
只输出一个合法的 JSON 数组，不要输出任何其他文字或 Markdown 代码块。
格式严格如下：
[{"name":"名字","meaning":"寓意解释，50字以内"},{"name":"名字","meaning":"寓意解释"}]`;

  const userPrompt = `请根据以下需求起名：${requirement}`;

  // ---------- 请求 SiliconFlow（开启流式）----------
  let upstream;
  try {
    upstream = await fetch(SILICONFLOW_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.8,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch (e) {
    res.status(502).json({ error: "无法连接 SiliconFlow：" + e.message });
    return;
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    console.error("SiliconFlow 报错", upstream.status, errText);
    res.status(502).json({ error: `SiliconFlow 接口返回 ${upstream.status}` });
    return;
  }

  // ---------- 逐块读取 SSE 流，把增量内容透传给前端 ----------
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.status(200);
  res.flushHeaders?.();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";      // SSE 行缓冲
  let rawText = "";     // 累积的纯文本（用于保存到 Supabase）

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 按行解析：data: {...} / data: [DONE]
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        try {
          const chunk = JSON.parse(payload);
          const delta = chunk?.choices?.[0]?.delta?.content || "";
          if (delta) {
            rawText += delta;
            res.write(delta); // 实时推给浏览器
          }
        } catch (_) {
          /* 忽略不完整/非 JSON 的中间行 */
        }
      }
    }
  } catch (e) {
    console.error("读取流失败", e);
  }

  // ---------- 流结束：把结果保存到 Supabase（await 后再 end，防止无服务器函数被冻结）----------
  if (supabaseUrl && supabaseKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const resultJson = parseResultJson(rawText);
      const { error } = await supabase.from("name_generations").insert({
        requirement,
        model,
        result_json: resultJson,
        raw_text: rawText,
      });
      if (error) console.error("Supabase 写入失败", error.message);
    } catch (e) {
      console.error("Supabase 写入异常", e);
    }
  } else {
    console.warn("未配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，跳过保存");
  }

  res.end();
}

// ---------- 工具函数 ----------

// 读取请求体（Node IncomingMessage 需要手动拼接）
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 从模型输出的流式文本里提取 JSON 数组（兼容代码块包裹 / 前后多余文字）
function parseResultJson(rawText) {
  if (!rawText) return null;
  let text = rawText.trim();

  // 尝试去掉 ```json ... ``` 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1].trim();

  // 直接解析
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) { /* 继续尝试 */ }

  // 截取第一个 [ 到最后一个 ]
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) { /* 无法解析 */ }
  }
  return null;
}
