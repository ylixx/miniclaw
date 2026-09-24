# OpenCode 与 MiniAgent 对比分析

> 调研对象：`github.com/anomalyco/opencode`（Anomaly / 原 SST 团队出品，"The open source AI coding agent"）
> 对标对象：本仓库 `miniagent`（v2.1，面向 4B 小模型的 Web 办公 Agent）
> 日期：2026-09-22

---

## 1. OpenCode 是什么（调研结论）

| 维度 | 事实 |
|---|---|
| 定位 | 终端优先（TUI）的开源 AI 编程 Agent，另有桌面端（Beta）与 IDE 扩展（Cursor / VSCodium / VS Code / Windsurf） |
| 规模 | ~190k GitHub star，900+ 贡献者，14k+ commits，README 译 22 种语言 |
| 技术栈 | TypeScript + Bun；服务端 Hono + Effect（逐步迁移到 Effect 架构）；桌面端 SolidJS + Vite；TUI 早期用 Go，正迁回 TS |
| 架构 | **客户端/服务端解耦**：服务端跑在本机处理 AI / 文件 / 状态，客户端（TUI、桌面、移动端、IDE）经 ACP / SDK / V2 协议连接，多客户端可连同一服务端 |
| 模型 | **75+ 提供商**经 Models.dev 接入（Anthropic / OpenAI / Google / Bedrock / 本地 Ollama 等），支持 BYOK、GitHub Copilot 登录、ChatGPT Plus/Pro 登录、OpenRouter 聚合 |
| 工具 | 内置 bash / edit / read / write / grep / glob；**内置 LSP**（实时诊断、hover、跨语言代码智能）；**MCP**（本地 + 远程，含 OAuth） |
| Agent 模式 | `build`（默认全权限）/ `plan`（只读、默认拒绝改文件）/ `general`（内部子 Agent，`@general` 调用）；支持多会话并行 |
| 隐私/合规 | 不存储代码与上下文；但**无 SOC2 / HIPAA 等认证** |

---

## 2. 核心定位对比

| 维度 | OpenCode | MiniAgent |
|---|---|---|
| 目标用户 | 开发者（终端/IDE 工作流） | 办公/轻量自动化用户（浏览器） |
| 主交互形态 | 终端 TUI + 桌面 + IDE | Web 三栏 UI（浏览器） |
| 模型取向 | 强编程大模型（Claude/GPT/Gemini…）+ 75+ 商 | 面向 **4B 小模型**（本地优先）+ 7 家商 |
| 核心工具 | 代码 edit / bash / LSP / grep / glob | 文件 + **文档(csv/json/md)** + shell + 文本 |
| 多模型管理 | Models.dev 自动枚举、Copilot 登录 | 手动添加 provider（含 Agnes 多模态） |
| 工作区 | 单项目（当前目录） | **多项目 + 任务 + 历史持久化** |
| 可扩展 | MCP + Skills + 插件生态 | MCP + 参数化 Skills + 技能包 zip 热装 |
| 多模态 | 仅读取截图（视觉输入） | **视觉分析 + 图像生成/编辑**（Agnes） |
| 部署形态 | 本地 CLI / 桌面 / 远程服务端 | 本地 Node 服务 + 浏览器 |

---

## 3. OpenCode 的优势

1. **生态与社区碾压**：190k star、900+ 贡献者，文档、翻译、第三方集成齐全，问题响应快。
2. **模型覆盖极广**：75+ 提供商 + Models.dev 自动枚举 + Copilot/ChatGPT 订阅复用 + OpenRouter，选型自由度最高。
3. **代码理解能力原生**：内置 LSP，实时诊断/ hover / 跨语言智能，对"改代码"类任务质量显著高于纯文本工具。
4. **架构先进且解耦**：客户端/服务端分离，支持远程跑在强机器、轻客户端控制，甚至移动端/多端协同；ACP/SDK 协议便于嵌入 IDE。
5. **Agent 工程成熟**：build/plan 双模式（plan 默认只读防误改）、多会话并行、`general` 子 Agent 分工，长任务可靠性更好。
6. **MCP 远程 + OAuth**：能直接连 Sentry / GitHub / Linear 等需鉴权的远程 MCP，企业/团队场景友好。
7. **隐私承诺清晰**：不存储代码与上下文，便于合规敏感环境。

## 4. OpenCode 的缺陷 / 局限

1. **终端优先门槛高**：非开发者 / 办公用户上手成本高，键盘驱动 TUI 不适合普通业务人员。
2. **编程专精、办公弱**：无 CSV/JSON/Markdown 等办公文档工具，不做内容创作，对"办公自动化"帮助有限。
3. **无图像生成**：仅支持"看图"（视觉输入），不具备文生图/图生图能力。
4. **小模型不适配**：面向强编程大模型优化，未经 4B 小模型的极简 prompt / 严格格式解析 / 保序裁剪等专门调优。
5. **配置摩擦**：需自管 API Key 或多账号登录，多提供商计费复杂；桌面端仍 Beta。
6. **合规缺口**：无 SOC2 / HIPAA，企业采购有硬约束。
7. **技术栈偏重**：Bun + Effect + Vite + SolidJS 体系复杂，二次开发/自托管门槛高于极简栈。

---

## 5. MiniAgent 的优势（相对 OpenCode）

1. **零门槛 Web UI**：浏览器即用，三栏布局（项目/任务/历史 + 聊天 + 日志），普通办公用户无需终端。
2. **小模型优化到位**：极简 prompt、严格格式解析、自动修复、保序裁剪，专门适配 4B 本地模型，消费级硬件可跑。
3. **办公文档工具原生**：CSV / JSON / Markdown 表格 / 文本统计替换摘要，贴合办公自动化场景。
4. **多项目工作区 + 历史持久化**：项目/任务分层、切换自动恢复对话，适合多客户/多事项并行。
5. **参数化 Skills 系统 + 技能包热装**：指令注入真正生效，支持 zip 一键安装与自定义，可沉淀复用工作流。
6. **多模态内容创作**：已接入 Agnes 视觉分析 + 图像生成/编辑，OpenCode 不具备。
7. **极简可维护栈**：Node + Express + ws + 原生 JS，无构建步骤，依赖少，易读易改、自托管成本低。
8. **安全基线**：路径防穿越、读写限额、guarded 权限模式，本地化部署可控。

## 6. MiniAgent 的缺陷（相对 OpenCode）

1. **无代码智能（LSP）**：做"读/改代码"类任务质量远低于 OpenCode，缺诊断/补全/跨文件理解。
2. **模型商覆盖少**：仅 7 家且手动配置，无 Models.dev 自动枚举、无 Copilot/ChatGPT 登录、无 OpenRouter 聚合。
3. **无 plan/build 双 Agent、无多会话并行**：长任务可靠性、分工能力弱于 OpenCode。
4. **单一 Web 形态**：无终端/桌面/IDE/移动端，无客户端-服务端解耦，无法远程/移动控制。
5. **MCP 能力较弱**：支持 stdio + HTTP（含 headers），但**无远程 OAuth**，连 Sentry/GitHub 等鉴权服务不便。
6. **无流式 token 输出体验打磨**：REST 返回结果、WS 推事件，缺边打字边出的沉浸式交互。
7. **无编辑撤销/重做、无会话分享链接**：迭代与协作体验弱。
8. **社区/生态为零**：仅自有项目，文档与第三方集成稀缺。
9. **同样缺企业合规认证**：与 OpenCode 同短板。

---

## 7. 可从 OpenCode 借鉴的设计点（优先级排序）

| 优先级 | 借鉴点 | 对我们的价值 | 落地成本 |
|---|---|---|---|
| 高 | **plan / build 双 Agent 模式**（plan 默认只读） | 降低误改风险，先规划后执行，契合"先说再做" | 低（复用 guarded 模式扩展） |
| 高 | **更多模型商 + 自动枚举**（仿 Models.dev） | 提升选型自由度，降低手动配置摩擦 | 中 |
| 中 | **远程 MCP + OAuth** | 接入 Sentry/GitHub/Context7 等企业服务 | 中 |
| 中 | **流式 token 输出**（SSE/WS 增量） | 提升交互沉浸感 | 低 |
| 中 | **编辑撤销/重做 + 会话分享链接** | 提升迭代与协作体验 | 中 |
| 低 | **客户端/服务端解耦 + 移动端** | 远程/多端控制 | 高 |
| 低 | **LSP 接入**（若扩展编程场景） | 代码任务质量 | 高 |

---

## 8. 结论与建议

- **赛道不同，非直接竞品**：OpenCode 是"开发者终端编程 Agent"，MiniAgent 是"小模型 Web 办公 Agent"。不应以功能数量直接比拼，而应取其对架构与工程的成熟经验补强我们。
- **我们的护城河**：Web 零门槛、4B 小模型优化、办公文档工具、参数化 Skills、Agnes 多模态创作、极简可维护栈。这些 OpenCode 不会替我们做。
- **最大短板**：缺代码智能（LSP）、模型商覆盖窄、无 plan 模式与多会话、MCP 无 OAuth。建议按上表优先级渐进补齐，**首推 plan/build 双模式 + 模型商自动枚举**，投入产出比最高。
- **不建议**：盲目跟进终端 TUI / 桌面端 / 移动端——与我们的 Web 办公定位不符，ROI 低。

> 备注：OpenCode 数据来自其 README、官网与公开索引（star/contributor 数为厂商自报，可能存在口径差异）；MiniAgent 数据来自本仓库 README 与 `server/index.js` 实际代码。
