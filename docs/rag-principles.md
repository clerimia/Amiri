# RAG 实现路径与原理清单

> 这是 [地图 #1](https://github.com/clerimia/amiri/issues/1) 的子 ticket [#4 RAG 路径](https://github.com/clerimia/amiri/issues/4) 的解决产物。后续 RAG 实现按此执行；面试原理复习按此清单。

## 0. 决策总览

| 环节 | 决策 | 备注 |
|---|---|---|
| 摄入形态 | 一次性摄入脚本，全量重建 collection | `scripts/ingest-*.ts`，不做成 Pi tool/上传 UI |
| 素材源 | 博客 tool=`BLOG_POSTS_DIR`；面试 tool=`BLOG_POSTS_DIR` + `knowledges/` | Blog 不进 amiri git，路径走环境变量 |
| 切分器 | `splitByHeaders`（自实现，切到 `###`，metadata 带完整标题路径）-> `RecursiveCharacterTextSplitter` | 两段式；langchain.js 无 `MarkdownHeaderTextSplitter` |
| 批注预处理 | `> 【clerimia：】 xxx` -> `**[clerimia 注]** xxx`，splitter 前 | (β) 标记保留 |
| 切分参数 | `chunkSize=1000, chunkOverlap=200`（字符） | 后续 benchmark 调参 |
| embedding | Ark 豆包 `doubao-embedding-vision`，**2048 维** | 修正 #3 决策 5c：非 OpenAI 直连，走 Ark OpenAI 兼容接口；1024 维那款是 text 系列，vision 系列是 2048 |
| 检索方式 | 混合检索（dense + sparse + RRF 融合），**Qdrant 服务端 fusion（m2）** | Qdrant 1.10+ Query API `prefetch` + `fusion: "rrf"` |
| BM25 | sparse vector 存 Qdrant（`{indices, values}`），入库前 jieba 分词 + BM25 tf/idf | 服务端 sparse fusion；#13 修正 #4 §2.2：m1/m2 都要自己算 sparse，m1 让 Qdrant 退化成向量存储层不合理 |
| rerank | 不做 | 档位 1 体量小，无收益 |
| tool 返回 | 结构化 markdown 给 LLM + `details` 旁路 JSON 给前端 | f2-B，f1 增强版 |
| tool 调用 | agent 自主调（t1，Agentic RAG） | 非"每次先检索" |
| tool 命名 | 参数化 `search(collection: "blog" \| "interview")` 单 tool | #8 grilling 决定合并 |
| 两个 tool 差异 | pipeline 实现共享；差异仅在素材源/collection/tool description | 检索参数暂不差异化 |

## 1. 摄入链路（A 段）

### 1.1 形态

- 两个一次性摄入脚本：`scripts/ingest-blog.ts`、`scripts/ingest-interview.ts`
- 各自全量重建对应 Qdrant collection（drop + reindex，不做增量 upsert）
- 共用一份 ingestion 逻辑（loader + 预处理 + splitter），封装在 `.pi/extensions/lib/rag-ingest.ts`
- 不做成 Pi tool / 不做上传 UI（摄入是开发者手动行为）

### 1.2 素材源

- 博客 tool：`Blog/source/_posts/`（Hexo 博文树）
- 面试 tool：`Blog/source/_posts/`（含简历 `关于我.md`） + `knowledges/`（题库，空壳待建）
- `knowledges/`：仓库根，进 git（public，当前空壳，建目录 + `README.md` 占位），脚本写死相对路径 `./knowledges`
- `Blog/source/_posts/`：不进 amiri git（Blog 是独立项目），路径走环境变量 `BLOG_POSTS_DIR`，`.env.example` 给默认值 `./Blog/source/_posts`

### 1.3 切分

- **第一段**：自实现 `splitByHeaders`（#7 已落，langchain.js **无** `MarkdownHeaderTextSplitter`），切到 `###` 级，metadata 带完整标题路径（如 `["## 1. AgentLoop", "### 核心循环引擎 runLoop()"]`）
- **批注预处理**（在 splitter 前）：`> 【clerimia：】 xxx` -> `**[clerimia 注]** xxx`，(β) 标记保留。两个 tool 共享此预处理
- **第二段**：`RecursiveCharacterTextSplitter`，`chunkSize=1000, chunkOverlap=200`（字符）
- 单位选字符而非 token：langchain 默认行为，最少配置；后续 benchmark 若召回差可换 token 计数

### 1.4 衍生事实（给后续实现 ticket）

- collection 维度 = **2048**（豆包 `doubao-embedding-vision`；1024 是 `doubao-embedding-text` 系列）
- Qdrant collection schema（m2 混合检索）：**named vectors** `dense: {size: 2048, distance: Cosine}` + **sparse_vectors** `sparse: {}`（sparse 不需要声明维度）
- Ark embedding API 每请求 input 上限 **10**，账户级 QPS 有限 → `batchSize=10, maxConcurrency=1`（#7 实测确认）
- QdrantVectorStore 未提供 `collectionConfig` 时自动探测 embedding 维度（Cosine 距离）；但 m2 下我们不用 `fromDocuments` 一把梭，需要显式声明 named vectors + sparse_vectors（走 Qdrant JS client 建 collection）
- ingestion metadata schema：`{ source: string, section: string, ... }`（source=文件名，section=标题路径），检索回来填 `details.sources`

## 2. 检索链路（B 段）

### 2.1 embedding

- Ark 豆包 `doubao-embedding-vision`，**2048 维**，volcengine provider
- 接口走 OpenAI 兼容（`api_base` + `api_key`），用 langchain.ts 的 `OpenAIEmbeddings`（`configuration.baseURL` 指向 Ark）
- **修正 #3 决策 5c**：原说"OpenAI text-embedding-3-small（1536 维）"，实际是 Ark 平台的豆包 embedding（2048 维）。`doubao-embedding-text` 系列才是 1024 维；vision 系列是 2048。架构不变（langchain OpenAI 适配器照常用），仅维度和模型名变
- **API 限制**（#7 衍生事实）：每请求 input 上限 10、账户级 QPS 有限 → 批处理时 `batchSize=10, maxConcurrency=1`

### 2.2 混合检索（B2）—— m2 Qdrant 服务端 sparse fusion

- **主决策**：混合检索（dense + sparse），**服务端融合（m2）**
- **实现**：Qdrant 1.10+ Query API `prefetch` + `fusion: "rrf"`，一次请求由 Qdrant 完成 dense retrieval + sparse retrieval + RRF 融合
- **collection schema**：named vector `dense`（2048 维 Cosine）+ sparse vector `sparse`（`{indices, values}`）
- **sparse 侧构造**（入库前预处理，见 §3.3 D-2）：
  - jieba 分词切中文
  - 全局遍历统计 df，算 IDF：`log((N - df + 0.5) / (df + 0.5) + 1)`
  - 建 `term_str → int_id` 词典（Qdrant sparse vector 的 index 必须是 int）
  - 每个 doc 输出 sparse `{indices: number[], values: number[]}`，权重用 **BM25 tf/idf**（k1=1.2, b=0.75）
- **修正 #4 §2.2 原否 m2 的理由**：原理由是"Ark 只提供 dense，sparse 侧要自己造，m1 客户端 RRF 更简单"。实际上 m1 也要自己算 sparse（jieba + BM25 权重）——差异只是"算出来的东西存哪"：
  - m1：内存里活着，包一层 langchain `BM25Retriever` + `EnsembleRetriever`；Qdrant 退化成"只做向量的存储层"
  - m2：按 Qdrant sparse vector 格式存进 Qdrant，服务端一次查完
  - 选了 Qdrant 却让它退化成向量存储层不合理——那 sqlite + sqlite-vss 也够
- **另一个推手**：langchain 的 `BM25Retriever.preprocessFunc` 是 private（#10 调研产物），中文分词只有"入库前预处理"一条路，进一步逼向"自己算 sparse"——那存进 Qdrant 就是自然选择

### 2.3 RRF 原理（面试核心，L3）

要解决的问题：cosine 分（∈[0,1]）和 BM25 分（无界）量纲不同，不能直接相加。

公式：
```
RRF_score(doc) = Σ  1 / (k + rank_i(doc))
                over all retrievers i
```
- `rank_i(doc)` = 文档在检索器 i 的名次（第 1 名 rank=1）
- `k` 平滑常数（常取 60），让头部名次差距不被放大，鼓励"多检索器共同召回"的文档胜出
- **绕过归一化**：用排名替代分数，排名无量纲可加

为什么不选加权平均：要选 α + 归一化策略（min-max/z-score/除以 max），都是坑，且不同 query 最优 α 不同。

**本项目实现路径**：Qdrant 服务端 Rust 实现（`fusion: "rrf"`）。langchain `EnsembleRetriever` 走的是**加权 RRF**（`weight / (rank + c)`，c 默认 60，按 pageContent 去重），是 RRF 的一个变体（每个检索器带权重）——m2 下不用它，作为参考知识保留（#10 调研产物）。

### 2.4 rerank（B3）

不做。档位 1 体量小（9 篇博文），混合检索 RRF top-5 精度够。rerank 是召回量大、噪声多场景（百万文档级）才显著有用。后续 benchmark 若发现噪声大再加（纯增量，在 retriever 和 agent 之间插一层）。

### 2.5 检索参数

- prefetch 各 20（`prefetch: [{using: "dense", limit: 20}, {using: "sparse", limit: 20}]`）
- fusion 后最终 top-k = 5（`limit: 5`）
- 两个 tool 检索参数暂不差异化，共享一套

### 2.6 检索结果消费（B4）

- **t1 Agentic RAG**：agent 自主决定调检索 tool，不查就直接回（对齐地图"Agentic RAG"目标）
- **tool 返回形态**（f2-B，f1 增强版）：
  ```typescript
  return {
    content: [{
      type: "text",
      text: results.map((r, i) =>
        `### 结果 ${i+1}\n**来源**: ${r.source}\n**章节**: ${r.section}\n\n${r.content}`
      ).join("\n\n---\n\n")
    }],
    details: {
      count: results.length,
      collection: "blog",
      sources: results.map(r => ({ source: r.source, section: r.section }))
    }
  };
  ```
- `content` 给 LLM（结构化 markdown，agent 能引用"结果 2"）
- `details` 旁路给前端（j1 来源卡片渲染），不进 LLM 主内容
- **Pi tool 返回类型约束**：`content` 是 `(TextContent | ImageContent)[]`，只支持 text/image，无 JSON 类型；故"结构化"靠 markdown 表达，不是任意 JSON 对象

## 3. langchain.ts 边界（D 段）

### 3.1 明确使用（RAG 组件层）

- loaders（读 markdown）
- `RecursiveCharacterTextSplitter`（标题路径切分自实现，见 §3.3 D-4）
- `OpenAIEmbeddings` 适配器（指向 Ark，`configuration.baseURL`）
- `QdrantVectorStore`（作为 dense 存储；m2 下**不用** `asRetriever`——检索走 Qdrant 原生 Query API）
- **jieba 中文分词包**（`@node-rs/jieba` 或 `nodejieba`）——sparse vector 构造用

### 3.2 明确不用

1. **Chain 抽象**（`LLMChain`/`RetrievalQAChain` 等）--agent 编排归 Pi
2. **Agent 抽象**（`AgentExecutor`）--agent 框架是 Pi，不能并存
3. **Memory 抽象**（`BufferMemory` 等）--对话历史由 Pi session 管理
4. **高级 Retriever**（`SelfQueryRetriever`/`MultiQueryRetriever`/`ContextualCompressionRetriever`）--档位 1 用三件套够
5. **`BM25Retriever` / `EnsembleRetriever`**（m2 决策）--sparse retrieval + RRF fusion 走 Qdrant 服务端
6. **`MarkdownHeaderTextSplitter`**（langchain.js **没有这个类**，Python 才有；JS 只有 `MarkdownTextSplitter` = Recursive 变体）--标题路径切分自实现（D-4）
7. **自己训 embedding**--用 Ark 豆包
8. **非 Qdrant store**（`InMemoryStore`/`docstore`）--vector store 只 Qdrant
9. **Output parser / 结构化输出**--LLM 输出直接是文本，Pi agent 自己组织
10. **Document Transformer 现成组件**（`LongContextReorder`/`EmbeddingsFilter`）--和 B3 不做 rerank 一致
11. **Callbacks / Tracing**--可观测走 Pi event + 自己日志
12. **Prompt templates**--agent prompt 由 Pi session 管

### 3.3 薄封装点（自己写一层，落 `.pi/extensions/lib/`）

- (D-1) **批注预处理函数** `preprocessAnnotations(md)`：splitter 前（#7 已落）
- (D-2) **sparse vector 构造**：jieba 分词 + IDF 表 + term 词典（`term_str → int_id`）的持久化；查询侧同样 jieba 切词 → 查词典 → 生成 `{indices, values}`。摄入侧落在 `rag-ingest.ts`，查询侧落在 `rag-retrieve.ts`，词典 + IDF 表以 JSON 持久化（具体形态由 #14 决定）
- (D-3) **检索结果 → tool 返回值转换**：`Document[]` → `{content: [{type:"text", text: markdown}], details: {count, collection, sources}}`，在 tool execute 里
- (D-4) **`splitByHeaders`**（#7 已落）：langchain.js 无 `MarkdownHeaderTextSplitter`（Python 有，JS 只有 `MarkdownTextSplitter` = Recursive 变体），标题路径切分自实现——按 `#/##/###` 切段，每段 metadata 带完整标题路径

### 3.4 代码组织

```
.pi/extensions/
  lib/
    rag-ingest.ts      # loader + preprocessAnnotations + splitByHeaders + sparse 词典/向量构造
    rag-retrieve.ts    # Qdrant Query API 调用 + query 侧 sparse 构造 + 结果转换
  search-rag.ts        # 参数化 search(collection) tool（import lib）
scripts/
  ingest-blog.ts       # import ../.pi/extensions/lib/rag-ingest
  ingest-interview.ts  # 同上
  lib/
    sparse-dict/
      blog.json        # term 词典 + IDF 表（#14 产物）
      interview.json
knowledges/
  README.md            # 面试题库占位
```

## 4. 两个 tool 的共享与差异（E 段）

### 4.1 共享

ingestion pipeline 实现、切分参数、embedding、混合检索配置、不做 rerank、tool 返回形态、薄封装代码位置。

### 4.2 差异

- 素材源（见 1.2）
- collection 名（各自一个）
- tool description（`search(collection)` 单 tool，description 里根据"博客 vs 面试"语义分别描述适用场景）
- system prompt（必然不同，具体内容留给后续 tool 实现 ticket）

### 4.3 检索参数

暂不差异化，共享一套。后续用了再评估是否要差异（如 top-k）。

## 5. 原理清单 + 面试深度（C 段）

目标深度：**L2 为主（能讲取舍），少数核心 L3（能讲原理细节/推演）**。

### 5.1 切分层（L2）

- 为什么用**标题路径切分 + `RecursiveCharacterTextSplitter`** 两段式，不只用 recursive（附：为什么要自实现 `splitByHeaders`——langchain.js 无 `MarkdownHeaderTextSplitter`）
- chunk size 1000 / overlap 200 的依据
- chunk overlap 的作用（避免边界句子/代码块被劈成两半）
- `RecursiveCharacterTextSplitter` 的分隔符递归机制（`["\n\n","\n"," ",""]`）
- 切分单位：字符 vs token 的差异

### 5.2 Embedding 层（L2，5 可选 L3）

- embedding 是什么（文本->向量，语义相近向量相近）
- dense embedding vs sparse（稠密捕语义 vs 稀疏捕关键词）
- 为什么用 Ark 豆包而非本地模型
- 维度 2048 是什么意思、降维的 trade-off
- embedding 模型训练原理（对比学习、负采样）-- L3 可选

### 5.3 向量检索层（L2，3.3 为 L3 核心）

- cosine 相似度 vs 欧氏距离 vs 点积，为什么 RAG 常用 cosine
- ANN 是什么、为什么不暴力搜
- **HNSW 原理**（跳表分层、上层粗检索下层精排、复杂度）-- **L3 核心**
- HNSW 参数（M、efConstruction、efSearch）对召回/速度的影响

### 5.4 BM25 + 混合检索层（L2，4.2/4.5 为 L3 核心）

- BM25 是什么（TF-IDF 改进，加了 IDF 平滑 + 文档长度归一化）
- **BM25 公式项含义**（TF 项、IDF 项 `log((N-n+0.5)/(n+0.5))` 的 +0.5 是 Lidstone 平滑、文档长度归一化项）-- **L3 核心**（本项目 sparse 权重实际用了这个公式）
- 为什么中文 BM25 要分词
- 为什么不能直接把 cosine 分和 BM25 分相加（量纲不同）
- **RRF 原理**（倒数排名替代归一化，k=60 作用）-- **L3 核心**
- 为什么不用加权平均（要调 α + 归一化坑）
- **实现深度定位**：m2 决策下 BM25/RRF 实现细节是 Qdrant 服务端黑盒（Rust 实现），L2 靠公式讲清楚；L3 深度（"Qdrant 是怎么算的"）要主动回头**读 Qdrant Rust 源码**——已进地图迷雾，RAG 主线跑通后再做

### 5.5 检索结果消费层（L2）

- 为什么 tool 返回 markdown 文本给 LLM 而非结构化 JSON（Pi tool content 约束：`(TextContent|ImageContent)[]`）
- 为什么旁路 JSON 走 details（前端来源卡片，j1）
- **Agentic RAG vs 传统 RAG**（agent 自主决定调检索 vs 每次先检索）

### 5.6 数据层（L2）

- 为什么用 Qdrant 而非 ES/FAISS
- collection / vector / payload 概念
- 为什么全量重建而非增量 upsert（档位 1 体量小）

### 5.7 RAG tool vs 内置 grep/find/read（w-A 沉淀，L2）

**本质区别**（5 条）：

1. **语义检索 vs 字面检索**：grep 只能找字面包含关键词的文档；向量检索能找语义相近但零字面重合的。知识库问答场景用户提问和知识库内容措辞常不同，grep 漏召回。
2. **预计算索引 vs 运行时扫描**：grep 每次遍历文件，知识库大时慢；RAG 摄入时建索引，查询 O(log N) 或 ANN 近似检索。档位 1 体量小是偶然，不是 RAG 设计目标。
3. **预切分相关 chunk vs 整文件**：grep 返回整文件或片段，agent 自己读自己判断相关性，context 占用大；RAG 返回预切分的相关 chunk（带来源标注），agent 直接拿"已判定相关"的精炼片段。
4. **知识库物理隔离 vs 全文件系统**：grep 搜全文件系统（含 `.git`/`node_modules`/源码），靠 prompt 限制路径脆弱；RAG tool 检索预定义 collection，物理隔离（面试 tool 查 interview collection，不会搜到无关代码）。
5. **agent 认知负担**：grep/find/read 要 agent 自己规划检索策略（先 find、再 grep、再 read、再判断），多轮 tool 调用每轮耗 LLM 推理；RAG tool 单轮（"搜 XX"-> 返回相关 chunk），agent 把精力放在"用结果回答"而非"怎么找文件"。

## 6. 衍生给后续 ticket的事实

- **后续 RAG 实现 ticket**：`.pi/extensions/search-rag.ts`（参数化 `search(collection)` 单 tool） + `lib/`，按本文档拆摄入/检索/collection schema
- **后续环境变量 ticket**：`.env.example` 加 `BLOG_POSTS_DIR`（+ 具体 env 变量清单 + zod 校验）
- **sparse 词典**：本地 JSON 持久化（`scripts/lib/sparse-dict/{blog,interview}.json`），进 git（具体形态由 #14 决定）
- **docker-compose.yml**：开发态 Qdrant 编排（`v1.11.3`，支持 sparse vectors；#6 已交付）

## 7. 尚未明确（进地图）

- **benchmark 调参**：chunk size/overlap、top-k/prefetch limit、RRF k 等，RAG 跑通后做 benchmark 优化
- **`knowledges/` 内容形态**：当前空壳，以后填八股题库时再定具体形态（题面/答案/个人作答/复盘标注）及脱敏策略
- **原理沉淀写进博客**：本文档完善后写进 `Blog/source/_posts/` 作为博文发布
- **来源卡片跳转原文（j2）**：`details.sources` 是否要带 chunk 在原文件的位置（行号/锚点）供前端跳转，待前端实现时评估
- **Qdrant sparse fusion Rust 源码深挖**：m2 下 BM25/RRF 服务端实现细节黑盒，L3 学习靠回头读 Qdrant Rust 源码——RAG 主线跑通后做
