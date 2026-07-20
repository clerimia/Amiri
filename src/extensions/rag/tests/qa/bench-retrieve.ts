/**
 * 检索 benchmark：读 cases.csv，逐条调 retrieve()，
 * 判断 expected 是否出现在 top-5、should_not 是否没出现，
 * 把结果填进 retrieval_hit 列，写到 out/cases-bench.csv（不动原表）。
 *
 * 跑法：npx tsx tests/qa/bench-retrieve.ts
 *
 * retrieval_hit 列格式：
 *   - 命中："hit: <实际返回的 source 列表>"
 *   - 未命中期望："miss: expected=<expected>, got=<actual>"
 *   - 负例（无 expected）召回空："neg-ok: empty"
 *   - 负例误召回："neg-bad: <actual>"
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import "dotenv/config";
import { retrieve, type CollectionName } from "../../lib/retriever/retrieve.js";

interface Case {
  id: string;
  category: string;
  collection: CollectionName;
  query: string;
  expected: string;
  should_not: string;
  intent: string;
  agent_answer: string;
  retrieval_hit: string;
  human_score: string;
}

const HEADER =
  "id,category,collection,query,expected,should_not,intent,agent_answer,retrieval_hit,human_score";

function parseCsv(text: string): Case[] {
  // 去掉 BOM
  const clean = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c !== "\r") {
        field += c;
      }
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows[0];
  const cases: Case[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === "") continue; // 空行
    const obj = {} as Record<string, string>;
    headers.forEach((h, idx) => (obj[h] = r[idx] ?? ""));
    cases.push({
      id: obj.id,
      category: obj.category,
      collection: obj.collection as CollectionName,
      query: obj.query,
      expected: obj.expected,
      should_not: obj.should_not,
      intent: obj.intent,
      agent_answer: obj.agent_answer,
      retrieval_hit: obj.retrieval_hit,
      human_score: obj.human_score,
    });
  }
  return cases;
}

function csvField(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCsv(c: Case): string {
  return [
    c.id,
    c.category,
    c.collection,
    c.query,
    c.expected,
    c.should_not,
    c.intent,
    c.agent_answer,
    c.retrieval_hit,
    c.human_score,
  ]
    .map(csvField)
    .join(",");
}

async function main() {
  const inPath = path.resolve("tests/qa/cases.csv");
  const outDir = path.resolve("tests/qa/out");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "cases-bench.csv");

  const cases = parseCsv(readFileSync(inPath, "utf-8"));
  console.log(`读到 ${cases.length} 条用例\n`);

  for (const c of cases) {
    const sources: string[] = [];
    try {
      const docs = await retrieve(c.collection, c.query);
      for (const d of docs) {
        const s = (d.metadata as { source?: string }).source ?? "(unknown)";
        sources.push(s);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      c.retrieval_hit = `error: ${msg.slice(0, 80)}`;
      console.log(`[${c.id}] error: ${msg.slice(0, 80)}`);
      continue;
    }

    const expectedList = c.expected
      ? c.expected.split(";").map((s) => s.trim()).filter(Boolean)
      : [];
    const shouldNotList = c.should_not
      ? c.should_not.split(";").map((s) => s.trim()).filter(Boolean)
      : [];

    if (expectedList.length === 0) {
      // 负例
      if (sources.length === 0) {
        c.retrieval_hit = "neg-ok: empty";
      } else {
        c.retrieval_hit = `neg-bad: ${sources.join(" | ")}`;
      }
    } else {
      const hit = expectedList.some((e) =>
        sources.some((s) => s.includes(e))
      );
      const badHits = shouldNotList.filter((e) =>
        sources.some((s) => s.includes(e))
      );
      const tag = hit ? "hit" : "miss";
      const bad = badHits.length ? ` | should_not-hit: ${badHits.join(" | ")}` : "";
      c.retrieval_hit = `${tag}: got=[${sources.join(" | ")}]${bad}`;
    }
    console.log(`[${c.id}] ${c.retrieval_hit}`);
  }

  const out = "\uFEFF" + HEADER + "\n" + cases.map(rowToCsv).join("\n") + "\n";
  writeFileSync(outPath, out, "utf-8");
  console.log(`\n结果写入 ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
