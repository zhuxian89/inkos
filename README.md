<p align="center">
  <img src="assets/logo.svg" width="120" height="120" alt="InkOS Logo">
  <img src="assets/inkos-text.svg" width="240" height="65" alt="InkOS">
</p>

<h1 align="center">InkOS：自动化小说生产系统</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@actalk/inkos"><img src="https://img.shields.io/npm/v/@actalk/inkos.svg?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-3178C6.svg?logo=typescript&logoColor=white" alt="TypeScript"></a>
</p>

---

InkOS 用多 Agent 管线接管小说生产：写草稿、做审计、执行修订、维护长期记忆，并提供 Web UI、Service API 和 CLI 三种入口。

## 推荐部署：Docker

当前推荐只使用这一套部署方式：

- Web UI：`http://localhost:13006`
- Service API：`http://localhost:4010`
- 持久化目录：`~/inkos-data/`

### 1）准备环境

- 安装 Docker Desktop（Mac / Windows）或 Docker Engine（Linux）
- 确保 `docker compose` 可用

### 2）准备目录与配置

```bash
mkdir -p ~/inkos-data/inkos-home ~/inkos-data/project
cp .env.example ~/inkos-data/inkos-home/.env
```

编辑 `~/inkos-data/inkos-home/.env`，至少填写：

- `INKOS_LLM_PROVIDER`
- `INKOS_LLM_BASE_URL`
- `INKOS_LLM_API_KEY`
- `INKOS_LLM_MODEL`

如果你只想覆盖当前项目，也可以额外创建：

- `~/inkos-data/project/.env`

> 注意：
>
> - Docker 模式下，仓库根目录的 `.env` **不会**自动注入容器
> - Service 实际读取的是：
>   - `~/inkos-data/inkos-home/.env`
>   - `~/inkos-data/project/.env`
> - 不建议把 `INKOS_LLM_*` 直接写死在 `docker-compose.web.yml` 里；否则会覆盖文件配置，也会影响运行时切换模型配置后的重新加载行为

### 3）启动

```bash
docker compose -f docker-compose.web.yml up -d --build
```

### 4）停止 / 查看日志

```bash
docker compose -f docker-compose.web.yml down
docker compose -f docker-compose.web.yml logs -f
```

### 5）目录约定

| 路径 | 作用 |
|------|------|
| `~/inkos-data/inkos-home/.env` | 全局 LLM 配置 |
| `~/inkos-data/project/inkos.json` | 项目配置 |
| `~/inkos-data/project/.env` | 当前项目的 LLM 覆盖配置 |
| `~/inkos-data/project/books/` | 所有书籍数据 |
| `~/inkos-data/project/books/<bookId>/story/` | 长期记忆文件 |
| `~/inkos-data/project/books/<bookId>/chapters/` | 章节正文 |

## 配置生效规则

Service 会在运行时重新读取配置文件。当前优先级是：

1. 启动进程时注入的 `INKOS_LLM_*` 环境变量
2. `INKOS_PROJECT_ROOT/.env`
3. `INKOS_HOME/.env`

这意味着：

- Docker 推荐把配置放进 `~/inkos-data/inkos-home/.env`
- 如果某个项目要单独换模型，可以写 `~/inkos-data/project/.env`
- 如果你把 `INKOS_LLM_*` 写进容器环境变量，它会拥有更高优先级

## 系统组成

InkOS 当前是一个 pnpm monorepo：

- `packages/core`：Agent 运行时、状态管理、审计/修订/调度管线
- `packages/cli`：`inkos` CLI
- `apps/service`：Web UI 后端接口层
- `apps/web`：Next.js Web UI

它们共享同一套项目目录和长期记忆文件。

## 核心能力

- **长期记忆**：维护 `current_state.md`、`pending_hooks.md`、`chapter_summaries.md`、`subplot_board.md`、`emotional_arcs.md`、`character_matrix.md` 等真相文件
- **审计闭环**：审计问题会回写章节索引和状态，支持再审与定点修订
- **修订模式**：支持 `polish`、`rewrite`、`rework`、`spot-fix`
- **章节对话**：可以围绕单章讨论问题、按当前对话直接发起修订、用最后回复替换全文
- **初始化助手**：围绕书名、题材、平台、卖点与长期记忆做创作方案整理
- **多套模型配置**：支持 profile 切换、测试、激活，并回写当前全局配置
- **文风/正典导入**：支持 style import、canon import

## Web UI 使用

Docker 启动后，默认入口是 Web UI。

Web 里可以完成：

- 初始化项目
- 创建/查看书籍
- 写下一章、审计、修订、审阅通过/驳回
- 管理 LLM profiles
- 用初始化助手整理创作简报
- 用章节对话分析问题、生成修改建议

## CLI 快速开始

如果你更喜欢命令行，也可以直接安装 CLI：

```bash
npm i -g @actalk/inkos
```

### 全局配置（推荐）

```bash
inkos config set-global \
  --provider openai \
  --base-url https://api.openai.com/v1 \
  --api-key sk-xxx \
  --model gpt-4o
```

### 初始化项目

```bash
inkos init my-novel
```

### 常用命令

```bash
inkos book create --title "吞天魔帝" --genre xuanhuan --platform tomato
inkos write next 吞天魔帝
inkos audit 吞天魔帝 1
inkos revise 吞天魔帝 1 --mode spot-fix
inkos status 吞天魔帝
inkos review list 吞天魔帝
inkos export 吞天魔帝
```

补充说明：

- 项目里只有一本书时，很多命令可以省略 `bookId`
- 大多数命令支持 `--json`
- `inkos agent "<instruction>"` 可以走自然语言 Agent 模式

## 本地开发（仅开发者）

如果你在改代码，而不是使用 Docker 成品，建议按下面三终端启动：

### 终端 1：构建并监听 core

```bash
pnpm --filter @actalk/inkos-core dev
```

### 终端 2：启动 service

```bash
INKOS_HOME=$HOME/inkos-data/inkos-home \
INKOS_PROJECT_ROOT=$HOME/inkos-data/project \
pnpm --filter @actalk/inkos-service dev
```

### 终端 3：启动 web

```bash
INKOS_SERVICE_URL=http://127.0.0.1:4010 \
pnpm --filter @actalk/inkos-web dev
```

说明：

- 本地 `service dev` 依赖 workspace 中最新的 `@actalk/inkos-core` 构建产物，所以开发时最好同时跑 `@actalk/inkos-core dev`
- Docker 生产镜像不需要单独跑 core watch，因为镜像构建时已经完成 core build

## 常见坑

### 1）为什么我改了仓库根目录 `.env`，Docker 里没生效？

因为 Docker 模式不读取仓库根目录 `.env`。请改：

- `~/inkos-data/inkos-home/.env`
- 或 `~/inkos-data/project/.env`

### 2）为什么切换激活模型后，进程像还在用旧配置？

优先确认配置写入的是 `INKOS_HOME/.env` 或项目 `.env`，而不是只改了别的文件。  
当前 Service 会在请求时重新读取这些文件，但如果你把 `INKOS_LLM_*` 写死进进程环境变量，它仍然会覆盖文件配置。

### 3）为什么本地 dev 时像用了旧的 core 代码？

因为 `apps/service` 依赖 `@actalk/inkos-core` 的构建产物。开发时请同时运行：

```bash
pnpm --filter @actalk/inkos-core dev
```

## 项目结构

```text
inkos/
├── apps/
│   ├── service/          # Express service
│   └── web/              # Next.js Web UI
├── packages/
│   ├── cli/              # inkos CLI
│   └── core/             # agents / pipeline / llm / state
├── docker-compose.web.yml
├── Dockerfile.service
├── Dockerfile.web
└── README.md
```

## License

MIT
