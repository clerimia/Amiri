import { describe, it, expect } from "vitest";
import { splitByHeaders } from "../lib/ingestor/ingest.js";

describe("splitByHeaders", () => {
  it("按 ##/### 切段，section 保存完整标题路径", () => {
    const md = [
      "# 大纲",
      "前言。",
      "## 一节",
      "一节正文。",
      "### 一节 A",
      "一节 A 正文。",
      "## 二节",
      "二节正文。",
    ].join("\n");
    const docs = splitByHeaders(md, "foo.md");
    expect(docs.map(d => d.metadata.section)).toEqual([
      "# 大纲",
      "# 大纲 > ## 一节",
      "# 大纲 > ## 一节 > ### 一节 A",
      "# 大纲 > ## 二节",
    ]);
    expect(docs.every(d => d.metadata.source === "foo.md")).toBe(true);
    expect(docs[1].pageContent).toBe("一节正文。");
  });

  it("标题之前的正文用空 section（前言块）", () => {
    const md = "只是正文\n没有标题";
    const docs = splitByHeaders(md, "x.md");
    expect(docs).toHaveLength(1);
    expect(docs[0].metadata.section).toBe("");
    expect(docs[0].pageContent).toBe("只是正文\n没有标题");
  });

  it("fenced code block 内的 `#` 不算标题", () => {
    const md = [
      "## 章节",
      "```bash",
      "# 这是 shell 注释，不是标题",
      "ls -la",
      "```",
      "尾部段落。",
    ].join("\n");
    const docs = splitByHeaders(md, "y.md");
    expect(docs).toHaveLength(1);
    expect(docs[0].metadata.section).toBe("## 章节");
    // 代码块要原样保留在 pageContent 里
    expect(docs[0].pageContent).toContain("# 这是 shell 注释");
    expect(docs[0].pageContent).toContain("尾部段落。");
  });

  it("同级标题会 pop 掉上一个（stack 出栈正确）", () => {
    const md = [
      "## A",
      "a",
      "## B",
      "b",
    ].join("\n");
    const docs = splitByHeaders(md, "z.md");
    expect(docs.map(d => d.metadata.section)).toEqual([
      "## A",
      "## B",
    ]);
  });

  it("四级及以下标题按普通正文处理（切分只到 ###）", () => {
    const md = ["## 二级", "text", "#### 四级", "四级正文"].join("\n");
    const docs = splitByHeaders(md, "q.md");
    expect(docs).toHaveLength(1);
    expect(docs[0].metadata.section).toBe("## 二级");
    expect(docs[0].pageContent).toContain("#### 四级");
    expect(docs[0].pageContent).toContain("四级正文");
  });
});
