# Pi extension 加载机制调查

> Wayfinder 地图 [#1](https://github.com/clerimia/amiri/issues/1) 子 ticket [#8](https://github.com/clerimia/amiri/issues/8)（RAG 检索链路）落地前的前置调查。要确定：新增 `.pi/extensions/search-rag.ts` 后 Pi 是否自动加载、要不要 entry/config。调查方式为阅读本机 Pi 包的一手文档与源码，非推测。

## 结论速览

`.pi/extensions/*.ts`（项目级顶层 `.ts`）是 **Pi 约定目录，自动发现**，放进即加载，**不需要** `index.ts`、**不需要** 改 config、**不需要** 项目自己装 typebox。唯一前提：项目已被 Pi trust。

## 1. Pi 从哪里读"要加载哪些 extension"

**约定目录自动发现**（证据：`docs/extensions.md` "Extension Locations" 表）：

| 位置 | 范围 | 模式 |
|---|---|---|
| `~/.pi/agent/extensions/*.ts` | 全局 | 顶层 `.ts` 文件 |
| `~/.pi/agent/extensions/*/index.ts` | 全局 | 子目录，**必须** `index.ts` |
| `.pi/extensions/*.ts` | 项目级 | 顶层 `.ts` 文件 |
| `.pi/extensions/*/index.ts` | 项目级 | 子目录，**必须** `index.ts` |

- 不递归扫 `*.ts`：只有顶层 `.ts` 和"子目录里的 `index.ts`"两种模式。`lib/` 这种子目录**不**被当独立 extension 扫描（它不是 `*/index.ts`），仅作为被相对 import 的辅助模块存在
- 额外路径可由 `settings.json` 的 `extensions` 字段追加（绝对路径或目录），`packages` 字段加 pi-package
- 项目级 extension **信任门控**：文档原话 "Project-local `.pi/extensions` entries load only after the project is **trusted**"。首次进入会问 trust，`trust.json` 记忆

**证据**：`/home/soyo/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`（README L393 亦同）。

## 2. 项目没有 config 时会怎样

约定目录是默认行为，不需要 config。项目无 `.pi/config.json`、无 `pi.json` 时：

- `.pi/extensions/*.ts` 仍被自动扫描加载
- `~/.pi/agent/extensions/*.ts`（全局）照常加载
- trust 未决时项目级 extension 被跳过（全局 extension 参与信任决策）

## 3. extension 文件导出形态

**必须** `export default function (pi: ExtensionAPI)`，可 sync 可 async（async 时 Pi 在 startup 前等待它 resolve）。**不支持** named export 作 entry。

证据：`docs/extensions.md` Quick Start、`examples/extensions/minimal.ts`、参考教材 `reference/pi-vs-claude-code/extensions/*.ts` 全部一致。

## 4. jiti 加载 `.ts` 的细节

- **loader**：`dist/core/extensions/loader.js`，用 jiti（`createJiti(import.meta.url, ...)` + `jiti.import(extensionPath, { default: true })`）。TypeScript 无需编译
- **alias 注入**：loader 的 `getAliases()` 给 extension 注入一组模块别名，指向 pi-coding-agent 包自带版本：
  - `typebox`、`typebox/compile`、`typebox/value`
  - `@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-tui`、`@earendil-works/pi-ai`（含 compat/oauth/providers/all）
  - `@mariozechner/pi-coding-agent`（旧名兼容）
  - 证据：`loader.js:58-95` 的 `getAliases()`
- **结论**：extension 里 `import { Type } from "typebox"` **不需要** 项目装 typebox--loader 已 alias 到 pi 包自带版（1.1.38）。文档 "Available Imports" 表亦确认
- **tsconfig**：jiti 用自己内置的 TS 转换，不读项目 `tsconfig.json` 的 paths 校验（相对 import 正常解析）。项目 `tsconfig.json` 主要服务 `tsx`/`tsc`，不影响 extension 加载
- **`.js` 后缀在 `.ts` 源码里**：`rag-ingest.ts` 用 `from "./rag-sparse.js"`（ESM 约定），jiti 能解析到 `.ts` 源码。已被 #7/#14 实际跑通验证（`scripts/ingest-*.ts` import lib 跑 ingest 成功）

## 5. 对 #8 的最小可行清单

1. 新建 `.pi/extensions/search-rag.ts`：`export default function (pi: ExtensionAPI)`，内部 `pi.registerTool({ name: "search", parameters: Type.Object({...}), execute... })`
2. 新建 `.pi/extensions/lib/rag-retrieve.ts`：词典 lazy 单例 + `buildSparseQuery(collection, query)`（方案 A）+ `retrieve(collection, query)` 调 Qdrant Query API + 结果转换
3. **不需要** `index.ts`
4. **不需要** 改 config / 不需要在 `~/.pi/agent/npm` 装 typebox
5. 项目需已被 Pi trust（日常用 Pi 已 trust）

`pi.registerTool` 可选增强字段（`docs/extensions.md` "Custom Tools" 段）：
- `promptSnippet`：让 tool 进 "Available tools" 一行说明
- `promptGuidelines`：往 Guidelines 追加 bullet（**必须显式写 tool 名**，不能写 "Use this tool when..."，LLM 分不清指哪个）

---

## 附：调查途中发现的 pi-subagents 环境问题（已本地修复）

### 现象

用 `subagent({ agent: "researcher", async: true })` 启动子 agent，runner 进程启动即崩：

```
Error: Cannot find module 'typebox/compile'
  at .../pi-subagents/src/runs/shared/structured-output.ts:4:22
```

### 根因

`pi-subagents` 的 `package.json` 把 typebox **错放进了 devDependencies + optional peer**：

```jsonc
"peerDependencies": { "typebox": "*" },
"peerDependenciesMeta": { "typebox": { "optional": true } },
"dependencies": { "jiti": "2.7.0", "yaml": "2.8.3" },   // typebox 不在这
"devDependencies": { "typebox": "1.1.38" }              // 只在 dev 区
```

但源码**运行时真的 import** 了 `typebox/compile`（`structured-output.ts:4`、`src/extension/rpc.ts:4`）和 `typebox`（`schemas.ts`、`native-supervisor-channel.ts`、`watchdog/review.ts`）。运行时硬依赖被错分类为可选 dev 依赖。

装的过程：
1. `pi install npm:pi-subagents` 按生产装（`npm install --omit=dev`）-> devDependencies 不装 -> **typebox 不装**
2. peer `typebox` 标 `optional: true` -> npm 不强制 host 提供 -> **不报错也不装**
3. pi-subagents 装在独立的 `~/.pi/agent/npm/node_modules/` 树里，**不**向上解析到 pi-coding-agent 自带的 typebox（另一棵 nvm 全局树，互不共享 node_modules）
4. 子 agent 带 `outputSchema` 时触发 `structured-output.ts` 的 `import`，崩

这是 **pi-subagents 包本身的 bug**：typebox 是运行时依赖，应放 `dependencies`，且不该标 optional peer。

### 本地修复（治标）

在 `~/.pi/agent/npm/package.json`（Pi 自管的 `pi-extensions` 私有包）顶层加 `typebox` 依赖，让 npm hoist 到 `~/.pi/agent/npm/node_modules/typebox`，pi-subagents 向上一跳即解析到：

```jsonc
// ~/.pi/agent/npm/package.json
"dependencies": {
  "pi-rtk-optimizer": "^0.9.0",
  "pi-subagents": "^0.35.1",
  "pi-web-access": "^0.13.0",
  "typebox": "^1.1.38"   // 新增，版本对齐 pi-coding-agent
}
```

然后 `cd ~/.pi/agent/npm && npm install`。版本必须 1.1.38（pi-coding-agent 自带版），避免 ABI 不一致。

备份：`~/.pi/agent/npm/package.json.bak`、`package-lock.json.bak`。

### 已知副作用 / 不根治的点

- **`pi update --extensions` / `pi update --all` 可能覆盖**：Pi 重新生成顶层 `package.json` 时可能抹掉手加的 `typebox` 行，bug 复现。若复现，重跑 `npm install typebox@1.1.38 --save` 即可
- **治本要上游修**：pi-subagents 应把 `typebox` 从 devDependencies 挪到 dependencies，并移除 `peerDependenciesMeta.typebox.optional`。仓库 `github.com/nicobailon/pi-subagents`，可提 issue
