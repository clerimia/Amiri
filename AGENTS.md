# Amiri

个人 Agent，以 Pi 为 runtime 基座，通过其扩展机制实现 Agentic RAG（langchain.ts）与其它 tool。全部 TypeScript 实现，单用户，部署到本机经 frp + Nginx 暴露。

## Agent skills

本仓库已配置工程技能（issue 跟踪器、领域文档）。使用工程技能前先阅读：

- `docs/agents/issue-tracker.md` - issue 跟踪器约定（GitHub Issues，`gh` CLI）
- `docs/agents/domain.md` - 领域文档（`CONTEXT.md` / `docs/adr/`）的消费规则

## 宪法

宪法级规则，不因 agent 类型/背景 job 默认套路/上游通用约定而变。

### 1. 先 commit 后 push，两步分离

任何提交都必须**先 commit、后 push**，两步分离。commit 是本地里程碑（廉价、可 reset/amend）；push 是发布，一旦推出去影响远端历史和 PR/CI，时机由用户掌握。

- 用户说 "commit" / "提交" / "落一下" → **只 commit，不 push**
- 用户单独说 "push" / "推" / "发出去" → 才 push
- 用户说 "commit 并 push" / "提交并推送" 等**两个动词都出现**的表述 → 才连做两步
- 完成 commit 后简报"本地领先 origin N 个 commit，未 push"，**不主动追问**要不要 push
- 背景 job 的通用默认"commit + push + 开 PR 一条龙"在本仓库**让位于本规则**，除非用户在同一句里明确请求 push

worktree 内的分支同理：commit 后不主动 push；用户明说才 push。

## 文件约定

- `CLAUDE.md` → `AGENTS.md` 的符号链接。两者内容始终一致；编辑时改 `AGENTS.md`。
