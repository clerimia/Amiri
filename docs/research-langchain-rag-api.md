# LangChain.js (TypeScript) RAG API 事实核查报告

> 核查日期：2026-07-18
> 核查范围：langchainjs 主仓库 + langchainjs-community 仓库，当前 main 分支源码
> 核查方法：直接读取 GitHub 源码（通过 gh CLI），逐行核对 API 签名与实现逻辑

---

## 1. EnsembleRetriever 的融合算法

### 1.1 融合算法：加权 RRF（Weighted Reciprocal Rank Fusion）

**结论：是加权 RRF，不是简单加权平均。**

源码文件：`libs/langchain-classic/src/retrievers/ensemble.ts` [GitHub](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-classic/src/retrievers/ensemble.ts)

类 JSDoc 明确声明：

> *"Ensemble retriever that aggregates and orders the results of multiple retrievers by using **weighted Reciprocal Rank Fusion**."*

核心实现位于 `_weightedReciprocalRank` 方法：

```typescript
rffScore[pageContent] += weight / (rank + this.c);
```

- 公式为 `weight / (rank + c)`，即 RRF 标准公式 `1/(c + rank)` 乘以权重系数 `weight`。
- 这是 **加权 RRF**，对每个 retriever 的 RRF 分数按其权重加权后求和。

### 1.2 `weights` 参数语义

```typescript
weights?: number[];
```

- 默认值：`new Array(args.retrievers.length).fill(1 / args.retrievers.length)`（等权重）。
- 语义：每个 weight 直接作为 RRF 公式的乘数：`weight[i] / (rank + c)`。权重越大，该 retriever 的排名贡献越大。
- **不是**对最终分数的线性加权平均，而是在 RRF 框架内的加权。

### 1.3 `c` 常数参数

```typescript
c?: number;  // 默认 60
```

- 默认值：`c = 60`（类属性默认值 + 构造函数中 `args.c || 60`）。
- 可覆盖：`new EnsembleRetriever({ retrievers: [...], c: 10 })`。
- 这是 RRF 公式中的标准常数，控制高排名与低排名项的平衡。

### 1.4 结果去重逻辑

去重发生在 `_uniqueUnion` 方法中：

```typescript
const key = doc.pageContent;
if (!documentSet.has(key)) {
  documentSet.add(key);
  result.push(doc);
}
```

- **判等字段：`pageContent` 全字符串比较**（通过 `Set` 去重）。
- 不比较 `metadata.id`，不比较 `metadata` 整体。
- 同一个 `pageContent` 出现在多个 retriever 结果中时，只保留第一个遇到的（按 retriever 数组顺序），但其 RRF 分数会被累加。

### 1.5 源码引用汇总

| 项目 | 文件 | 关键行 |
|------|------|--------|
| 接口定义 | `libs/langchain-classic/src/retrievers/ensemble.ts` | `EnsembleRetrieverInput` 接口 |
| 加权 RRF 公式 | 同上 | `rffScore[pageContent] += weight / (rank + this.c)` |
| c 默认值 | 同上 | `c = 60` / `this.c = args.c \|\| 60` |
| 去重 | 同上 | `_uniqueUnion` 方法，`const key = doc.pageContent` |

---

## 2. BM25Retriever 的 API

### 2.1 导入路径

BM25Retriever 位于独立仓库 `langchain-ai/langchainjs-community`：

```typescript
import { BM25Retriever } from "@langchain/community/retrievers/bm25";
```

源码文件：`libs/community/src/retrievers/bm25.ts` [GitHub](https://github.com/langchain-ai/langchainjs-community/blob/main/libs/community/src/retrievers/bm25.ts)

### 2.2 静态构造方法签名

```typescript
static fromDocuments(
  documents: Document[],
  options: Omit<BM25RetrieverOptions, "docs">
): BM25Retriever
```

其中 `BM25RetrieverOptions` 定义为：

```typescript
export type BM25RetrieverOptions = {
  docs: Document[];
  k: number;               // 返回文档数（必填）
  includeScore?: boolean;   // 是否在 metadata 中包含 bm25Score
} & BaseRetrieverInput;
```

**`options` 支持的字段**：
- `k: number`（必填）——返回的文档数量
- `includeScore?: boolean`——若为 true，结果文档的 `metadata.bm25Score` 会包含 BM25 分数
- `BaseRetrieverInput` 中的字段（如 `callbacks`、`metadata` 等）

**不支持 `k1`、`b` 参数**。底层 BM25 算法实现（`libs/community/src/utils/@furkantoprak/bm25/BM25.ts`）接受 `BMConstants { b?: number; k1?: number }`，但 `BM25Retriever._getRelevantDocuments` 调用时传入 `undefined`：

```typescript
const scoredDocs = BM25<Document>(
  this.docs.map(...),
  processedQuery,
  undefined,  // <-- constants 参数为 undefined，使用默认值 b=0.75, k1=1.2
  (a, b) => b.score - a.score
);
```

无法从外部覆盖 `k1`/`b`。

### 2.3 自定义分词函数

**不支持自定义分词器。** `preprocessFunc` 是 `private` 方法：

```typescript
private preprocessFunc(text: string): string[] {
  return text.toLowerCase().split(/\s+/);
}
```

- 签名：`(text: string) => string[]`
- 不可从外部注入或覆盖
- 逻辑：转小写 + 按空白字符分割

### 2.4 中文分词接入方式

由于 `preprocessFunc` 是 private 且不可配置，中文分词需要**在文档入库前预处理**：

1. 使用分词库（如 `nodejieba`、`@node-rs/jieba`）将中文文本切词
2. 用空格连接分词结果：`"自然语言处理"` -> `"自然 语言 处理"`
3. 将空格分隔后的文本存入 `Document.pageContent`
4. 查询时同样对 query 做分词 + 空格连接

这样 BM25Retriever 的默认 `split(/\s+/)` 就能正确按词切分。这是社区通行做法，无需 fork。

### 2.5 源码引用汇总

| 项目 | 文件 | 关键行 |
|------|------|--------|
| 类定义 | `libs/community/src/retrievers/bm25.ts` | `BM25Retriever` class |
| Options 类型 | 同上 | `BM25RetrieverOptions` type |
| 私有分词器 | 同上 | `private preprocessFunc(text: string): string[]` |
| BM25 调用传 undefined | 同上 | `BM25<Document>(..., undefined, ...)` |
| BM25 算法默认参数 | `libs/community/src/utils/@furkantoprak/bm25/BM25.ts` | `b = 0.75`, `k1 = 1.2` |

---

## 3. Qdrant + OpenAI 兼容 Embedding（对接 Ark 豆包）

### 3.1 QdrantVectorStore 构造函数与 fromDocuments

**源码文件**：`libs/providers/langchain-qdrant/src/vectorstores.ts` [GitHub](https://github.com/langchain-ai/langchainjs/blob/main/libs/providers/langchain-qdrant/src/vectorstores.ts)

**构造函数签名**：

```typescript
constructor(embeddings: EmbeddingsInterface, args: QdrantLibArgs)
```

**`fromDocuments` 签名**：

```typescript
static async fromDocuments(
  docs: Document[],
  embeddings: EmbeddingsInterface,
  dbConfig: QdrantLibArgs
): Promise<QdrantVectorStore>
```

**`QdrantLibArgs` 关键字段**：

```typescript
interface QdrantLibArgs {
  client?: QdrantClient;
  url?: string;
  apiKey?: string;
  collectionName?: string;           // 默认 "documents"
  collectionConfig?: QdrantSchemas["CreateCollection"];  // 手动覆盖 collection 配置
  customPayload?: Record<string, any>[];
  contentPayloadKey?: string;        // 默认 "content"
  metadataPayloadKey?: string;       // 默认 "metadata"
}
```

### 3.2 维度自动检测

**QdrantVectorStore 会自动读取 embedding 输出维度来创建 collection。** 关键代码在 `ensureCollection()` 方法：

```typescript
const collectionConfig = this.collectionConfig ?? {
  vectors: {
    size: (await this.embeddings.embedQuery("test")).length,
    distance: "Cosine",
  },
};
await this.client.createCollection(this.collectionName, collectionConfig);
```

- 如果**未提供** `collectionConfig`，会调用 `this.embeddings.embedQuery("test")` 获取向量长度，自动设为 collection 的 `size`。
- 默认距离度量：`Cosine`。
- 如果 collection 已存在，则跳过创建（不会重复创建）。
- 如果需要自定义（如改为 `Dot` 或 `Euclid`），通过 `collectionConfig` 参数显式传入。

### 3.3 OpenAIEmbeddings 配置（对接 Ark）

**源码文件**：`libs/providers/langchain-openai/src/embeddings.ts` [GitHub](https://github.com/langchain-ai/langchainjs/blob/main/libs/providers/langchain-openai/src/embeddings.ts)

#### 3.3.1 `baseURL` 参数名

通过 `configuration` 参数传入。构造函数签名：

```typescript
constructor(
  fields?: Partial<OpenAIEmbeddingsParams> & {
    verbose?: boolean;
    openAIApiKey?: OpenAIApiKey;      // @deprecated, 别名
    apiKey?: OpenAIApiKey;
    configuration?: ClientOptions;     // <-- 这里传 baseURL
  }
)
```

`ClientOptions` 来自 `openai` npm 包，包含 `baseURL` 字段。

**接入 Ark 的正确写法**：

```typescript
const embeddings = new OpenAIEmbeddings({
  apiKey: "your-ark-api-key",
  model: "doubao-embedding-vision",
  configuration: {
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
  },
});
```

构造函数内部合并逻辑：

```typescript
this.clientConfig = {
  apiKey,
  organization: this.organization,
  dangerouslyAllowBrowser: true,
  ...fields?.configuration,  // 用户的 configuration 覆盖默认值
};
```

#### 3.3.2 自定义 `model`

完全支持任意字符串：

```typescript
model: OpenAIEmbeddingModelId;  // 类型为 OpenAIClient.EmbeddingModel | (string & NonNullable<unknown>)
```

直接传入 `model: "doubao-embedding-vision"` 即可。

#### 3.3.3 自定义 `dimensions`

支持，参数名为 `dimensions`：

```typescript
dimensions?: number;
```

在 `embedDocuments` 和 `embedQuery` 中条件性地发送：

```typescript
if (this.dimensions) {
  params.dimensions = this.dimensions;
}
```

对于 Ark 豆包（1024 维），可以传入 `dimensions: 1024`，但需要确认 Ark 服务端是否支持该参数。如果不支持，省略 `dimensions` 即可——该参数不会出现在请求中。

### 3.4 风险确认：非 OpenAI 服务器的兼容性

**核心风险：`dimensions` 和 `encoding_format` 参数。**

`OpenAIEmbeddings` 在请求中会条件性地发送：

```typescript
const params: OpenAIClient.EmbeddingCreateParams = {
  model: this.model,
  input: batch,
};
if (this.dimensions) {
  params.dimensions = this.dimensions;       // 仅当设置了才发送
}
if (this.encodingFormat) {
  params.encoding_format = this.encodingFormat; // 仅当设置了才发送
}
```

- **`baseURL`**：完全通过 `configuration.baseURL` 透传到底层 `openai` SDK 的 `OpenAIClient`，Ark 兼容没有问题。
- **`model`**：作为字符串直接发送，Ark 只需识别该 model 名即可。
- **`dimensions`**：如果不设置 `dimensions`，该参数不会出现在请求体中。对 Ark 来说，只要不设置就不会触发报错。如果 Ark 不支持 `dimensions` 参数，需要确保不传。
- **`encodingFormat`**：同理，不设置就不会发送。
- **`stripNewLines`**：默认 `true`，这是客户端侧预处理，不影响 API 请求兼容性。

**结论**：`OpenAIEmbeddings` 底层使用标准的 `openai` npm 包（`OpenAIClient`），只要 Ark 实现了 OpenAI 兼容的 `/v1/embeddings` 端点，就可以正常工作。潜在坑点是如果设置了 `dimensions` 或 `encoding_format` 而 Ark 不识别这些请求参数，会报错。**安全做法：不设置 `dimensions` 和 `encodingFormat`，只设 `apiKey`、`model`、`configuration.baseURL`。**

### 3.5 源码引用汇总

| 项目 | 文件 | 关键行 |
|------|------|--------|
| QdrantVectorStore 构造 | `libs/providers/langchain-qdrant/src/vectorstores.ts` | `constructor(embeddings, args)` |
| 自动维度检测 | 同上 | `ensureCollection()` 中 `size: (await this.embeddings.embedQuery("test")).length` |
| OpenAIEmbeddings 构造 | `libs/providers/langchain-openai/src/embeddings.ts` | `constructor(fields?)` |
| configuration 合并 | 同上 | `this.clientConfig = { ... ...fields?.configuration }` |
| dimensions 条件发送 | 同上 | `if (this.dimensions) { params.dimensions = ... }` |
| baseURL 处理 | `libs/providers/langchain-openai/src/utils/azure.ts` | `getEndpoint()` 函数 |

---

## 4. `reference/pi-vs-claude-code/extensions/*.ts` 教材写法

本节的来源是**本仓库内**的教材代码，非外部文档。文件路径均为相对 `reference/pi-vs-claude-code/extensions/`。

### 4.1 Extension 骨架

- **入口**：默认导出一个函数 `export default function (pi: ExtensionAPI) { ... }`（`minimal.ts:13`、`agent-chain.ts:190`）。
- **导入包**：`import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"`；schema 用 `import { Type } from "@sinclair/typebox"`；UI 组件用 `@mariozechner/pi-tui`。
- **生命周期钩子**：`pi.on("session_start" | "before_agent_start" | "input" | "tool_execution_end", async (event, ctx) => {...})`（见 `purpose-gate.ts:65-83`、`tool-counter.ts:22-26`）。`ctx` 提供 `ctx.ui.{setFooter,setWidget,input,confirm,notify,select}`、`ctx.model`、`ctx.getContextUsage()`、`ctx.sessionManager`、`ctx.cwd`。

### 4.2 `pi.registerTool` 签名

出现位置：`pi-pi.ts:374`、`agent-chain.ts:508`、`tilldone.ts:392`、`subagent-widget.ts:{305,344,383,408}`、`coms.ts:{1187,1267,1379,1425}` 等。约定形状：

```typescript
pi.registerTool({
  name: "query_experts",           // tool 名，agent 调用时用
  label: "Query Experts",          // UI 显示名
  description: "...",               // agent 看到的说明，Pi 会拼到 prompt 里
  parameters: Type.Object({         // TypeBox schema
    queries: Type.Array(
      Type.Object({
        expert: Type.String({ description: "..." }),
        question: Type.String({ description: "..." }),
      }),
      { description: "..." }
    ),
  }),
  async execute(_toolCallId, params, _signal, onUpdate, ctx) {
    // onUpdate?.(partial) 发送流式中间态；返回 { content, details }
    return {
      content: [{ type: "text", text: "..." }],  // 给 LLM 看的
      details: { /* 前端旁路 JSON */ },
    };
  },
  renderCall(args, theme) { /* 返回 Text，工具调用时 UI 展示 */ },
  renderResult(result, options, theme) { /* 展开/折叠态渲染 */ },
});
```

要点：
- **`parameters` 用 TypeBox `Type.*`** 描述，不是 JSON Schema 手写、不是 Zod。
- **返回类型**：`{ content: (TextContent | ImageContent)[]; details?: any }`。`content` 是数组，元素 `{ type: "text", text: "..." }`。`details` 是自由 JSON，Pi 不进 LLM 主内容——这与 rag-principles §2.6 的 f2-B 约定完全对齐。
- **`execute` 支持流式**：第 4 个参数 `onUpdate` 是回调；调用它就能在 tool 结果落定前推送中间态给前端（tool-counter/agent-chain 都在用）。RAG tool 若要"搜索中..."UI，走这条路。
- **`ctx.ui.confirm/notify/input`**：`tilldone.ts:415` 有 `ctx.ui.confirm("Start a new list?", "...", { timeout: 30000 })` 的实例——可以在 execute 内交互，不受"tool 必须无副作用"约束（Pi 的定位）。

### 4.3 lib 层组织

教材里 extension 都是**单文件**，没有 `.pi/extensions/lib/` 目录约定的示例。但 `agent-chain.ts` 靠顶层 `chains: ChainDef[]` 变量把配置/状态和 tool 分离；rag-principles §3.4 的 `lib/rag-ingest.ts` / `lib/rag-retrieve.ts` 是**项目自定的约定**，reference/ 里没有先例。extension 用 `import` 从相对路径拉 lib 完全可行（reference 里 `themeMap.ts` 就是共享文件，被多处 `import { applyExtensionDefaults } from "./themeMap.ts"`）。

### 4.4 Sub-agent 编排

教材里 sub-agent = **子进程 `pi -e <extension>.ts`**，不是 SDK 内建的 subagent 抽象：

- `pi-pi.ts:374`（`query_experts`）：`Promise.allSettled(queries.map(q => queryExpert(q.expert, q.question, ctx)))` — `queryExpert` 内部 `spawn("pi", ["-e", "path/to/expert-extension.ts"], ...)`，把 stdout 收集为字符串返回。
- `agent-chain.ts:465-500`：串行 pipeline，每一步 `spawn` 一个 agent 进程，上一步 output 喂给下一步 stdin。

对本项目的意义：**Amiri 的 RAG tool 不需要 sub-agent 编排**——检索链路是同步函数调用（`retriever.invoke(query)`），不涉及跨进程 agent。sub-agent 模式是等未来做多 agent 协作（如"批评家 agent 审博文草稿"）时才用到，与 #10 无关。

### 4.5 与本项目 rag-principles §3.4 的一致性

| rag-principles 约定 | reference/ 验证 | 结论 |
|---|---|---|
| `.pi/extensions/blog-rag.ts` 用 `pi.registerTool` 注册 | 与 `pi-pi.ts` / `agent-chain.ts` 用法一致 | ✓ 直接可行 |
| tool 返回 `{ content: [{type:"text",text}], details }` | 与 `tilldone.ts` / `pi-pi.ts` 返回形态完全一致 | ✓ f2-B 落地无坑 |
| `parameters` 用 TypeBox | 教材里全部用 `Type.Object/Type.String/Type.Array` | ✓ 对齐 |
| lib 层落 `.pi/extensions/lib/*.ts` | 教材单文件，无 lib 目录；但相对 import 通行 | ✓ 项目约定，非 Pi 规范 |

---

## 5. 结论：对 `docs/rag-principles.md` 的影响

（说明：子代理在 worktree 内没有看到 `docs/rag-principles.md`——该文件是主 checkout 里的 untracked 文件，`.gitignore` 未覆盖但未 add；实际内容已由本会话直接读取比对。）

### 5.1 需要修正的段落

**§2.2 "混合检索"** — 描述 `EnsembleRetriever` "**RRF 融合，langchain `EnsembleRetriever` 内置支持 RRF**"：
- 描述**基本正确**，但不完整。实际是**加权 RRF**：`weight / (rank + c)`，其中 `weight` 默认等权重 `1/N`，可用户覆盖；`c` 默认 60。
- 建议改成："RRF 融合（准确说是**加权 RRF**：`weight / (rank + c)`，`c` 默认 60），langchain `EnsembleRetriever` 内置支持。默认等权重、按 `pageContent` 全字符串去重。"

**§2.3 "RRF 原理"** — 公式 `RRF_score(doc) = Σ 1 / (k + rank_i(doc))` 与 §2.2 "内置 RRF" 的写法不完全一致：
- langchain 的实际公式带 `weight` 系数（`weight_i / (c + rank_i)`），且常数名叫 `c` 不叫 `k`（`k` 在 langchain 里指 top-k）。
- 建议：在公式下加一行注："langchain 的 `EnsembleRetriever` 在此公式基础上按 `weights[]` 加权，常数在源码里叫 `c`（默认 60）；本项目两 retriever 等权即可，无需覆盖。"

**§3.3 (D-2) "BM25 中文分词配置"** — 写"`BM25Retriever` 构造时传分词函数"：
- **不成立**。`BM25Retriever` 的 `preprocessFunc` 是 `private`，不可从外部覆盖。中文分词必须**入库前预处理**：文档和查询都用 nodejieba 切词后拼空格。
- 建议改成："(D-2) **BM25 中文预分词**：`BM25Retriever` 不支持传分词器（`preprocessFunc` private），所以在 ingest 侧对 `Document.pageContent` 用 nodejieba 切词拼空格；查询侧同样预处理后再传给 retriever。默认 `preprocessFunc = text.toLowerCase().split(/\s+/)` 就能正确按词切。"

**§2.5 "检索参数"** — "混合检索召回候选数 N = 20"：
- 需要注意 `BM25Retriever` 的 `k` 参数是**必填**（不是 optional），构造时传入即可。此外 BM25 的 `k1`（1.2）、`b`（0.75）不可调——事实性补充，不算错，加个脚注即可。

**§3.1 "明确使用（RAG 组件层）"** — 列出的 6 项：
- 全部真实存在。补一条隐含事实："`QdrantVectorStore` 在 collection 不存在时会调用 `embeddings.embedQuery('test')` 自动探测维度并建 collection（Cosine 距离）——无需手动预建，也无需在代码里声明 `1024` 维度；仅在需要非 Cosine 距离或自定义 payload 时传 `collectionConfig`。"

### 5.2 无需修正、但值得强化的段落

**§2.1 "embedding"** — "OpenAI 兼容接口接 Ark（`api_base` + `api_key`）"：
- 正确，但 langchain.ts 里的实际字段名不是 `api_base`，是 `configuration.baseURL`。建议在实现 ticket #7/#8 里落一份代码模板：
  ```typescript
  new OpenAIEmbeddings({
    apiKey: process.env.ARK_API_KEY,
    model: "doubao-embedding-vision",
    configuration: { baseURL: "https://ark.cn-beijing.volces.com/api/v3" },
    // 不传 dimensions / encodingFormat，避免 Ark 报错
  });
  ```

**§3.4 "代码组织"** — 与 `reference/pi-vs-claude-code/extensions/` 教材写法一致，见本报告 §4.5。

---

## 附录：源码仓库与版本

| 包名 | 仓库 | 路径 |
|------|------|------|
| EnsembleRetriever | [langchain-ai/langchainjs](https://github.com/langchain-ai/langchainjs) | `libs/langchain-classic/src/retrievers/ensemble.ts` |
| BM25Retriever | [langchain-ai/langchainjs-community](https://github.com/langchain-ai/langchainjs-community) | `libs/community/src/retrievers/bm25.ts` |
| BM25 算法 | 同上 | `libs/community/src/utils/@furkantoprak/bm25/BM25.ts` |
| QdrantVectorStore | [langchain-ai/langchainjs](https://github.com/langchain-ai/langchainjs) | `libs/providers/langchain-qdrant/src/vectorstores.ts` |
| OpenAIEmbeddings | 同上 | `libs/providers/langchain-openai/src/embeddings.ts` |
| Azure/endpoint 工具 | 同上 | `libs/providers/langchain-openai/src/utils/azure.ts` |