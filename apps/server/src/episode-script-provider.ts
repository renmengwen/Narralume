import { limitedJson, responseText, type ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import type { GenerateEpisodeScript } from "./episode-script-generation-job.js";

export function createOpenAiEpisodeScriptGenerator(
  config: ChapterTextModelConfig,
  fetchImpl: typeof fetch = fetch,
): GenerateEpisodeScript {
  const endpoint = new URL("responses", `${config.baseUrl.replace(/\/+$/, "")}/`);
  return async (input) => {
    const instructions = input.stage === "skeleton"
      ? "生成按原文顺序排列的故事 beats。只能引用输入 sourceIndex，不得发明或重复来源。输出严格 JSON：{\"beats\":[{\"intent\":\"...\",\"sourceIndexes\":[0],\"targetDurationSeconds\":60}]}"
      : input.stage === "faithful"
        ? "只根据本 beat 提供的原文写忠实叙事段落，不添加事实。输出严格 JSON：{\"text\":\"...\"}"
        : "在不改变事实的前提下包装忠实稿，控制在字符预算内。每段只能引用输入已有 sourceIndexes。输出严格 JSON：{\"paragraphs\":[{\"text\":\"...\",\"sourceIndexes\":[0]}]}";
    const { signal, ...safeInput } = input;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      signal,
      redirect: "error",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        input: `${instructions}\n${JSON.stringify(safeInput)}`,
        text: { format: { type: "json_object" } },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`长稿生成模型请求失败（HTTP ${response.status}）`);
    }
    try {
      return JSON.parse(responseText(await limitedJson(response))) as Awaited<ReturnType<GenerateEpisodeScript>>;
    } catch (error) {
      if (error instanceof Error && /大小限制/u.test(error.message)) throw error;
      throw new Error("长稿生成模型返回了无效 JSON");
    }
  };
}
