# 0.7.0 Project Deployment Runbook

`DEPLOYMENT.md` 是每个本地项目自己的部署/运维规范。目标是让 Agent 不再依赖用户反复复制粘贴命令，而是先核对真实本地项目和当前会话唯一 SSH 服务器，再形成稳定、可复用、可审查的部署流程。

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
4. 优化步骤顺序，尽量做到“先构建/打包/上传成功，再停服务”，缩短停机时间。
5. 明确备份、健康检查和回滚路径。
6. 向用户展示最终顺序，并标清每一步在哪一侧执行。
7. 用户明确确认后，调用 `deployment_runbook_write` 写入 Workspace 根目录的 `DEPLOYMENT.md`。

`deployment_runbook_write` 需要 `confirmedByUser: true`。如果是更新已有 Runbook，还必须带上最近一次 `deployment_runbook_read/status` 返回的 `sha256`，防止覆盖用户刚刚手工修改过的文档。

## 后续部署

以后用户只需要说“部署这个项目”。

Agent 应：

1. `deployment_runbook_status`
2. `deployment_runbook_read`
3. 核对 `target-ssh` 必须等于当前会话 SSH 锁。
4. 执行只读 Preflight。
5. 展示本次实际执行计划并请求用户确认。
6. 用户确认后：
   - LOCAL 步骤使用本地工具。
   - TRANSFER 使用 `linked_ssh_upload` / `linked_ssh_download`。
   - REMOTE / VERIFY 使用当前会话的 `linked_ssh_*`。
7. 部署后执行服务状态、Health Check、关键日志验证。
8. 0.7.0 默认不自动回滚；除非 Runbook 明确允许自动回滚并写清完整触发条件，否则先报告失败并请求用户确认。

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

## 0.7.0 工具

- `deployment_runbook_status`：检查当前 Workspace 的 Runbook、目标 SSH、hash 和结构告警。
- `deployment_runbook_read`：读取当前项目的 `DEPLOYMENT.md`。
- `deployment_runbook_template`：生成带 LOCAL / TRANSFER / REMOTE / Verification / Rollback 结构的标准模板。
- `deployment_runbook_write`：在用户确认后创建/更新 Runbook；更新时带 optimistic hash 检查。

## 安全原则

- 一个 Conversation 仍然只能操作一个 SSH 目标。
- Runbook 不能绕过 session SSH lock。
- LOCAL 和 REMOTE 路径不可混用。
- 正式部署前先 Preflight，再展示计划，再确认，再执行。
- 数据库迁移、不可逆删除、凭据变更等高风险步骤应单独说明并再次确认。
