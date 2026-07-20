import { describe, it, expect } from "vitest";
import { preprocessAnnotations } from "../lib/ingestor/ingest.js";

describe("preprocessAnnotations", () => {
  it("将单条 clerimia 批注转成粗体行内标记", () => {
    const md = "正文。\n> 【clerimia：】 这是一句注解。\n下一段。";
    expect(preprocessAnnotations(md)).toBe(
      "正文。\n**[clerimia 注]** 这是一句注解。\n下一段。"
    );
  });

  it("同一份文档内的多条批注都要转换", () => {
    const md = [
      "> 【clerimia：】 A",
      "内容",
      "> 【clerimia：】 B",
    ].join("\n");
    expect(preprocessAnnotations(md)).toBe(
      ["**[clerimia 注]** A", "内容", "**[clerimia 注]** B"].join("\n")
    );
  });

  it("(β) 标记原样保留（不被处理成任何东西）", () => {
    const md = "> 【clerimia：】 备注 (β) 需要复核";
    expect(preprocessAnnotations(md)).toBe("**[clerimia 注]** 备注 (β) 需要复核");
  });

  it("没有批注的文档保持原样", () => {
    const md = "# 标题\n\n段落文本，没有批注。\n\n> 普通引用不受影响。";
    expect(preprocessAnnotations(md)).toBe(md);
  });

  it("marker 后允许多余空格；至少接受紧贴无空格", () => {
    // 单空格（规格样例）
    expect(preprocessAnnotations("> 【clerimia：】 单空格"))
      .toBe("**[clerimia 注]** 单空格");
    // 紧贴无空格（作者手误也要包住）
    expect(preprocessAnnotations("> 【clerimia：】紧贴"))
      .toBe("**[clerimia 注]** 紧贴");
  });

  it("批注中的 markdown 内联标记（如粗体、行内代码）原样保留", () => {
    const md = "> 【clerimia：】 见 **重点** 与 `code`";
    expect(preprocessAnnotations(md)).toBe(
      "**[clerimia 注]** 见 **重点** 与 `code`"
    );
  });

  it("非行首的 `>【clerimia：】` 序列不误伤（要求作为 blockquote 行首）", () => {
    // 引号里的伪 marker 不该被替换
    const md = '正文提到 "> 【clerimia：】 example" 这句话本身';
    expect(preprocessAnnotations(md)).toBe(md);
  });
});
