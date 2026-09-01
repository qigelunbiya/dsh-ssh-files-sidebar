# 0.7.1 Project Deployment Runbook

`DEPLOYMENT.md` 是每个本地项目自己的部署/运维规范。目标是让 Agent 不再依赖用户反复复制粘贴命令，也不把整套部署包装成难以审查的“一键脚本”，而是先核对真实本地项目和当前会话唯一 SSH 服务器，再形成稳定、可复用、可逐条核对的部署流程。

## 0.7.1：命令优先，而不是脚本优先

0.7.1 在 0.7.0 Runbook 的基础上增加一层“命令透明度”约束：

- 默认**不要生成** `deploy.sh`、`restart.sh`、`rollback.sh`、`.ps1`、`.bat` 等一键脚本，除非用户明确要求脚本。
- `DEPLOYMENT.md` 应保存**可直接看懂、可复制、可逐条执行**的命令，而不是把 stop / copy / start / verify 塞进一个大 shell 块。
- 每一步标记 `LOCAL`、`TRANSFER`、`REMOTE`、`VERIFY`、`ROLLBACK`，并写清用途与成功条件。
- 尽量使用绝对路径，避免 `cd ... && ...`；有状态变更的命令不要用 `;`、`&&`、`||`、循环、条件分支、heredoc 或 `bash -c` 串成黑盒。
- 只读环境检查可以自动执行，用来确认用户提供的旧命令在当前机器上到底是否成立。
- 真正要执行前，先把**最终精确命令列表**展示给用户核对。

DSH Web 中如果存在原生 `ask_user_question`，Agent 应优先使用它显示单选确认卡，而不是只在聊天末尾问一句“是否继续？”。推荐选项是：

1. `继续修改命令`
2. `保存文档但不执行`
3. `保存并按已展示命令逐条执行`

用户选择第 3 项后，Agent 可以按已经展示并确认的命令**顺序逐条执行**，无需每条普通命令都再次口头确认；但每条执行后都必须读取结果。如果实际输出与预期不符、路径/版本/目标发生变化，或者需要临时改命令，必须停下来展示新命令并重新确认。

递归删除、数据库 restore/migration、系统包/防火墙/系统配置/凭据修改、磁盘操作、主机重启等高风险操作仍是独立 checkpoint，并可能触发 DSH 原生的单次工具审批卡。

为了避免模型回退到黑盒方式，0.7.1 还会阻止明显的“复合远程写操作”和 Runbook 里的脚本生成/一键执行代码。例如 `cd /usr/scan && kill ... && nohup ...` 应改成使用绝对路径的独立命令。

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
7. 向用户展示最终顺序，标清每一步在哪一侧执行，并把每条可能执行的命令完整展示出来。
8. 使用原生问题卡（可用时）让用户选择继续修改、只保存文档、或保存并逐条执行。
9. 用户明确确认后，调用 `deployment_runbook_write` 写入 Workspace 根目录的 `DEPLOYMENT.md`。

`deployment_runbook_write` 需要 `confirmedByUser: true`。如果是更新已有 Runbook，还必须带上最近一次 `deployment_runbook_read/status` 返回的 `sha256`，防止覆盖用户刚刚手工修改过的文档。

## 后续部署

以后用户只需要说“部署这个项目”。

Agent 应：

1. `deployment_runbook_status`
2. `deployment_runbook_read`
3. 核对 `target-ssh` 必须等于当前会话 SSH 锁。
4. 执行只读 Preflight。
5. 展示本次实际执行的**逐条命令计划**并请求用户确认。
6. 用户确认后：
   - LOCAL 步骤使用本地工具。
   - TRANSFER 使用 `linked_ssh_upload` / `linked_ssh_download`。
   - REMOTE / VERIFY 使用当前会话的 `linked_ssh_*`。
   - 只执行已经展示并确认过的命令；执行一条，读取一条结果，再继续下一条。
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
- 正式部署前先 Preflight，再展示逐条命令计划，再确认，再执行。
- 默认拒绝把多个远程写操作封成一个复杂 shell 命令或生成一键脚本。
- 数据库迁移、不可逆删除、凭据变更、系统包/防火墙/系统配置修改等高风险步骤应单独说明并再次确认。
