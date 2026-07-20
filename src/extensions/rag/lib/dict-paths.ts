/**
 * dict-paths -- sparse 词典路径解析
 *
 * 把「rag extension 根目录在哪」+「词典落在 data/sparse-dict/<collection>.json」
 * 这两件事集中一处。retrieve.ts（读词典）和 ingest 脚本（写词典）共用，
 * 避免路径知识散落、避免依赖进程 cwd。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** rag extension 根目录（lib 的上一级）。 */
const RAG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** collection -> 词典相对路径（相对 rag extension 根）。 */
const DICT_REL: Record<string, string> = {
  blog: "data/sparse-dict/blog.json",
  interview: "data/sparse-dict/interview.json",
};

/** 返回某 collection 词典的绝对路径，不依赖进程 cwd。 */
export function dictPathFor(collection: string): string {
  const rel = DICT_REL[collection];
  if (!rel) throw new Error(`unknown collection: ${collection}`);
  return path.resolve(RAG_ROOT, rel);
}
