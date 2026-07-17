# Amiri

个人 Agent，以 Pi 为 runtime 基座，通过其扩展机制实现 Agentic RAG（langchain.ts）与其它 tool。全部 TypeScript 实现，单用户，部署到本机经 frp + Nginx 暴露。

## Agent skills

本仓库已配置工程技能（issue 跟踪器、领域文档）。使用工程技能前先阅读：

- `docs/agents/issue-tracker.md` - issue 跟踪器约定（本地 markdown，issue 存放在 `.scratch/` 下）
- `docs/agents/domain.md` - 领域文档（`CONTEXT.md` / `docs/adr/`）的消费规则
