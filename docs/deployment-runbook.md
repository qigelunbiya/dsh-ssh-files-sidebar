# 0.8.1 Project Deployment Runbook

`DEPLOYMENT.md` 是每个本地项目自己的部署/运维规范。目标是让 Agent 先核对真实本地项目和当前会话唯一 SSH 服务器，再形成稳定、可复用、可审查的部署流程。这里强调的是“命令透明”，不是机械地把所有 shell 语句拆成一行一条。

## 0.8.1：允许复合命令，只避免黑盒一键脚本

0.8.1 放宽了 0.7.1 过于严格的“独立命令”限制：

- `DEPLOYMENT.md` **允许复合 shell 命令**。
- 允许变量赋值、`$(...)` 命令替换、管道、`&&`、`||`、`;`、`if/else`、`for/while` 循环、heredoc、多行 shell block 等。
- 一组紧密相关的操作可以作为一个逻辑步骤写在同一个代码块中，只要实际执行内容在文档里完整可见、用户能够直接核对。
- 不再要求每一行都必须是“单一目的、单一写操作”。如果真实部署流程用一个清晰的复合块表达更准确，就保留复合块。
- **主要禁止项只有一个**：不要为了部署临时生成一个 `deploy.ps1`、`restart.sh`、`rollback.bat` 等一键脚本，把真正的 stop / copy / start / verify 流程藏进脚本文件后只让用户运行一个入口。
- 如果项目本身已经维护了正式部署脚本，或者用户明确要求使用/创建脚本，可以作为例外；Agent 应先说明脚本做什么，再按用户意图处理。
- 高风险操作仍需要单独关注，例如递归删除、数据库 restore/migration、防火墙/系统包/系统配置/凭据修改、磁盘操作、主机重启等。

例如，下面这种复合命令在 0.8.1 中是**允许的**：

```bash
CURRENT_PID=$(ps aux | grep 'api-[0-9]*\.[0-9]*\.jar' | grep -v grep | awk '{print $2}')
if [ -n "$CURRENT_PID" ]; then
  kill -15 "$CURRENT_PID"
  for i in {1..30}; do
    ps -p "$CURRENT_PID" > /dev/null 2>&1 || break
    sleep 1
  done
fi
```

因为它的完整逻辑直接展示在 `DEPLOYMENT.md` 中，用户可以看到 PID 是如何获取、服务如何停止、等待逻辑如何执行。

下面这种方式仍不推荐：

```powershell
Set-Content -Path .\deploy.ps1 -Value '<把停止、上传、启动、验证全部写进去>'
.\deploy.ps1
```

问题不是“PowerShell”本身，而是把整套流程封装成一个新的黑盒一键脚本，让用户无法在 Runbook 中直接看到真正会执行什么。

## 使用前提

推荐工作方式：

```text
LOCAL Workspace（源码）
        +
会话顶部 Linked SSH（唯一服务器）
        +
Workspace 根目录 DEPLOYMENT.md
```

Runbook 不写进 dsh-rw Remote Workspace 的 placeholder；它属于真实本地源码项目。

## 第一次整理部署规范

用户可以直接把历史部署命令交给 Agent，即使本地命令、上传命令、服务器命令混在一起。

Agent 应按以下流程工作：

1. 调用 `deployment_runbook_status` 确认当前项目是否已经有 Runbook。
2. 把旧命令分类为 `LOCAL`、`TRANSFER`、`REMOTE`、`VERIFY`、`ROLLBACK`。
3. 只做只读检查：
   - LOCAL：构建脚本、依赖管理器、产物目录、版本/分支等。
   - REMOTE：只检查当前会话锁定的 SSH，确认目录、服务管理方式、端口、日志、磁盘、当前版本等。
4. 用检查结果修正旧命令，避免生成服务器上根本不可用的命令。
5. 优化步骤顺序，尽量做到“先构建/打包/上传成功，再停服务”，缩短停机时间。
6. 明确备份、健康检查和回滚路径。
7. 向用户展示最终顺序，标清每一步在哪一侧执行，并把每个可能执行的精确命令或 shell block 完整展示出来。
8. 使用原生问题卡（可用时）让用户选择继续修改、只保存文档、或保存并执行已展示计划。
9. 用户明确确认后，调用 `deployment_runbook_write` 写入 Workspace 根目录的 `DEPLOYMENT.md`。

`deployment_runbook_write` 需要 `confirmedByUser: true`。如果是更新已有 Runbook，还必须带上最近一次 `deployment_runbook_read/status` 返回的 `sha256`，防止覆盖用户刚刚手工修改过的文档。

## 后续部署

以后用户只需要说“部署这个项目”。

Agent 应：

1. `deployment_runbook_status`
2. `deployment_runbook_read`
3. 核对 `target-ssh` 必须等于当前会话 SSH 锁。
4. 执行只读 Preflight。
5. 展示本次实际执行的逻辑步骤和精确命令/命令块，并请求用户确认。
6. 用户确认后：
   - LOCAL 步骤使用本地工具。
   - TRANSFER 使用 `linked_ssh_upload` / `linked_ssh_download`。
   - REMOTE / VERIFY 使用当前会话的 `linked_ssh_*`。
   - 可以按已展示的复合命令块执行，不需要为了满足形式要求强行拆散。
   - 每个逻辑步骤执行完成后读取结果，再继续下一步。
7. 如果必须修改计划中的命令，先停止后续写操作，展示替换命令并重新确认。
8. 部署后执行服务状态、Health Check、关键日志验证。
9. 默认不自动回滚；除非 Runbook 明确允许自动回滚并写清完整触发条件，否则先报告失败并请求用户确认。

## Runbook frontmatter

```yaml
---
dsh-deployment-version: 1
project: my-project
target-ssh: 131
remote-root: /opt/my-project
environment: production
---
```

`target-ssh` 是项目部署目标，不是可供 Agent 自由选择的主机列表。真正执行时仍受当前 Conversation 的 SSH session lock 约束。

## 工具

- `deployment_runbook_status`：检查当前 Workspace 的 Runbook、目标 SSH、hash 和结构告警。
- `deployment_runbook_read`：读取当前项目的 `DEPLOYMENT.md`。
- `deployment_runbook_template`：生成带 LOCAL / TRANSFER / REMOTE / Verification / Rollback 结构的标准模板。
- `deployment_runbook_write`：在用户确认后创建/更新 Runbook；更新时带 optimistic hash 检查。
- `ask_user_question`（Harness 原生，可用时）：用于命令计划、执行模式和缺失信息的可视化选择卡。
- Harness 原生 approval：用于真正高风险工具调用的单次授权，不应由普通问题卡替代。

## 安全原则

- 一个 Conversation 仍然只能操作一个 SSH 目标。
- Runbook 不能绕过 session SSH lock。
- LOCAL 和 REMOTE 路径不可混用。
- 正式部署前先 Preflight，再展示实际命令/命令块，再确认，再执行。
- **复合命令本身不是问题**；只要完整逻辑直接展示在 Runbook 中，就可以使用变量、条件、循环、命令替换和多行 shell。
- 不要为了“方便”临时生成一个新的 deploy/restart/rollback 一键脚本来隐藏整套流程。
- 数据库迁移、不可逆删除、凭据变更、系统包/防火墙/系统配置修改等高风险步骤应单独说明并再次确认。
