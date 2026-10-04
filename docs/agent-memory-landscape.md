# Agent Memory 业界对标调研

> 2026-09-24 · 性质：**外部方案 field study + 社区讨论观点评估**，回答「FlareMo Memory Ledger 该吸收什么、拒绝什么」。
>
> **结论先行**：业界没有收敛于存储形态（Markdown / JSONL / SQLite / Postgres 都有人做），但已收敛于**操作语义**——被动采集、要点注入、原文按需、事实与推断分层、人持删除权。FlareMo 五条全中且在其中两条（人审闸门、负样本）走在前面；下一步不是加表加层，而是给被动链路装「校准仪表」。
>
> 与本文配套：目标态设计 [memory-ledger-design.md](./memory-ledger-design.md)、接入实践 [agent-memory.md](./agent-memory.md)。

## 一、调研背景与方法

起点是一段 X 帖社区讨论：围绕「agent 长期记忆怎么做」，回复中出现了若干设计主张（分层、被动维护、只记要点）和五个被点名的对象。本文对五个对象做了一手调研（仓库 README / 官方文档 / 论文），并把社区观点逐条与 FlareMo 现状对照。

每条结论标注证据来源；社区观点一律按「假设/田野报告」对待，不当权威引用。

## 二、五个对标对象

| 对象 | 本质 | 核心机制 | 与 FlareMo 最近对应物 | 值得借鉴点 |
|---|---|---|---|---|
| [wallaby-agent-rules](https://github.com/Dawncoral/wallaby-agent-rules) | 纯 Markdown 约定（5★） | `AGENTS.md` 强制每 session 读 `MEMORY.md`+`NOW.md`；`INDEX.md` 每文件一行做「查找而非搜索」；冲突时**文件赢、只标记不静默合并**；每周 `health_check.py` 查漂移 | `seed` 的输入源形态；lens 的「开工必读」约定 | 「记忆是习惯不是功能」；冲突只标记不合并与我们 `contradicts` 关系同构 |
| [pi-memory / Jarvy](https://github.com/AzzzGoodFish/pi-memory) | pi-mono 扩展，仿生上下文管理（0★，86 个测试） | 双速 EMA（fast α=0.5 / slow α=0.9 余弦散度）检测话题切换 → 已完结 episode 压成结构化片段入冷库（带 archive ID 溯源）；海马体三路召回（语义/词法/符号）融合后每次 LLM 调用前注入 `<recalled>`；上下文占用率 0.45 触发冷却、0.85 急停 | session-stop checkpoint + dreaming 提炼 + recall 融合检索 | 全被动链路的真实样本；写入路径做语义去重（cosine ≥0.92 合并） |
| [Hindsight](https://github.com/vectorize-io/hindsight)（[论文](https://arxiv.org/pdf/2512.12818)，ACL 2026 demo） | 结构化记忆基质，Postgres+pgvector（13.3K★） | **四网络分离**：world fact / experience / observation（实体级滚动摘要）/ opinion（带置信度的演化信念）；retain/recall/reflect 三操作；TEMPR 四路并行检索（向量+BM25+图遍历+时态过滤）；LongMemEval 83.6%→91.4% | 四网络 ≈ 我们的 items(semantic)/episodes/observed/inferred 分层；reflect ≈ dreaming | 最有分量的共识：**事实与信念必须分层**。它用置信度，我们用人审——项目规矩场景人审更对 |
| [NowledgeMem](https://mem.nowledge.co/docs) | 本地优先图谱式个人上下文管理 | Knowledge Tree（memories/conversations/wiki/working memory/artifacts）；Background Intelligence **每日写 Working Memory 简报**供 session 开始加载；**pre-compaction capture**（上下文压缩前先存 transcript）；session capture 每次响应后跑、异步幂等 | lens ≈ 每日简报（但多一道策展）；session-stop hook ≈ capture | 形态最近的对标物；pre-compaction 是我们没有的采集点 |
| ChatGPT memory（[逆向工程分析](https://lin-guanguo.github.io/llm-memory-research/reverse-engineer/chatgpt-memory-reverse-engineering/)、[官方 FAQ](https://help.openai.com/en/articles/8590148)） | 产品级四层注入 | prompt 固定四层：会话元数据（ephemeral）→ 用户记忆（专用 tool 存取的显式事实，**用户可见可改**）→ 近期对话摘要（标题+片段）→ 当前会话；saved memories **无向量库无 RAG**；Codex 本地版落 `~/.codex/memories/` 文件、提取时脱敏、**会话闲置足够久才总结**、per-chat 可关读写 | lens = 常驻画像块；recall = 按需检索；Web `/memory` = 可见可删的管理面 | 「最佳实践」的真相是**极度克制**：小块画像永远注入、其余按需、用户可见可删 |

### 两点补充事实

- 「codex / claude code 都没在记忆上花精力」这一社区前提已过时：Codex 现有 `~/.codex/memories/`（脱敏、闲置延迟总结、per-chat 开关），Claude Code 有 CLAUDE.md + auto memory。两家都收敛到「本地文件 + 后台生成」形态。
- Hindsight 的 opinion 网络会随证据自动涨置信度；这是「用户画像」场景的合理设计，但在「项目规矩」场景里，**AI 越来越自信地错**比忘了更危险——这是我们保留人审而非置信度自动晋级的理由。

## 三、社区观点逐条对照

### 3.1 「只记要点，原文按需翻阅」

社区主张：不记实际内容（模型本身已内容过载）、要点放最前、需要原文让模型自己翻。

FlareMo **已做对**：lens 编译单行原子事实（实测 ~400 字符 / ~120 tokens），evidence / resource_links 是数据层随取随用，`checkpoint` 存 episode 战报而非全文。与 ChatGPT 的「画像块常驻 + 历史按需」同构。

反向警示（「80% 的所谓记忆都是垃圾，重要的记数据库不散落 md」）：md 不会脏数据库，但会脏 agent 的行为规约——我们仓库内就存在全局 skill 副本落后于仓库版、docs 滞后实现的漂移（P3 已知项）。**md 可以是门面，不能是账本。**

### 3.2 「被动式维护，人不需要感觉」

社区主张：生成/更新/激活三环节都尽量 hook + 后台做，不侵入会话；类比大脑后台维护。

FlareMo 的回答比「全被动」更精细——**分层被动**：低风险陈述句被动生效（`observed` 直进锦囊），祈使句/冲突内容被动生成但激活前必须人审（`inferred` 进审核箱）。v2.4 路由（陈述→observed、祈使/冲突→inferred）就是这个原则：**噪声便宜的地方自动化，噪声危险的地方留闸门。** 单人小项目可以「自动采集自动注入无审核」，放大到多 agent 共享账本就会变成污染源放大器。

### 3.3 「团队记忆需要分层 / 分段执行」

社区描述的模式：分主体记忆规则、分块记忆规则、web 端只读分析与任务发布、agent 分段执行。

FlareMo 逐项有对应：scopes（global/workspace/project/agent）= 分主体，fact_key = 分块，MCP recall/compile = 只读分析面，Web 审核箱 = 治理面，episode 战报 = 分段推进。**真正的缺口是 task 维度**：一段 bounded 任务的目标/验收/产出目前只能散在 episode 文本和 resource_links 里，不能像 fact_key 一样被精确检索与断代。

### 3.4 怀疑论与价值实证

- 「搞明白人脑之前长期记忆都要打问号」——成立，但 FlareMo 不主张仿生：它是**治理账本**而非认知模拟，目标不同，怀疑不成立。
- 「没有最佳实践」——对一半：存储形态没共识，操作语义在收敛（见文末结论）。
- 「删掉的代码隔天要加回来，靠记忆还原」——我们的 `recall --as-of` 时态穿梭 + revision 快照 + restore 就是干这个的，且比隐式记忆可控；属于差异化资产。

## 四、生成 × 更新 × 激活：3×2 矩阵体检

用社区提出的三阶段框架给 FlareMo 打分——**覆盖是全的，差距在校准**：

| | 主动式 | 被动式 |
|---|---|---|
| **生成** | `remember` / `checkpoint` / `seed` / MCP create | session-stop hook 战报、Dreaming 提炼、seed 扫描 |
| **更新** | Web 裁决 / modify / forget、同键自动断代 | 冲突巡检（周一）、六件 cron 维护、写时自动 supersede |
| **激活** | `recall`（FTS+向量 RRF）、`lens`、`status` | SessionStart 注入 lens、checkpoint 上下文、compile archives |

薄弱点不在格子有没有填，而在：

1. 被动生成的**精度**（dreaming 提炼质量）；
2. 被动激活的**相关性**（lens 排序与预算分配）；
3. 更新路径的**断代完整性**（`linkMemory`/`forgetMemory` 半断代、`appendRevision` 幻影快照——P2 已知项）。

## 五、最佳实践结论

### 已做对、不要动的

1. **要点常驻 + 原文按需**（lens 预算制 vs evidence/recall）。
2. **事实/信念分层 + 人类闸门**（observed vs inferred + 审核箱）——Hindsight 用置信度，我们用人审，项目规矩场景人审更对。
3. **冲突只标记不静默合并**（`contradicts` 关系 + 巡检入箱）。
4. **负样本 + 双时态断代**——调研对象里没人有，差异化优势。

### 值得吸收（按优先级）

1. **自动生效条目的定期人审报告**：passive 路径最大风险是审核疲劳 → `observed` 里混进什么没人看。不需要每条审，定期给用户一份「这段时间自动生效了哪些」的清单。工程量小，是防被动污染的关键补丁。
2. **pre-compaction capture**（NowledgeMem）：harness 做上下文压缩前先存 transcript/evidence，防「压缩丢决策」。目前没有的采集点。
3. **「闲置后提炼」而非「停笔即提炼」**（Codex）：session-stop 立即 checkpoint 可能把半成品当终稿。现有 daily dreaming 兜底，但 session-stop 落点可标更低优先级或延迟入提炼队列。
4. **task 作用域 / episode 一等公民化**：把 bounded task 的目标→产出→衍生事实用 resource_links 串起来，补团队/多 agent 协作的检索维度。
5. **dreaming 产出向「滚动摘要」演进**（Hindsight observation）：对同一 fact_key/实体的多条 observed 定期压成一条 consolidated 条目占键位，旧条目沉底为 evidence——「要点在前原文随取」在更新维度的延伸。
6. **confidence / mention-count 元数据（弱化版）**：不做自动晋级，只做排序信号——被多次 recall 命中、多 agent 复现的 observed 排前；零命中的进休眠沉降候选。给现有 dormancy 维护更好的输入。
7. **写入路径语义去重**（Jarvy cosine ≥0.92）：现有指纹去重是字符串口径，语义去重是低成本升级点，减 passive 路径重复噪声。

### 不建议采纳的

1. **全被动无审核**：单人可玩，多 agent 共享账本是污染源放大器。混合闸门是对的。
2. **仿生学全套**（EMA 注意力跟踪 / biomimetic 结构）：解决的是「上下文窗口冷却」而非「持久记忆治理」，两个难题别混进账本层。
3. **纯 Markdown 为系统记录**：md 保留为 seed 输入源与人类可读出口，账本在 DB。
4. **置信度自动晋级**：见 §二补充事实。

## 六、与已知 backlog 的关系

本文「值得吸收」清单与既有 P2/P3 缺口互补不重复：

- P2 存量（fetch 超时、5xx 无快照兜底、session-stop 路径假设、半断代、幻影 revision、`evidence.excerpt` 不过筛）仍按原优先级排；
- 新增条目（上表 1-7）属于**被动链路校准**主题，建议聚合为一个迭代单元，先做 1（人审报告）和 7（语义去重），成本最低、直接压被动污染风险。

## 附：参考来源

- <https://github.com/Dawncoral/wallaby-agent-rules>
- <https://github.com/AzzzGoodFish/pi-memory>
- <https://github.com/vectorize-io/hindsight> · <https://hindsight.vectorize.io/> · <https://arxiv.org/pdf/2512.12818>
- <https://mem.nowledge.co/docs> · <https://github.com/nowledge-co/nowledge-mem>
- <https://lin-guanguo.github.io/llm-memory-research/reverse-engineer/chatgpt-memory-reverse-engineering/> · <https://help.openai.com/en/articles/8590148> · <https://learn.chatgpt.com/docs/customization/memories>
