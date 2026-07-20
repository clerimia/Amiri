/**
 * ingest-blog -- 博客 tool 摄入脚本
 *
 * 全量重建 `blog` collection。素材源由 BLOG_POSTS_DIR（.env）显式指定，无默认。
 * 详细规格见 docs/rag-principles.md §1（摄入链路）。
 *
 * 用法：npm run ingest:blog（在 src/extensions/rag 下跑，读该目录 .env）
 */

import "dotenv/config";
import path from "node:path";
import { loadAndSplit, rebuildCollection } from "./ingest.js";
import { createArkEmbeddings, ARK_EMBEDDING_DIM } from "../ark-embeddings.js";
import { validateEnv } from "../env.js";
import { dictPathFor } from "../dict-paths.js";

const DEFAULT_QDRANT_URL = "http://localhost:6333";
const COLLECTION = "blog";

async function main() {
  validateEnv();
  const blogPostsDir = process.env.BLOG_POSTS_DIR;
  if (!blogPostsDir) {
    throw new Error("BLOG_POSTS_DIR 未设置。请在 .env 中配置博客文章源目录。");
  }
  const blogDir = path.resolve(blogPostsDir);
  const qdrantUrl = process.env.QDRANT_URL ?? DEFAULT_QDRANT_URL;
  const dictPath = dictPathFor(COLLECTION);

  console.log(`[ingest-blog] blog dir      = ${blogDir}`);
  console.log(`[ingest-blog] qdrant url    = ${qdrantUrl}`);
  console.log(`[ingest-blog] collection    = ${COLLECTION}`);
  console.log(`[ingest-blog] sparse dict   = ${dictPath}`);

  console.log(`[ingest-blog] loading + splitting...`);
  const docs = await loadAndSplit({
    sourceRoots: [blogDir],
    collectionName: COLLECTION,
  });
  console.log(`[ingest-blog]   -> ${docs.length} chunks`);

  if (docs.length === 0) {
    console.error(`[ingest-blog] no markdown found under ${blogDir}. abort.`);
    process.exit(1);
  }

  console.log(`[ingest-blog] embedding + upserting to Qdrant...`);
  const embeddings = createArkEmbeddings();
  const { points, dict } = await rebuildCollection(docs, embeddings, {
    url: qdrantUrl,
    collectionName: COLLECTION,
    vectorSize: ARK_EMBEDDING_DIM,
    dictPath,
  });
  console.log(
    `[ingest-blog] done. points_count=${points} sparse_terms=${Object.keys(dict.terms).length} avgdl=${dict.avgdl.toFixed(1)}`
  );
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
