/**
 * src/ingest/ingest-interview.ts -- 面试 tool 摄入脚本
 *
 * 全量重建 `interview` collection。素材源：BLOG_POSTS_DIR（含简历 `关于我.md`）
 * + ./knowledges（题库，进 amiri git）。详细规格见 docs/rag-principles.md §1。
 */

import "dotenv/config";
import path from "node:path";
import { loadAndSplit, rebuildCollection } from "../extensions/lib/rag-ingest.js";
import { createArkEmbeddings, ARK_EMBEDDING_DIM } from "../extensions/lib/ark-embeddings.js";
import { validateEnv } from "../extensions/lib/env.js";

const DEFAULT_BLOG_POSTS_DIR = "./Blog/source/_posts";
const DEFAULT_KNOWLEDGES_DIR = "./knowledges";
const DEFAULT_QDRANT_URL = "http://localhost:6333";
const COLLECTION = "interview";
const DICT_PATH = "./src/extensions/lib/sparse-dict/interview.json";

async function main() {
  validateEnv();
  const blogDir = path.resolve(process.env.BLOG_POSTS_DIR ?? DEFAULT_BLOG_POSTS_DIR);
  const knowledgesDir = path.resolve(DEFAULT_KNOWLEDGES_DIR);
  const qdrantUrl = process.env.QDRANT_URL ?? DEFAULT_QDRANT_URL;
  const dictPath = path.resolve(DICT_PATH);

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
