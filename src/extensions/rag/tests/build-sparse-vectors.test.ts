/**
 * rag-sparse 单测
 *
 * 目标：给出固定小语料，断言 buildSparseVectors 产出：
 *   - 稳定的 term→id 映射（term 字符串序）
 *   - 稳定的 IDF（Lucene 变体，log((N-df+0.5)/(df+0.5)+1)）
 *   - 稳定的 doc-side sparse 权重（BM25 k1=1.2, b=0.75）
 *   - indices 单调递增（Qdrant 要求）
 *   - embedQuerySparse 未登录词丢弃、重复 term 权重固定为 1（对齐主流 BM25 查询侧行为）
 */
import { describe, it, expect } from "vitest";
import { Document } from "@langchain/core/documents";
import {
  tokenize,
  buildSparseVectors,
  embedQuerySparse,
} from "../lib/sparse.js";

describe("tokenize", () => {
  it("对纯中文用 jieba 精确模式切分", () => {
    const toks = tokenize("我爱北京天安门");
    expect(toks).toContain("北京");
    expect(toks).toContain("天安门");
  });

  it("小写归一，剥离纯标点/空白 token", () => {
    const toks = tokenize("Redis 缓存穿透，防护！");
    expect(toks).toContain("redis");
    expect(toks).toContain("缓存");
    expect(toks).toContain("穿透");
    expect(toks).toContain("防护");
    expect(toks).not.toContain(" ");
    expect(toks).not.toContain("，");
    expect(toks).not.toContain("！");
  });
});

describe("buildSparseVectors", () => {
  it("空输入返回空字典和空向量数组", () => {
    const { dict, sparses } = buildSparseVectors([]);
    expect(sparses).toEqual([]);
    expect(dict.numDocs).toBe(0);
    expect(Object.keys(dict.terms)).toEqual([]);
  });

  it("term_id 按 term 字符串序稳定分配（同输入两次调用结果相同）", () => {
    const docs = [
      new Document({ pageContent: "缓存 穿透 防护" }),
      new Document({ pageContent: "缓存 击穿" }),
    ];
    const r1 = buildSparseVectors(docs);
    const r2 = buildSparseVectors(docs);
    expect(r1.dict.terms).toEqual(r2.dict.terms);
    // 按字符串序：击穿 < 穿透 < 缓存 < 防护
    const ids = ["击穿", "穿透", "缓存", "防护"].map(t => r1.dict.terms[t]?.id);
    expect(ids).toEqual([0, 1, 2, 3]);
  });

  it("IDF 用 Lucene 变体公式 log((N-df+0.5)/(df+0.5)+1)", () => {
    // 造 3 篇：'缓存' 出现在全部 3 篇，'击穿' 只在 1 篇
    const docs = [
      new Document({ pageContent: "缓存 击穿" }),
      new Document({ pageContent: "缓存 穿透" }),
      new Document({ pageContent: "缓存 雪崩" }),
    ];
    const { dict } = buildSparseVectors(docs);
    const N = 3;
    const expectIDF = (df: number) => Math.log((N - df + 0.5) / (df + 0.5) + 1);
    expect(dict.terms["缓存"].idf).toBeCloseTo(expectIDF(3), 10);
    expect(dict.terms["击穿"].idf).toBeCloseTo(expectIDF(1), 10);
    expect(dict.terms["缓存"].df).toBe(3);
    expect(dict.terms["击穿"].df).toBe(1);
  });

  it("sparse indices 单调递增（Qdrant 要求）", () => {
    const docs = [
      new Document({ pageContent: "缓存 穿透 防护 Redis 布隆过滤器 击穿" }),
      new Document({ pageContent: "Java 秒杀 系统 Redis 缓存" }),
    ];
    const { sparses } = buildSparseVectors(docs);
    for (const sv of sparses) {
      for (let i = 1; i < sv.indices.length; i++) {
        expect(sv.indices[i]).toBeGreaterThan(sv.indices[i - 1]);
      }
      expect(sv.indices.length).toBe(sv.values.length);
    }
  });

  it("BM25 权重：越稀有的词权重越高（同一文档内比较 IDF 主导）", () => {
    // 3 篇里，'缓存' 每篇都出现（df=3, IDF 低），'击穿' 只 1 篇（df=1, IDF 高）
    // 第 0 篇同时有两词，各出现 1 次；预期 '击穿' 权重 > '缓存' 权重
    const docs = [
      new Document({ pageContent: "缓存 击穿" }),
      new Document({ pageContent: "缓存 穿透" }),
      new Document({ pageContent: "缓存 雪崩" }),
    ];
    const { dict, sparses } = buildSparseVectors(docs);
    const sv0 = sparses[0];
    const idxCache = dict.terms["缓存"].id;
    const idxJi = dict.terms["击穿"].id;
    const wCache = sv0.values[sv0.indices.indexOf(idxCache)];
    const wJi = sv0.values[sv0.indices.indexOf(idxJi)];
    expect(wJi).toBeGreaterThan(wCache);
  });

  it("BM25 权重：更长文档同 tf 下权重更低（长度归一）", () => {
    // 长文档稀释 tf 的贡献：doc B 长度显著大于 A，'击穿' tf 都是 1，
    // 由于 dl/avgdl 增大，B 中 '击穿' 权重应 < A
    const docs = [
      new Document({ pageContent: "击穿 缓存" }), // 短
      new Document({
        pageContent: "击穿 缓存 " + "填充 内容 长文档 分词 结果 会多 很多 词 语料".repeat(5),
      }), // 长
      // 加一篇提高 N，确保 '击穿' 的 IDF 非零（df=2 with only 2 docs 会算出 log((2-2+0.5)/(2+0.5)+1)=log(1.2) 也非零，但加一篇更稳）
      new Document({ pageContent: "其他 无关 内容" }),
    ];
    const { dict, sparses } = buildSparseVectors(docs);
    const idxJi = dict.terms["击穿"].id;
    const wA = sparses[0].values[sparses[0].indices.indexOf(idxJi)];
    const wB = sparses[1].values[sparses[1].indices.indexOf(idxJi)];
    expect(wA).toBeGreaterThan(wB);
  });
});

describe("embedQuerySparse", () => {
  const corpus = [
    new Document({ pageContent: "缓存 击穿 Redis" }),
    new Document({ pageContent: "缓存 穿透 布隆过滤器" }),
  ];
  const { dict } = buildSparseVectors(corpus);

  it("未登录词丢弃", () => {
    const sv = embedQuerySparse("量子力学", dict);
    expect(sv.indices).toEqual([]);
    expect(sv.values).toEqual([]);
  });

  it("登录词权重固定为 1（重复不计 tf）", () => {
    const sv = embedQuerySparse("缓存 缓存 击穿", dict);
    const idxCache = dict.terms["缓存"].id;
    const idxJi = dict.terms["击穿"].id;
    const cacheVal = sv.values[sv.indices.indexOf(idxCache)];
    const jiVal = sv.values[sv.indices.indexOf(idxJi)];
    expect(cacheVal).toBe(1);
    expect(jiVal).toBe(1);
  });

  it("indices 单调递增", () => {
    const sv = embedQuerySparse("缓存 击穿 redis 穿透", dict);
    for (let i = 1; i < sv.indices.length; i++) {
      expect(sv.indices[i]).toBeGreaterThan(sv.indices[i - 1]);
    }
  });
});
