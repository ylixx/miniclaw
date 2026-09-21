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

## 内置工具

文件操作: list_files, read_file, write_file, append_file, delete_file, create_dir, move_file, copy_file, file_info, search_files

数据处理: read_csv, write_csv, read_json, write_json, md_table

文本处理: text_stats, text_replace, text_summary

## 项目结构

```
miniagent/
├── server/
│   ├── index.js           # 服务入口（含项目/任务/MCP API）
│   ├── agent/
│   │   ├── engine.js      # Agent 引擎（任务历史持久化）
│   │   ├── prompt.js      # Prompt 构建器（技能指令/工作目录注入）
│   │   ├── parser.js      # 响应解析器
│   │   └── context.js     # 上下文管理（保序裁剪）
│   ├── tools/
│   │   ├── registry.js    # 工具注册表（内置 + MCP 合并）
│   │   ├── path-guard.js  # 路径安全防护（防目录穿越）
│   │   ├── file-ops.js    # 文件操作
│   │   └── doc-ops.js     # 文档处理
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