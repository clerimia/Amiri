/**
 * scripts/ingest-blog.ts —— 博客 tool 摄入脚本
 *
 * 全量重建 `blog` collection。素材源：BLOG_POSTS_DIR（默认 ./Blog/source/_posts）。
 * 详细规格见 docs/rag-principles.md §1（摄入链路）。
 *
 * 用法：
 *   npm run ingest:blog                       # 用默认 BLOG_POSTS_DIR
 *   BLOG_POSTS_DIR=/path/to/posts npm run ingest:blog
 */

import "dotenv/config";
import path from "node:path";
import { loadAndSplit, rebuildCollection } from "../.pi/extensions/lib/rag-ingest.js";
import { createArkEmbeddings, ARK_EMBEDDING_DIM } from "./lib/embeddings.js";

const DEFAULT_BLOG_POSTS_DIR = "./Blog/source/_posts";
const DEFAULT_QDRANT_URL = "http://localhost:6333";
const COLLECTION = "blog";
const DICT_PATH = "./scripts/lib/sparse-dict/blog.json";

async function main() {
  const blogDir = path.resolve(process.env.BLOG_POSTS_DIR ?? DEFAULT_BLOG_POSTS_DIR);
  const qdrantUrl = process.env.QDRANT_URL ?? DEFAULT_QDRANT_URL;
  const dictPath = path.resolve(DICT_PATH);

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
