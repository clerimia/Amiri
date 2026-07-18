/**
 * rag-ingest —— 摄入链路薄封装
 *
 * 见 docs/rag-principles.md §1（摄入链路）与 §3.3（薄封装点）。
 *
 * 集中：
 *   - D-1 批注预处理 preprocessAnnotations
 *   - D-4 Markdown 标题路径切分 splitByHeaders（langchain.js 无 MarkdownHeaderTextSplitter，自写）
 *   - loader 递归 walk markdown
 *   - 全量重建 helper rebuildCollection
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { QdrantClient } from "@qdrant/js-client-rest";
import { buildSparseVectors, saveDict, type SparseDict } from "./rag-sparse.js";

/**
 * D-1：批注预处理。
 *
 * 规则：blockquote 行首 `> 【clerimia：】 xxx` -> `**[clerimia 注]** xxx`
 * 其它保留原样，包括 (β) 标记以及批注正文里的行内 markdown。
 *
 * 之所以必须走多行匹配（`^` 逐行）：blockquote 只在行首生效，正文中出现的
 * `"> 【clerimia：】 ..."` 字面串不应被误改。
 */
export function preprocessAnnotations(md: string): string {
  return md.replace(/^> 【clerimia：】\s*/gm, "**[clerimia 注]** ");
}

/**
 * D-4：按 markdown 标题路径切分。
 *
 * langchain.js **不提供** MarkdownHeaderTextSplitter（Python 有），只有
 * MarkdownTextSplitter（一个 RecursiveCharacterTextSplitter 变体）。为了满足
 * §1.3 "第一段：切到 ###，metadata 带完整标题路径" 的规格，此函数自实现。
 *
 * 切分策略：
 *   - 只识别 `#`/`##`/`###` 三级 ATX 标题
 *   - 维护一个 "当前标题栈"，遇到更浅或同级标题就出栈
 *   - 每一段的 pageContent 是它自己的 body（不含前面标题内容），metadata.section
 *     是形如 `## 一级 > ### 二级 > ### 三级` 的完整路径
 *   - 位于任何标题之前的正文（前言）用空 section
 *
 * 忽略 fenced code block 内的 `#` 行（避免把 `# comment` 当成标题）。
 */
export function splitByHeaders(
  md: string,
  source: string
): Document[] {
  const lines = md.split("\n");
  type Frame = { level: number; title: string };
  const stack: Frame[] = [];
  const docs: Document[] = [];
  let bodyLines: string[] = [];
  let inFence = false;
  let fenceMark = "";

  const flush = () => {
    // 去掉首尾空白行，避免空块
    while (bodyLines.length && bodyLines[0].trim() === "") bodyLines.shift();
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
    if (bodyLines.length === 0) return;
    const section = stack.map(f => `${"#".repeat(f.level)} ${f.title}`).join(" > ");
    docs.push(
      new Document({
        pageContent: bodyLines.join("\n"),
        metadata: { source, section },
      })
    );
    bodyLines = [];
  };

  for (const raw of lines) {
    // fenced code block 状态机
    const fence = raw.match(/^(\s*)(```+|~~~+)(.*)$/);
    if (fence) {
      const marker = fence[2];
      if (!inFence) {
        inFence = true;
        fenceMark = marker[0];
      } else if (marker[0] === fenceMark) {
        inFence = false;
      }
      bodyLines.push(raw);
      continue;
    }
    if (inFence) {
      bodyLines.push(raw);
      continue;
    }
    const m = raw.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) {
      flush();
      const level = m[1].length;
      const title = m[2];
      // 出栈：把 >= level 的都清掉
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      continue;
    }
    bodyLines.push(raw);
  }
  flush();
  return docs;
}

/**
 * 递归扫描目录，收集所有 `.md` 文件的绝对路径。
 *
 * 忽略 `node_modules`、`.git` 等隐藏 / 依赖目录，避免踩进第三方或本地缓存。
 */
export async function walkMarkdown(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // 目录不存在（比如 knowledges 空壳未建）：跳过，让脚本自己决定要不要报错
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        results.push(full);
      }
    }
  }
  await walk(root);
  results.sort();
  return results;
}

/**
 * 摄入配置：约定素材根 + Qdrant collection 名 + 切分参数
 */
export interface IngestConfig {
  /** 一个或多个素材根目录（如 blog 就一个，interview 有 Blog + knowledges） */
  sourceRoots: string[];
  /** Qdrant collection 名 */
  collectionName: string;
  /** 切分参数（字符），默认 1000/200，见 §1.3 */
  chunkSize?: number;
  chunkOverlap?: number;
}

/**
 * 摄入一次：loader -> preprocess -> 两段式 splitter -> Document[]。
 *
 * 保持"纯"：不碰 embedding，不碰 Qdrant，方便单测和干跑。
 */
export async function loadAndSplit(cfg: IngestConfig): Promise<Document[]> {
  const chunkSize = cfg.chunkSize ?? 1000;
  const chunkOverlap = cfg.chunkOverlap ?? 200;
  const recursive = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });

  const allDocs: Document[] = [];
  for (const root of cfg.sourceRoots) {
    const files = await walkMarkdown(root);
    for (const file of files) {
      const raw = await fs.readFile(file, "utf-8");
      const md = preprocessAnnotations(raw);
      const source = path.basename(file);
      const headerDocs = splitByHeaders(md, source);
      // 第二段：对每个 header chunk 再递归切到 chunkSize
      for (const d of headerDocs) {
        const sub = await recursive.createDocuments(
          [d.pageContent],
          [d.metadata]
        );
        allDocs.push(...sub);
      }
    }
  }
  return allDocs;
}

/**
 * 全量重建 Qdrant collection：drop + create（named dense + sparse）+ embed + upsert。
 *
 * 非增量 upsert（§1.1 决策）：先 delete 现有 collection（若存在），再自建 schema——
 * schema 从原来的单 vector 改成 **named dense + sparse**（对齐 m2 决策，见 #13/#14）：
 *   - vectors:        `{ dense: { size, distance: Cosine } }`
 *   - sparse_vectors: `{ sparse: {} }`
 * 因为 named vector + sparse 一起用时 `QdrantVectorStore.fromDocuments` 不支持
 * （它只吃默认单向量 schema），这里手动走 create + embed + upsert 流程。
 *
 * payload 命名对齐 langchain `QdrantVectorStore` 默认：
 *   - `content`  = doc.pageContent
 *   - `metadata` = doc.metadata
 * 让 #8 检索侧继续用 `QdrantVectorStore.fromExistingCollection` 挂载读，字段名不用改。
 *
 * @param docs      待摄入的 chunk
 * @param embeddings Ark 豆包 embedding 实例（走 OpenAI 兼容接口）
 * @param opts.dictPath sparse 词典落盘路径（本 collection 独立字典 JSON）
 */
export async function rebuildCollection(
  docs: Document[],
  embeddings: EmbeddingsInterface,
  opts: { url: string; collectionName: string; vectorSize: number; dictPath: string }
): Promise<{ points: number; dict: SparseDict }> {
  const client = new QdrantClient({ url: opts.url });

  // drop
  try {
    await client.deleteCollection(opts.collectionName);
  } catch {
    // 不存在也没关系，往下走
  }

  // 建 collection：named dense + sparse
  await client.createCollection(opts.collectionName, {
    vectors: {
      dense: { size: opts.vectorSize, distance: "Cosine" },
    },
    sparse_vectors: {
      sparse: {},
    },
  });

  // 建 sparse 词典 + doc-side sparse 向量
  const { dict, sparses } = buildSparseVectors(docs);
  await saveDict(dict, opts.dictPath);

  // 生成 dense embedding；embeddings 内部走 Ark，`embedDocuments` 会按 batchSize
  // 自动分批 + maxConcurrency=1 串行请求（见 lib/ark-embeddings.ts）
  const denseVectors = await embeddings.embedDocuments(docs.map(d => d.pageContent));

  // upsert：手动组 point，双向量 + payload
  // 分批 upsert：一次全推 139×2048 float 大约 1MB+，Qdrant 单请求默认 32MB 上限，
  // 但保险起见按 64 分批（同样是给未来更大语料兜底）
  const BATCH = 64;
  for (let i = 0; i < docs.length; i += BATCH) {
    const slice = docs.slice(i, i + BATCH);
    const points = slice.map((d, k) => ({
      id: i + k,
      vector: {
        dense: denseVectors[i + k],
        sparse: sparses[i + k],
      },
      payload: {
        content: d.pageContent,
        metadata: d.metadata,
      },
    }));
    await client.upsert(opts.collectionName, { points, wait: true });
  }

  // 校验 count
  const info = await client.getCollection(opts.collectionName);
  return { points: Number(info.points_count ?? docs.length), dict };
}
