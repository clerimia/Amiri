/**
 * env -- 环境变量校验
 *
 * 集中各实现 ticket（#7 摄入 / #8 检索）读取的环境变量，必填项缺失时一次性报全。
 * 选填项在各读取处自行 fallback（见 ark-embeddings.ts / rag-retrieve.ts / ingest 脚本），
 * 这里不重复默认值逻辑，只列"必填"清单。
 *
 * 不引 schema 库：校验逻辑只有"必填键在不在 + 非空"，手写比 typebox/zod 更直白，
 * 也避免 lib 层引入 pi runtime 注入的 typebox（tsx 跑的 ingest 脚本碰不到）。
 */

/** 必填 env 清单。键缺失或空字符串都视为未配置。 */
const REQUIRED_ENV = [
  "ARK_API_KEY",
  "ARK_EMBEDDING_MODEL",
] as const;

/**
 * 校验必填 env。在 ingest 脚本入口、retrieve 首次调用时执行。
 *
 * 缺失时一次性收集所有缺失项抛出，而不是逐个报错--让用户一次补全。
 * 选填项（ARK_EMBEDDING_URL / ARK_BASE_URL / ARK_EMBEDDING_DIM /
 * QDRANT_URL / BLOG_POSTS_DIR）有各自默认，不在这里校验。
 */
export function validateEnv(): void {
  const missing = REQUIRED_ENV.filter((key) => {
    const val = process.env[key];
    return val === undefined || val.trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(
      `缺少必填环境变量：${missing.join(", ")}。请参考 .env.example 配置。`
    );
  }
}
