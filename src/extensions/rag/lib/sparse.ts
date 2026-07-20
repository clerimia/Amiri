/**
 * rag-sparse —— sparse 向量薄封装（jieba 分词 + BM25 tf/idf）
 *
 * 见 docs/rag-principles.md §2.2（m2：Qdrant 服务端 sparse fusion）与 issue #14。
 *
 * 集中：
 *   - tokenize：jieba 精确模式切词 + 归一（小写、丢纯标点/空白 token）
 *   - buildSparseVectors：全语料建 IDF 表 + term→int_id 词典，逐文出 BM25 doc-side sparse
 *   - loadDict / saveDict：字典 JSON IO
 *
 * doc-side BM25 权重公式（Okapi BM25，k1=1.2, b=0.75）：
 *     w(t,d) = IDF(t) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * |d| / avgdl))
 * IDF 公式（Lucene 变体，避免 log(1)=0 使 IDF 归零）：
 *     IDF(t) = log((N - df + 0.5) / (df + 0.5) + 1)
 *
 * 每个 collection 独立字典（term_id 不跨 collection 稳定），检索侧加载本 collection 的
 * 字典把查询切成同 id 空间的 sparse 向量。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Jieba } from "@node-rs/jieba";
import { dict as JIEBA_DICT } from "@node-rs/jieba/dict";
import type { Document } from "@langchain/core/documents";

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** 惰性单例：jieba 加载词典约 5MB，重复初始化会慢。 */
let _jieba: Jieba | null = null;
function getJieba(): Jieba {
  if (!_jieba) _jieba = Jieba.withDict(JIEBA_DICT);
  return _jieba;
}

/**
 * 切词 + 归一。
 *
 * - jieba 精确模式（`cut(text, false)` = HMM 关，`cut(text)` = HMM 开且更贴日常）
 * - 归一：`toLowerCase()`（英文词大小写统一）+ 剥去纯空白/纯标点 token
 * - 不过滤停用词（BM25 的 IDF 会自然给"的"、"了"低权重；见 issue #14 决策）
 *
 * 之所以要归一：jieba 会把连续 ASCII 空格作为独立 token 返回（见 `我 爱 Java` 的实测
 * 输出里有 `' '`），中英混排中标点也常独立成词，这些不承担语义，塞进 IDF 只会稀释权重。
 */
export function tokenize(text: string): string[] {
  const raw = getJieba().cut(text);
  const out: string[] = [];
  for (const t of raw) {
    // 纯空白或纯非文字字符（标点、符号）跳过；保留任何含字母/数字/汉字的 token
    if (!/[\p{L}\p{N}]/u.test(t)) continue;
    out.push(t.toLowerCase());
  }
  return out;
}

/**
 * Sparse 向量在 Qdrant / langchain 端的通用形态：并列的 indices / values 两数组，
 * indices 递增排列（Qdrant 要求）。
 */
export interface SparseVector {
  indices: number[];
  values: number[];
}

/**
 * 每 collection 独立的 sparse 字典：term → int_id + IDF。
 *
 * 字段命名（`terms` / `numDocs` / `avgdl`）与 JSON 文件字段严格对齐，改字段前
 * 记得批量迁移已落地的 sparse-dict/*.json。
 */
export interface SparseDict {
  /** 词典版本，不兼容改动时 bump */
  version: 1;
  /** BM25 超参数（doc-side 用，query-side 复用同套 idf/k1/b 计算） */
  k1: number;
  b: number;
  /** 语料总文档数（N） */
  numDocs: number;
  /** 语料平均文档长度（token 数），BM25 归一化用 */
  avgdl: number;
  /** term → { id, idf, df }；df 保留下来方便调参回溯 */
  terms: Record<string, { id: number; idf: number; df: number }>;
}

/**
 * 批量为一组 Document 构建 sparse 向量 + 字典。
 *
 * 遍历一次统计 df + 每 doc 的 tf，再遍历一次算 BM25 权重。
 * term_id 按 term 字符串**排序后**分配——保证同输入下 JSON 稳定 diff，测试也好写。
 * （按首次出现顺序分配也可以，但输入顺序换了 id 就变，git diff 会炸。）
 */
export function buildSparseVectors(
  docs: Document[]
): { dict: SparseDict; sparses: SparseVector[] } {
  const N = docs.length;
  if (N === 0) {
    return {
      dict: { version: 1, k1: BM25_K1, b: BM25_B, numDocs: 0, avgdl: 0, terms: {} },
      sparses: [],
    };
  }

  // 一次扫：切词、统计 tf、累积 df
  const tokensPerDoc: string[][] = new Array(N);
  const tfPerDoc: Map<string, number>[] = new Array(N);
  const df = new Map<string, number>();
  let totalLen = 0;

  for (let i = 0; i < N; i++) {
    const toks = tokenize(docs[i].pageContent);
    tokensPerDoc[i] = toks;
    totalLen += toks.length;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    tfPerDoc[i] = tf;
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgdl = totalLen / N;

  // 字典：term 排序后分配 id
  const sortedTerms = Array.from(df.keys()).sort();
  const terms: SparseDict["terms"] = {};
  for (let id = 0; id < sortedTerms.length; id++) {
    const t = sortedTerms[id];
    const dfi = df.get(t)!;
    // Lucene 风格 IDF：log((N - df + 0.5) / (df + 0.5) + 1)，恒正
    const idf = Math.log((N - dfi + 0.5) / (dfi + 0.5) + 1);
    terms[t] = { id, idf, df: dfi };
  }

  // 二次扫：算 BM25 权重
  const sparses: SparseVector[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const tf = tfPerDoc[i];
    const dl = tokensPerDoc[i].length;
    const norm = BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl));
    // 按 id 递增排序（Qdrant 要求 indices 单调递增）
    const entries: [number, number][] = [];
    for (const [t, freq] of tf.entries()) {
      const meta = terms[t];
      const weight = (meta.idf * (freq * (BM25_K1 + 1))) / (freq + norm);
      entries.push([meta.id, weight]);
    }
    entries.sort((a, b) => a[0] - b[0]);
    sparses[i] = {
      indices: entries.map(e => e[0]),
      values: entries.map(e => e[1]),
    };
  }

  return {
    dict: { version: 1, k1: BM25_K1, b: BM25_B, numDocs: N, avgdl, terms },
    sparses,
  };
}

/**
 * 把查询串按已有字典切成 sparse 向量。
 *
 * 未登录 term 直接丢弃（正确性：没在语料出现过的词 df=0、IDF 也没意义，Qdrant 侧
 * 也匹配不到）。query-side 每个 term 权重固定为 1（不按出现次数累加）--对齐
 * Lucene/ES 等主流 BM25 实现的查询侧行为：query 通常很短，重复一个词往往是
 * 口误/强调而非更强的语义信号，按 tf 累加会让"git git 撤销"比"git 撤销"权重高，
 * 不合理。doc-side 的 IDF + BM25 权重已足够承载相关性，query 只需标识"要查
 * 这几个 term"作为线性组合系数。
 *
 * 本函数是检索侧 (#8) 的钩子，本 ticket 落地但不在 ingest 路径上用。
 */
export function embedQuerySparse(query: string, dict: SparseDict): SparseVector {
  const toks = tokenize(query);
  const seen = new Set<number>();
  for (const t of toks) {
    const meta = dict.terms[t];
    if (!meta) continue;
    seen.add(meta.id);
  }
  const entries = Array.from(seen).sort((a, b) => a - b);
  return {
    indices: entries,
    values: entries.map(() => 1),
  };
}

/** 字典落盘：格式化后写 JSON，进 git；terms 按 term 字符串序，diff 友好。 */
export async function saveDict(dict: SparseDict, filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // 按 term 字符串序输出（Object.entries 序取决于插入顺序，这里我们插入时已排序）
  const sortedTerms: SparseDict["terms"] = {};
  for (const t of Object.keys(dict.terms).sort()) sortedTerms[t] = dict.terms[t];
  const payload = { ...dict, terms: sortedTerms };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

export async function loadDict(filePath: string): Promise<SparseDict> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as SparseDict;
}
