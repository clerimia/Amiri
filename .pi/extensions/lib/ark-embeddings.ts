/**
 * ark-embeddings -- Ark 豆包 embedding 适配器
 *
 * 见 docs/rag-principles.md §2.1：Ark 豆包 `doubao-embedding-vision`（2048 维），
 * 走 OpenAI 兼容接口。langchain.ts 的 OpenAIEmbeddings 支持自定义 baseURL + apiKey。
 *
 * 之所以放在 lib/：摄入脚本（#7）和检索链路（#8）都要用，是跨环节共享薄封装。
 * env 校验汇总 ticket（#9）落地后可以从这里替换成 zod 校验版本。
 */

import { OpenAIEmbeddings } from "@langchain/openai";

/**
 * 豆包 embedding 维度。
 *
 * 见 docs/rag-principles.md §2.1（原写 1024 维）。**衍生事实**：
 * `doubao-embedding-vision` 实际返回 2048 维（多模态视觉模型返回向量本就更长），
 * 只有 `doubao-embedding-text` 系列才是 1024。为避免下一个人再踩坑，让
 * `.env` 提供 `ARK_EMBEDDING_DIM`，本常量退化为兜底默认。
 *
 * collection 建集合时用它设 Qdrant 向量维度；填错会 400 Wrong input。
 */
export const ARK_EMBEDDING_DIM = Number(process.env.ARK_EMBEDDING_DIM ?? 2048);

export const DEFAULT_ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";

/**
 * 创建 Ark 豆包 embedding 客户端（走 OpenAI 兼容协议）。
 *
 * env 契约：
 *   - ARK_API_KEY         必填
 *   - ARK_EMBEDDING_MODEL 必填。可以是 Ark 模型名（如 doubao-embedding-vision）
 *                         或接入点 ID（ep-xxxxxxxxxxxxxx），Ark 侧都吃
 *   - ARK_EMBEDDING_URL   OpenAI SDK 的 baseURL；应指向包含 `/v3` 的路径
 *                         （SDK 会自动拼 `/embeddings`）。优先读它
 *   - ARK_BASE_URL        兼容旧变量；仅当 ARK_EMBEDDING_URL 未设时使用
 */
export function createArkEmbeddings(): OpenAIEmbeddings {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) {
    throw new Error("ARK_API_KEY 未设置。请在 .env 中配置 Ark API key。");
  }
  const model = process.env.ARK_EMBEDDING_MODEL;
  if (!model) {
    throw new Error(
      "ARK_EMBEDDING_MODEL 未设置。请在 .env 中配置 Ark 模型名或接入点 ID。"
    );
  }
  const baseURL =
    process.env.ARK_EMBEDDING_URL ??
    process.env.ARK_BASE_URL ??
    DEFAULT_ARK_BASE;
  return new OpenAIEmbeddings({
    apiKey,
    model,
    configuration: { baseURL },
    // Ark embedding API 每请求最多 10 个 input；OpenAI 默认 512 会 400 BadRequest。
    batchSize: 10,
    // Ark 账户级 QPS 有限，14 个 batch 并发会 429；串行更稳。
    // 见 tail 错误 MODEL_RATE_LIMIT / AccountRateLimitExceeded。
    maxConcurrency: 1,
    maxRetries: 6,
  });
}
