#!/usr/bin/env bash
# qa-e2e.sh -- 批量 dogfood：读 cases.csv 的 query，逐条 pi -p 跑 agent，
# 完整回答写到 out/<id>.txt，并在 out/cases-e2e.csv 的 agent_answer 列填截断版 + txt 链接。
#
# 用法：bash src/extensions/rag/tests/qa/qa-e2e.sh
# 依赖：pi 在 PATH 里、cases.csv 在同目录
#
# 注意：每条 query 会真实调用 pi（耗 token、耗时）。建议先小批试跑。

set -euo pipefail

QA_DIR="$(cd "$(dirname "$0")" && pwd)"
CASES="$QA_DIR/cases.csv"
OUTDIR="$QA_DIR/out"
E2E_CSV="$OUTDIR/cases-e2e.csv"
mkdir -p "$OUTDIR"

# 解析 CSV：用 python3，避免 shell 切中文/引号/逗号地狱
python3 - "$CASES" "$OUTDIR" <<'PY'
import csv, subprocess, sys, os

cases_path, outdir = sys.argv[1], sys.argv[2]
with open(cases_path, encoding="utf-8-sig", newline="") as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    rows = list(reader)

print(f"读到 {len(rows)} 条用例，开始跑 pi -p ...\n", file=sys.stderr)

for r in rows:
    cid = r["id"]
    query = r["query"]
    txt_path = os.path.join(outdir, f"{cid}.txt")

    print(f"[{cid}] {query}", file=sys.stderr)
    try:
        result = subprocess.run(
            ["pi", "-p", query],
            capture_output=True, text=True, timeout=180,
        )
        answer = result.stdout.strip()
        if result.returncode != 0:
            answer = f"[pi 退出码 {result.returncode}]\n{answer}\n--- stderr ---\n{result.stderr.strip()}"
    except subprocess.TimeoutExpired:
        answer = "[超时 180s]"
    except FileNotFoundError:
        answer = "[pi 不在 PATH]"

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(answer)

    # agent_answer 列：截断 120 字 + 指向 txt
    snippet = answer[:120].replace("\n", " ")
    if len(answer) > 120:
        snippet += "..."
    r["agent_answer"] = f"{snippet} (见 out/{cid}.txt)"
    print(f"  -> {len(answer)} 字符，写入 out/{cid}.txt\n", file=sys.stderr)

# 写出填好的 csv（带 BOM）
out_csv = os.path.join(outdir, "cases-e2e.csv")
with open(out_csv, "w", encoding="utf-8-sig", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)

print(f"填好的表格: {out_csv}", file=sys.stderr)
PY
