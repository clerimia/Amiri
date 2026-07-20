/**
 * rag-retrieve -- 检索链路薄封装
 *
 * 见 docs/rag-principles.md §2（检索链路）与 §3.3 D-2/D-3。m2：Qdrant 服务端 sparse fusion。
 *
 * 集中：
 *   - loadDict：lazy 加载 #14 落地的 sparse 词典（per collection，进程内缓存）
 *   - buildSparseQuery：collection-aware 的 query 侧 sparse 构造（包 #14 的 embedQuerySparse）
 *   - retrieve：Ark dense query + Qdrant Query API（prefetch dense+sparse, fusion rrf, limit 5）
 *
 * 不在这里做 Document[] -> tool 返回值转换（D-3）：那层拼 markdown + details，
 * 与 Pi tool 契约耦合，放 search-rag.ts 的 execute 里。
 */

import { readFileSync } from "node:fs";
import { Document } from "@langchain/core/documents";
import { Agent, fetch as undiciFetch } from "undici";
import { embedQuerySparse, type SparseDict, type SparseVector } from "../sparse.js";
import { createArkEmbeddings } from "../ark-embeddings.js";
import { validateEnv } from "../env.js";
import { dictPathFor } from "../dict-paths.js";

/** collection 名。两个 collection 共享一套检索参数（§2.5/§4.3）。 */
export type CollectionName = "blog" | "interview";

/** 词典进程内缓存：loadDict 读 ~200KB JSON，反复加载浪费。 */
const dictCache = new Map<CollectionName, SparseDict>();

/**
 * lazy 加载某 collection 的 sparse 词典。
 *
 * 路径解析见 lib/dict-paths.ts，不依赖进程 cwd。词典是 #14 摄入时落盘的，
 * 进 git，运行时只读。
 *
 * 同步读：词典是本地小文件（~200KB），readFileSync 阻塞可接受，且让
 * buildSparseQuery 保持纯函数签名（不返回 Promise）。rag-sparse.ts 的
 * loadDict 是 async（走 fs.promises），这里不复用它，直接同步读。
 */
export function loadDict(collection: CollectionName): SparseDict {
  const cached = dictCache.get(collection);
  if (cached) return cached;
  const abs = dictPathFor(collection);
  const dict = JSON.parse(readFileSync(abs, "utf-8")) as SparseDict;
  dictCache.set(collection, dict);
  return dict;
}

/**
 * collection-aware 的 query 侧 sparse 构造。
 *
 * 包 #14 的 embedQuerySparse：loadDict(collection) 拿到本 collection 的 term->id 词典，
 * 再把 query 切词映射成同 id 空间的 {indices, values}。OOV term 跳过（#14 决策）。
 *
 * 这一层存在的意义：tool 层只关心 collection 名，不该自己管词典路径；
 * rag-sparse.ts 的 embedQuerySparse 是纯函数（query+dict），不该耦合 collection 概念。
 */
export function buildSparseQuery(collection: CollectionName, query: string): SparseVector {
  return embedQuerySparse(query, loadDict(collection));
}

/**
 * Ark dense query 向量。
 *
 * 走 lib/ark-embeddings.ts 的 createArkEmbeddings（#7 落地，复用 Ark key/env）。
 * embedQuery 单条，不触发 batch 逻辑。
 */
async function embedQueryDense(query: string): Promise<number[]> {
  const embeddings = createArkEmbeddings();
  return embeddings.embedQuery(query);
}

/**
 * Qdrant REST 调用的 undici Agent（同源，见 retrieve 注释）。
 *
 * 进程内单例：Agent 管 keep-alive 连接池，复用即可。
 */
let _agent: Agent | null = null;
function getAgent(): Agent {
  if (!_agent) {
    _agent = new Agent({
      bodyTimeout: 0,
      headersTimeout: 0,
      connections: 25,
      keepAliveTimeout: 10_000,
    });
  }
  return _agent;
}

/** Qdrant 服务端 base URL。 */
function qdrantUrl(): string {
  return process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
}

/**
 * 混合检索：dense + sparse，Qdrant 服务端 RRF 融合。
 *
 * 见 §2.2 / §2.5：一次 Query API 请求完成 dense retrieval + sparse retrieval + RRF fusion。
 *   prefetch: [{dense limit 20}, {sparse limit 20}]
 *   query: { fusion: "rrf" }
 *   limit: 5, with_payload: true
 *
 * 返回的 payload 字段对齐 #7 摄入时落的 langchain 默认：
 *   payload.content  = doc.pageContent
 *   payload.metadata = { source, section, ... }
 *
 * 失败时抛出，由 tool execute 层 catch 转 isError 返回。
 */
export async function retrieve(
  collection: CollectionName,
  query: string
): Promise<Document[]> {
  validateEnv();
  const denseVec = await embedQueryDense(query);
  const sparseVec = buildSparseQuery(collection, query);

  // 不用 @qdrant/js-client-rest：它在 createClient 里用 npm 装的 undici@6 建 Agent，
  // 再传给 Node 内置 fetch（更新的 undici），两个 undici 契约不一致触发
  // "invalid onError method"（见 qdrant-js issue #134）。这里 Agent 和 fetch 都从
  // 同一份 undici（项目 node_modules/undici@6.27）来，契约一致。
  // 请求体与原 client.query 参数一一对应（Qdrant Query API）。
  const res = await undiciFetch(
    `${qdrantUrl()}/collections/${collection}/points/query`,
    {
      method: "POST",
      dispatcher: getAgent(),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prefetch: [
          { query: denseVec, using: "dense", limit: 20 },
          { query: sparseVec, using: "sparse", limit: 20 },
        ],
        query: { fusion: "rrf" },
        limit: 5,
        with_payload: true,
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`Qdrant query HTTP ${res.status}: ${text}`);
  }
  const data = (await res.json()) as {
    result?: { points?: Array<{ payload?: unknown }> };
  };
  const points = data.result?.points ?? [];
  return points.map((p) => {
    const payload = (p.payload ?? {}) as {
      content?: string;
      metadata?: { source?: string; section?: string };
    };
    return new Document({
      pageContent: payload.content ?? "",
      metadata: payload.metadata ?? {},
    });
  });
}
