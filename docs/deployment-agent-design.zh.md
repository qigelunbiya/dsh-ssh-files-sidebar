# 部署 Agent 设计草案

> 状态：需求确认稿。先锁定产品边界与工作流，再进入实现。

## 1. 产品定位

在现有 `dsh-ssh-files-sidebar` 中增加一个专门用于“把本地项目安全发布到远程服务器”的 Agent 模式，并提供一个可视化的部署工作台。

目标不是做一个只会执行几条 SSH 命令的提示词，而是把一次真实上线拆成可检查、可确认、可回滚、可审计的部署流程：

1. 识别本地项目与构建方式。
2. 识别远程服务器、部署目录与运行方式。
3. 发布前检查服务器状态。
4. 在本地构建项目或使用已有产物。
5. 备份线上程序、配置和可选数据库。
6. 上传到远程 staging 目录并校验完整性。
7. 原子替换或版本目录切换。
8. 重启服务。
9. 做进程、端口、HTTP、日志等健康检查。
10. 失败时自动或半自动回滚。
11. 在 UI 中留下部署步骤、输出、版本、备份与最终结果。

## 2. UI 改造

### 2.1 Agent preset 选择器

在 DSH 原生 Agent preset 下拉框中增加：

- 名称：`部署模式`
- preset id：建议 `deploy`
- 描述：`面向服务器项目发布、备份、重启、健康检查与回滚的运维 Agent。`

不通过 DOM 硬插一个菜单项，而是使用 Harness 原生 Agent Preset 机制。Harness 的 preset roster 会从用户 preset 根目录动态发现 preset，因此安装本插件后可以由插件安装/维护一个 `deploy` preset。

运行中的会话保持创建时的 preset；用户在新会话开始前选择“部署模式”。

### 2.2 对话区顶部新增“部署”Tab

在现有：

- 对话
- 轨迹

旁边增加：

- 部署

使用 Harness 原生 `conversation.view` slot 注册，不修改 Harness 源码。

部署 Tab 用于展示结构化状态，而不是把所有信息塞进聊天消息：

- 当前项目
- 当前目标服务器
- 当前环境：dev / test / staging / prod
- 当前线上版本
- 待发布版本/产物
- 发布阶段进度
- 本地构建日志
- 上传进度与 SHA256
- 备份位置
- 服务停止/启动结果
- 健康检查结果
- 最近远程日志
- 回滚按钮
- 最近部署历史

建议只有当前 session 的 preset 为 `deploy` 时才显示“部署”Tab，避免普通编码会话被额外 UI 干扰。

## 3. 核心原则：双执行平面

这个功能不能简单依赖 Agent 的普通 Bash。

一次部署同时需要：

- 本机执行：构建、寻找产物、计算 hash、读取本地配置。
- 远程执行：备份、上传、解压、替换、restart、健康检查、日志读取。

因此新增一个独立的 Deployment backend/service：

```text
Deployment Agent
      │
      ├── Local executor
      │     ├── pnpm/npm
      │     ├── Maven/Gradle
      │     ├── Python build
      │     ├── Docker build
      │     └── custom command
      │
      └── Remote executor
            └── 复用本插件已经集成的 SSH 主机配置/连接能力
```

这样即便当前会话绑定的是远程 workspace，也不会把本应在 Windows 本机执行的 `pnpm build` 错误地通过 dsh-rw shim 发到服务器。

## 4. 项目部署配置

建议每个项目支持一个 `.dsh-deploy.yml`，第一次可以由 Agent 根据项目和服务器自动生成草案，用户确认后保存。

建议结构：

```yaml
version: 1
project:
  name: my-webapp

environments:
  prod:
    host: "131"

    local:
      cwd: "E:/project/my-webapp"
      buildCommand: "pnpm build"
      artifact: "dist"

    remote:
      deployDir: "/apps/webapp"
      stagingDir: "/apps/.dsh-deploy/staging"
      backupDir: "/apps/.dsh-deploy/backups"

    strategy:
      type: "release-symlink" # release-symlink | replace | docker-compose | custom
      releasesDir: "/apps/.dsh-deploy/releases"
      currentLink: "/apps/webapp"

    service:
      type: "systemd" # systemd | docker-compose | pm2 | supervisor | command | none
      name: "webapp"

    backup:
      files: true
      keep: 10
      database: null

    health:
      process: true
      port: 8080
      url: "http://127.0.0.1:8080/health"
      expectedStatus: 200
      timeoutSeconds: 60

    logs:
      command: "journalctl -u webapp -n 100 --no-pager"
```

配置不是强制用户从零填写。正常交互应是：Agent 扫描 -> 给出推断 -> 用户确认 -> 保存。

## 5. 部署生命周期

### Phase A：Discover

Agent 首次进入项目时检查：

- package.json / pnpm-lock / yarn.lock
- pom.xml / build.gradle
- requirements.txt / pyproject.toml
- Dockerfile / docker-compose.yml
- 现有脚本
- 构建输出目录
- 服务器主机配置
- 远程项目目录
- systemd / Docker / PM2 / Supervisor / 自定义启动脚本

最终生成一个 Deployment Plan，不立即修改服务器。

### Phase B：Preflight

发布前强制检查：

- SSH 是否可连接
- 当前用户与权限
- 目标目录是否存在
- 磁盘剩余空间
- 当前运行进程
- 当前监听端口
- 当前线上版本
- 可选 Git commit / artifact hash
- 备份目录是否可写
- 构建机本地磁盘空间

如果存在高风险问题，阻止进入 Deploy。

### Phase C：Build

支持两种来源：

1. `Build from source`：在本机执行 buildCommand。
2. `Use existing artifact`：用户直接选择 jar/war/zip/tar.gz/dist 等已有产物。

构建结束记录：

- 命令
- exit code
- duration
- artifact path
- artifact size
- SHA256

### Phase D：Backup

默认备份旧版本，再做替换。

文件备份记录：

- deployment id
- timestamp
- old release path
- archive/checksum

数据库备份为可选插件化能力，V1 可先支持：

- MySQL/MariaDB -> mysqldump
- PostgreSQL -> pg_dump

数据库备份必须配置显式命令/连接信息，不让 Agent 猜生产数据库密码。

### Phase E：Upload / Stage

不直接覆盖生产目录。

先上传到：

```text
<stagingDir>/<deployment-id>/
```

然后：

- 本地 SHA256
- 远程 SHA256
- 比较一致后才能继续

### Phase F：Release

优先策略：`release-symlink`。

```text
/apps/.dsh-deploy/releases/20260826-150101/
/apps/webapp -> /apps/.dsh-deploy/releases/20260826-150101/
```

优点：

- 切换快
- rollback 快
- 不需要把旧目录直接覆盖掉

对于无法使用 symlink 的项目再使用 `replace` 策略。

### Phase G：Restart

内置适配：

- systemd
- docker compose
- PM2
- Supervisor
- custom command

重启后不能只判断 command exit code，需要进入 Verify。

### Phase H：Verify

建议至少组合两种检查：

- process alive
- port listening
- HTTP status
- HTTP body contains
- custom shell check
- recent logs no fatal pattern

状态：

```text
healthy
warning
failed
```

### Phase I：Rollback

若 Verify 失败：

- 默认暂停并明确告诉用户健康检查失败。
- 如果配置 `autoRollback: true`，自动切回上一 release。
- 重启旧版本。
- 再次执行 health check。
- 输出 rollback report。

生产环境 V1 建议默认 `autoRollback: false`，由用户确认；后续可开放自动回滚。

## 6. 安全模型

Agent 可以负责分析和编排，但关键破坏性阶段应做 checkpoint。

建议三个确认等级：

### 自动执行

- 查看文件
- 查看环境
- 查看磁盘
- 构建
- 上传 staging
- hash 校验
- 查看日志
- health check

### 单次部署确认

点击“开始部署”后视为授权本次：

- 创建备份
- 创建 release
- 停止/重启指定服务
- 切换 current

### 必须单独确认

- 数据库 restore
- 删除大量 release/backups
- 执行未在配置中的高风险 root 命令
- 修改防火墙/nginx/system packages

## 7. Agent 工具设计

不要只给 Agent 一个无限制 `ssh_exec`。提供语义化工具，让模型表达意图，后台负责安全边界和记录。

V1 建议：

```text
deploy_project_inspect
deploy_server_inspect
deploy_plan
deploy_build
deploy_artifact_select
deploy_preflight
deploy_backup
deploy_upload
deploy_release
deploy_restart
deploy_health_check
deploy_logs
deploy_rollback
deploy_status
```

后端所有操作都写入同一个 Deployment Run 状态机。

## 8. Deployment Run 状态机

```text
idle
  -> discovering
  -> planned
  -> preflight
  -> building
  -> staged
  -> backed-up
  -> releasing
  -> restarting
  -> verifying
  -> succeeded

任何阶段：
  -> failed
  -> rollback-pending
  -> rolling-back
  -> rolled-back
  -> rollback-failed
```

每次 Run 有唯一 id，例如：

```text
20260826-151530-a1b2c3
```

记录到：

```text
~/.dsh/deploy/runs/<run-id>.json
```

敏感信息不能写入日志。

## 9. “部署”Tab 第一版布局

```text
┌──────────────────────────────────────────────┐
│ 部署  my-webapp     prod     131             │
├──────────────────────────────────────────────┤
│ Local project   E:/project/my-webapp         │
│ Build           pnpm build                   │
│ Artifact        dist/   18.6 MB  SHA256 ...  │
│ Remote          /apps/webapp                 │
│ Service         systemd:webapp               │
├──────────────────────────────────────────────┤
│ ✓ Inspect                                    │
│ ✓ Preflight                                  │
│ ✓ Build                                      │
│ ✓ Backup     /apps/.dsh-deploy/backups/...   │
│ → Upload     72%                             │
│ ○ Release                                    │
│ ○ Restart                                    │
│ ○ Verify                                     │
├──────────────────────────────────────────────┤
│ [查看计划] [开始部署] [查看日志] [回滚]       │
├──────────────────────────────────────────────┤
│ 实时日志 / 最近命令输出                      │
└──────────────────────────────────────────────┘
```

聊天负责“理解用户意图、解释、修改计划”；部署 Tab 负责“状态、按钮、实时输出、历史”。

## 10. 与现有 SSH Files 的关系

保持一个插件：

```text
dsh-ssh-files-sidebar
├── SSH host / terminal / transfer
├── Remote Workspace
├── SSH Files editor
└── Deployment Agent
    ├── deploy preset
    ├── deploy tools/service
    ├── deploy conversation view
    └── deployment history
```

主机配置仍然只使用现有：

```text
~/.dsh/dsh-ssh.json
```

部署 Agent 不再保存第二套 SSH 密码或主机列表。

## 11. 推荐实现阶段

### V0.5：框架

- `部署模式` 出现在 Agent preset picker。
- `部署` conversation view 出现。
- Deployment service/run state。
- 只做 inspect + plan，不真正发布。

### V0.6：可完成一次安全文件部署

- local build
- artifact
- preflight
- backup
- SFTP upload
- checksum
- replace/release symlink
- restart
- health check
- rollback

先覆盖 Linux + systemd/custom command。

### V0.7：更多运行方式

- Docker Compose
- PM2
- Supervisor
- Java jar service patterns
- static web/nginx patterns

### V0.8：数据库与高级发布

- MySQL/PostgreSQL backup
- migrations
- retention cleanup
- deployment locks
- concurrent deployment protection
- notifications

## 12. V1 暂不做

为了避免一开始变成完整 CI/CD 平台，第一版不做：

- Kubernetes
- 多节点滚动发布
- 蓝绿流量切换
- 云厂商 API
- 自动修改 nginx/firewall
- secrets manager
- GitHub Actions/Jenkins 替代品

后续如果单机部署体验稳定，再扩展。

## 13. 当前建议锁定的产品定义

一句话：

> `部署模式` 是一个懂本地构建与远程服务器发布的专用 Agent；它先生成并验证 Deployment Plan，然后按“构建 -> 预检 -> 备份 -> 上传 staging -> 校验 -> 发布 -> 重启 -> 健康检查 -> 必要时回滚”的状态机执行，并把全过程放在“部署”Tab 中可视化。

这比“让 Agent 自己想几条 ssh 命令然后执行”更可靠，也更适合以后扩展成长期使用的服务器发布助手。
