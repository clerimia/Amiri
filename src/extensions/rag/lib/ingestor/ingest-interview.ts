/**
 * ingest-interview -- 面试 tool 摄入脚本
 *
 * 全量重建 `interview` collection。素材源由 .env 显式指定：
 *   - BLOG_POSTS_DIR（含简历《关于我.md》）
 *   - KNOWLEDGES_DIR（题库）
 * 详细规格见 docs/rag-principles.md §1。
 */

import "dotenv/config";
import path from "node:path";
import { loadAndSplit, rebuildCollection } from "./ingest.js";
import { createArkEmbeddings, ARK_EMBEDDING_DIM } from "../ark-embeddings.js";
import { validateEnv } from "../env.js";
import { dictPathFor } from "../dict-paths.js";

const DEFAULT_QDRANT_URL = "http://localhost:6333";
const COLLECTION = "interview";

async function main() {
  validateEnv();
  const blogPostsDir = process.env.BLOG_POSTS_DIR;
  const knowledgesDirRaw = process.env.KNOWLEDGES_DIR;
  const missing: string[] = [];
  if (!blogPostsDir) missing.push("BLOG_POSTS_DIR");
  if (!knowledgesDirRaw) missing.push("KNOWLEDGES_DIR");
  if (missing.length > 0) {
    throw new Error(`缺少必填环境变量：${missing.join(", ")}。请在 .env 中配置。`);
  }
  const blogDir = path.resolve(blogPostsDir!);
  const knowledgesDir = path.resolve(knowledgesDirRaw!);
  const qdrantUrl = process.env.QDRANT_URL ?? DEFAULT_QDRANT_URL;
  const dictPath = dictPathFor(COLLECTION);

  console.log(`[ingest-interview] blog dir       = ${blogDir}`);
  console.log(`[ingest-interview] knowledges dir = ${knowledgesDir}`);
  console.log(`[ingest-interview] qdrant url     = ${qdrantUrl}`);
  console.log(`[ingest-interview] collection     = ${COLLECTION}`);
  console.log(`[ingest-interview] sparse dict    = ${dictPath}`);

  console.log(`[ingest-interview] loading + splitting...`);
  const docs = await loadAndSplit({
    sourceRoots: [blogDir, knowledgesDir],
    collectionName: COLLECTION,
  });
  console.log(`[ingest-interview]   -> ${docs.length} chunks`);

  if (docs.length === 0) {
    console.error(`[ingest-interview] no markdown found. abort.`);
    process.exit(1);
  }

  console.log(`[ingest-interview] embedding + upserting to Qdrant...`);
  const embeddings = createArkEmbeddings();
  const { points, dict } = await rebuildCollection(docs, embeddings, {
    url: qdrantUrl,
    collectionName: COLLECTION,
    vectorSize: ARK_EMBEDDING_DIM,
    dictPath,
  });
  console.log(
    `[ingest-interview] done. points_count=${points} sparse_terms=${Object.keys(dict.terms).length} avgdl=${dict.avgdl.toFixed(1)}`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
