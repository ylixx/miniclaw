---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '662ac6ef-5f07-4334-bb5d-fc64ea1b7b5d'
  PropagateID: '662ac6ef-5f07-4334-bb5d-fc64ea1b7b5d'
  ReservedCode1: '342ad101-0564-4757-b2d0-fcedf47d9ad6'
  ReservedCode2: '342ad101-0564-4757-b2d0-fcedf47d9ad6'
---

# MiniAgent v2.1

专为 4B 小模型设计的办公 Agent 框架，支持多模型提供商。

## 特性

- **项目管理** — 多项目工作区，每个项目独立目录
- **任务与会话历史** — 新建任务、切换任务自动恢复对话，历史持久化
- **MCP 支持** — 标准 Model Context Protocol（stdio + HTTP 真实连接）
- **Skills 系统** — 可参数化激活的任务模板，指令注入真正生效，支持自定义
- **安全防护** — 路径安全模块防止目录穿越，保留设备名拦截，读写限额
- **多模型支持** — Ollama / DeepSeek / 通义千问 / Moonshot / 智谱 / OpenAI / 自定义
- **小模型优化** — 极简 prompt、严格格式解析、自动修复、保序裁剪
- **三栏 UI** — 左导航（项目/任务/历史）/ 中聊天 / 右日志

## 快速开始

```bash
cd miniagent
npm install
npm start
# 浏览器打开 http://localhost:3000
```

## 支持的模型提供商

| 提供商 | 说明 | 推荐模型 |
|--------|------|---------|
| Ollama | 本地部署 | qwen3:4b, minicpm3:4b |
| DeepSeek | 官方 API | deepseek-chat |
| 通义千问 | 阿里云 | qwen-turbo, qwen-plus |
| Moonshot | 月之暗面 | moonshot-v1-8k |
| 智谱 GLM | 智谱 AI | glm-4-flash |
| OpenAI | 官方 API | gpt-4o-mini |
| 自定义 | 任意 OpenAI 兼容 | - |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | 服务端口 |
| `WORK_DIR` | 当前目录 | 工作目录 |
| `CONFIG_DIR` | ~/.miniagent | 配置目录 |

## 内置工具（共 39 个）

| 分组 | 工具 |
|------|------|
| 基础文件 | list_files, read_file, write_file, search_files, create_dir, move_file |
| 文件管理 | file_info, scan_directory, copy_file, append_file, batch_organize, delete_file |
| 命令执行 | run_command, run_script |
| 数据处理 | read_csv, write_csv, read_json, write_json, md_table, text_stats, text_replace, text_summary |
| Word | create_docx, read_docx, docx_to_markdown, replace_docx_text |
| Excel | create_xlsx, read_xlsx, xlsx_to_csv, xlsx_to_markdown |
| PPT | create_pptx, read_pptx, pptx_to_markdown, replace_pptx_text, append_pptx_slide |
| PDF | create_pdf, read_pdf, merge_pdf, split_pdf |

## 工具动态注入（4B 小模型减负）

39 个工具的完整 schema 常驻 system prompt 会吃掉约 5000 token，且候选过多会让小模型选错工具。
因此每次请求**只注入与当前任务相关的 6-14 个工具**（`server/agent/tool-router.js`）：

- **A 技能路由**：激活技能时，注入其步骤所需工具 + 技能对应分组（上限 18）
- **B 意图路由**：无技能时按用户消息关键词判定任务类型（pdf / pptx / xlsx / docx / data / file / command）
- **兜底**：只注入 core 最小闭环（6 个）
- **逃生舱**：模型若调用了子集外但确实存在的工具，引擎自动扩容放行，不会因裁剪而卡死
- **只读模式**：进一步收敛为只读白名单

实测 system prompt 从约 5000 token 降到 1394-2242 token（省 55%-72%）。

## 项目结构

```
miniagent/
├── server/
│   ├── index.js           # 服务入口（含项目/任务/MCP API）
│   ├── agent/
│   │   ├── engine.js      # Agent 引擎（任务历史持久化）
│   │   ├── prompt.js      # Prompt 构建器（技能指令/工作目录注入）
│   │   ├── tool-router.js # 工具子集动态注入（4B 减负）
│   │   ├── parser.js      # 响应解析器
│   │   └── context.js     # 上下文管理（保序裁剪）
│   ├── tools/
│   │   ├── registry.js    # 工具注册表（内置 + MCP 合并、模糊纠名）
│   │   ├── path-guard.js  # 路径安全防护（防目录穿越）
│   │   ├── safety-gate.js # 权限模式 / 危险命令闸门
│   │   ├── file-ops.js    # 文件操作
│   │   ├── organize-ops.js # 文件整理（聚合扫描 + 批量移动/复制）
│   │   ├── doc-ops.js     # 数据处理 / 文本处理
│   │   ├── docx-ops.js    # Word 读写
│   │   ├── xlsx-ops.js    # Excel 读写
│   │   ├── pptx-ops.js    # PPT 读写
│   │   ├── pdf-ops.js     # PDF 生成/读取/合并/拆分
│   │   ├── shell.js       # 命令执行（run_command）
│   │   └── script-ops.js  # 脚本执行（run_script）
│   ├── models/
│   │   └── manager.js     # 多模型管理
│   ├── mcp/
│   │   └── client.js      # MCP 客户端（stdio + HTTP）
│   ├── skills/
│   │   └── loader.js      # Skills 系统（参数化 + 自定义）
│   └── workspace/
│       └── manager.js     # 项目/任务/历史管理
└── web/
    ├── index.html         # 三栏 UI
    ├── styles.css         # 样式
    └── app.js             # 前端逻辑
```

## 项目 / 任务 / 历史

左栏从上到下：项目选择器 → 新建任务 → 任务列表（含历史恢复）。

- **项目**：独立工作区，可绑定不同目录；底部「📁 项目管理」可增删
- **任务**：项目下的会话，切换任务自动恢复其完整对话历史
- **历史**：持久化到 `~/.miniagent/workspace.json`，服务重启不丢

## MCP 使用

在左栏「🔌 MCP」中添加：

- **stdio**：填命令与参数，如 `npx -y @modelcontextprotocol/server-filesystem`
- **HTTP**：填 MCP 端点 URL

连接成功后，服务器工具自动合并进 Agent 工具列表（前缀 `mcp__服务器名__工具名`）。

## Skills 使用

在左栏「⚡ 技能」中：

- 激活内置技能（可填参数，如目标目录）
- 激活后技能的步骤化指令注入对话，引导模型按流程执行
- 支持自定义技能（名称 + 指令），保存到 `~/.miniagent/skills/`

## 许可

MIT

> AI生成