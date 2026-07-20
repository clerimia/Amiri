/**
 * search-rag -- 参数化 search(collection, query) tool
 *
 * 见 docs/rag-principles.md §2.6（f2-B 返回形态）/ §3.4 / §4.2（单 tool 参数化）。
 * #8 grilling 决定：不做 search_blog / search_interview 两个 tool，合并为一个参数化 tool。
 *
 * 这里只做 tool 注册 + D-3 结果转换（Document[] -> {content: markdown, details}）。
 * 检索实现在 lib/retriever/retrieve.ts。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { retrieve, type CollectionName } from "./lib/retriever/retrieve.js";
import type { Document } from "@langchain/core/documents";

/**
 * D-3：检索结果 -> tool 返回值转换。
 *
 * content 给 LLM（结构化 markdown，agent 能引用"结果 N"）；
 * details 旁路给前端（j1 来源卡片），不进 LLM 主内容。
 * 见 §2.6 f2-B。
 */
function toToolResult(docs: Document[], collection: CollectionName) {
  const text = docs
    .map((r, i) => {
      const source = (r.metadata as { source?: string }).source ?? "(unknown)";
      const section = (r.metadata as { section?: string }).section ?? "";
      const header = `### 结果 ${i + 1}\n**来源**: ${source}\n**章节**: ${section}`;
      return section ? `${header}\n\n${r.pageContent}` : `${header}\n\n${r.pageContent}`;
    })
    .join("\n\n---\n\n");

  return {
    content: [{ type: "text" as const, text: text || "未检索到相关内容。" }],
    details: {
      count: docs.length,
      collection,
      sources: docs.map((r) => ({
        source: (r.metadata as { source?: string }).source ?? "",
        section: (r.metadata as { section?: string }).section ?? "",
      })),
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Search Knowledge Base",
    description:
      "搜索 Amiri 的知识库。collection=\"blog\" 搜博客文章（技术笔记、项目复盘、原理沉淀），适合回答技术原理、实现细节、" +
      "“某篇博文写过什么”类问题；collection=\"interview\" 搜面试题库与简历素材（八股、项目经历、个人作答），" +
      "适合准备面试、查某知识点的面试角度。返回结构化的检索结果（含来源与章节）。" +
      "当用户问到知识库里可能有的内容时调用，不要用来搜当前代码库（那用 grep/read）。",
    promptSnippet: "搜索博客 / 面试知识库（语义检索，返回带来源的 chunk）",
    promptGuidelines: [
      "当用户问技术原理、博文内容、面试题或简历项目时，先用 search 检索知识库，再用检索结果作答；不要凭记忆编造知识库内容。",
      "search 的 collection 选 blog 还是 interview，按用户问题语义：技术/原理→blog，面试/八股/项目经历→interview。拿不准就两个都搜。",
      "search 只覆盖知识库；要查当前代码库用 grep/find/read，不要用 search。",
    ],
    parameters: Type.Object({
      collection: StringEnum(["blog", "interview"] as const, {
        description: "搜哪个知识库：blog=博客文章，interview=面试题库与简历素材",
      }),
      query: Type.String({ description: "自然语言查询；会做语义和精确双路检索" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { collection, query } = params as { collection: CollectionName; query: string };
      try {
        const docs = await retrieve(collection, query);
        return toToolResult(docs, collection);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `检索失败：${message}` }],
          details: { count: 0, collection, sources: [], error: message },
          isError: true,
        };
      }
    },
  });
}
