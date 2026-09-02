# 0.8.2 Project Deployment Runbook

`DEPLOYMENT.md` 是每个本地项目自己的部署/运维规范。0.8.2 的核心原则不是“禁止一键脚本”，而是把自动化放在正确的成熟阶段：**先把真实部署流程以可审查的 Runbook 形式跑通，再根据用户实际使用方式把已验证流程固化成一键脚本。**

## 0.8.2：Runbook → 验证 → 一键自动化

推荐把一个项目的部署流程看成三个阶段：

```text
阶段 1：可见的 DEPLOYMENT.md
          ↓ 用户实际使用、调整
阶段 2：用户确认流程已经稳定
          ↓ 询问是否需要自动化
阶段 3：按真实使用方式生成一键脚本
```

### 阶段 1：最初必须先有可见 Runbook

第一次整理一个项目的部署规范时，Agent 应优先生成 `DEPLOYMENT.md`，而不是直接生成 `deploy.ps1` / `deploy.sh` / `restart.sh` 等一键入口。

原因不是复合命令危险，也不是脚本本身不允许，而是项目刚开始整理部署知识时，路径、版本规则、停止方式、启动参数、Health Check、回滚条件等很可能还没有经过实际验证。如果一开始就封装成“一键运行”，用户很难发现里面哪一步不符合真实环境，影响面也更大。

`DEPLOYMENT.md` **允许复合 shell 命令**，包括：

- 变量赋值；
- `$(...)` 命令替换；
- 管道；
- `&&`、`||`、`;`；
- `if/else`；
- `for/while`；
- heredoc；
- 多行 PowerShell / Bash block；
- 一个逻辑步骤里包含多条紧密相关命令。

例如下面这种停止逻辑完全可以直接出现在 Runbook 中：

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

这里真正重要的是：用户可以直接看到 PID 如何获取、服务如何停止、等待逻辑如何执行，而不是为了满足形式要求把它机械拆成十几条命令。

## 阶段 2：由用户判断 Runbook 是否已经验证

Agent 不能因为“某次命令返回 0”或者“一次部署看起来成功”就自动认为流程已经成熟。

只有当用户明确表达类似下面的意思时，才应把当前 Runbook 视为已经验证：

- “这套我实际用了没问题”；
- “现在这个 DEPLOYMENT.md 可以了”；
- “已经连续用了几次，都正常”；
- “流程就按现在这样固定下来”。

如果用户仍在调整 Java 路径、版本号规则、上传目录、启动参数、端口、日志或回滚方式，就继续维护 `DEPLOYMENT.md`，不要急着把它自动化。

一次部署成功后，如果当前 Runbook 已经比较稳定，Agent 可以主动用原生 `ask_user_question` 询问：

```text
当前 DEPLOYMENT.md 已经按本次流程执行完成。
你是否认为这套流程已经稳定，可以进入自动化阶段？

- 继续保持 DEPLOYMENT.md，后续再调整
- 标记为稳定，但暂时不生成脚本
- 这套流程稳定了，考虑生成一键脚本
```

用户没有明确选择自动化时，不要自己生成脚本。

## 阶段 3：生成一键脚本前，先问清楚用户实际怎么用

用户确认“当前 Runbook 没问题，而且希望做成一键脚本”后，**不能直接把整个 DEPLOYMENT.md 生硬复制进 `.ps1` / `.sh`**。

必须先了解用户平时真正怎么使用这份 Runbook。至少要确认这些信息：

1. **从哪里启动**
   - Windows PowerShell；
   - Linux / Bash；
   - CI；
   - 本地电脑调用 SSH；
   - 服务器上直接运行。

2. **每次实际会执行哪些阶段**
   - 只重启；
   - 本地构建 + 上传 + 重启；
   - 已经有产物，只上传 + 发布；
   - 完整 build / package / transfer / restart / verify；
   - 回滚是否也希望包含。

3. **每次会变化的输入**
   - 版本号；
   - JAR / ZIP / 前端包名称；
   - 环境 `prod/test/dev`；
   - 远程目录；
   - 端口；
   - 分支或 tag；
   - 是否需要手动选择产物。

4. **哪些步骤必须保留人工确认**
   - 停服务前；
   - 覆盖线上文件前；
   - 数据库迁移前；
   - 回滚前；
   - 删除旧版本前。

5. **失败时怎么处理**
   - 立即停止；
   - 自动尝试回滚；
   - 只打印错误等待人工；
   - 启动失败时是否保留旧进程/旧包；
   - Health Check 失败是否算部署失败。

6. **输出和日志习惯**
   - 终端直接打印；
   - 保存部署日志；
   - 是否显示每一步状态；
   - 成功后输出版本、PID、端口和健康状态。

Agent 应优先利用已经检查过的项目和服务器事实，只向用户询问“使用偏好”和“业务选择”，不要把可以自动确认的 Java 路径、服务器目录等问题重新丢给用户。

## 一键脚本应该如何生成

确认使用方式后，一键脚本应当：

- 以**已经验证的 `DEPLOYMENT.md`** 为依据；
- 复用已经跑通的真实命令，不重新发明另一套部署逻辑；
- 只把真正会变化的值做成参数；
- 根据用户实际使用方式决定包含哪些阶段；
- 保留用户要求的人工 checkpoint；
- 明确失败时是 fail-fast、报告错误还是回滚；
- 保留 Health Check / 日志检查等验证步骤；
- 不因为追求“智能”而增加用户从来没要求过的自动删除、自动升级、自动改配置等动作。

例如同一份 Runbook，两个用户最终得到的脚本可能完全不同：

```text
用户 A：
平时已经手工打好 api-13.0.jar
只想“一键上传 → 停旧服务 → 启新服务 → 验证”

用户 B：
希望“一键 Maven 构建 → 上传 → 发布 → Health Check”
但停服务前必须确认一次
```

Agent 应基于他们真实的使用方式生成不同脚本，而不是认为“完整自动化”永远是最好的答案。

## 写脚本之前仍然要给用户审查

生成脚本草案后，应先展示：

- 脚本文件名和保存路径；
- 如何启动；
- 输入参数；
- 对应 `DEPLOYMENT.md` 的哪些阶段；
- 哪些步骤仍需人工确认；
- 失败和回滚策略；
- 实际脚本内容，或足够完整、可审核的 diff。

然后再通过 `ask_user_question` 让用户确认，例如：

```text
- 继续调整脚本
- 保存脚本但暂不运行
- 保存并试运行一次
```

脚本不能因为“自动化阶段”就绕过 DSH 对真正高风险操作的审批。

## DEPLOYMENT.md 仍然是来源，不因为有脚本就废弃

生成一键脚本后，`DEPLOYMENT.md` 仍应保留，作用变成：

- 解释整个部署逻辑；
- 记录真实环境和前提；
- 说明脚本每个阶段对应什么；
- 提供手工恢复路径；
- 在脚本失败时可以退回人工执行；
- 作为后续修改脚本时的 source of truth。

建议在 Runbook 中记录脚本入口，例如：

```markdown
## 自动化入口

当前已验证的一键部署脚本：`scripts/deploy-prod.ps1`

适用场景：本地已经完成打包，需要上传新 JAR、重启服务并执行 Health Check。

如果发布流程发生结构变化，先修改并人工验证本 Runbook，再同步更新脚本。
```

如果以后部署流程发生实质变化，例如服务器目录换了、systemd 改成 Docker、版本规则变化、启动参数变化，那么旧脚本应该视为**可能过期**。正确顺序仍然是：

```text
先修改 DEPLOYMENT.md
→ 按新流程人工/半自动执行
→ 用户确认新流程稳定
→ 再更新一键脚本
```

## 第一次整理部署规范

用户可以直接把历史部署命令交给 Agent，即使本地命令、上传命令、服务器命令混在一起。

Agent 应：

1. 调用 `deployment_runbook_status` 确认当前项目是否已有 Runbook。
2. 分类为 `LOCAL`、`TRANSFER`、`REMOTE`、`VERIFY`、`ROLLBACK`。
3. 做只读检查：
   - LOCAL：项目结构、构建方式、产物、版本规则；
   - REMOTE：当前 session-bound SSH 的目录、服务方式、运行时、进程、端口、日志、磁盘等。
4. 用检查结果修正用户提供的历史命令。
5. 优化顺序，例如先完成构建/上传再停服务。
6. 明确验证和回滚方式。
7. 完整展示最终 Runbook 中的命令/命令块。
8. 让用户选择继续修改、保存但不执行、或保存并执行。
9. 用户确认后调用 `deployment_runbook_write`。

`deployment_runbook_write` 需要 `confirmedByUser: true`。更新已有 Runbook 时仍使用最近一次 `deployment_runbook_read/status` 的 `sha256` 防止覆盖并发修改。

## 后续正常部署

用户说“部署这个项目”时：

1. `deployment_runbook_status`
2. `deployment_runbook_read`
3. 核对 `target-ssh` 与当前会话 SSH lock。
4. 执行只读 Preflight。
5. 展示本次实际会运行的逻辑步骤和命令/命令块。
6. 用户确认后执行。
7. 每个逻辑 checkpoint 后读取结果。
8. 执行 Verification / Health Check。
9. 失败时按 Runbook 约定处理；没有明确自动回滚规则时，不自行扩大影响面。
10. 如果本次顺利完成且 Runbook 已经经过实际使用，可以询问用户是否认为流程已经稳定、是否需要进入一键自动化阶段。

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

`target-ssh` 是项目部署目标，真正执行时仍受当前 Conversation 的 SSH session lock 约束。

## 工具

- `deployment_runbook_status`：检查当前 Workspace 的 Runbook、目标 SSH、hash 和结构告警。
- `deployment_runbook_read`：读取当前项目的 `DEPLOYMENT.md`。
- `deployment_runbook_template`：生成 LOCAL / TRANSFER / REMOTE / Verification / Rollback 结构模板。
- `deployment_runbook_write`：用户确认后创建/更新 Runbook。
- `ask_user_question`：用于 Runbook 审查、成熟度确认、一键脚本使用方式访谈和脚本确认。
- Harness 原生 approval：真正高风险操作的单次授权。

## 最终原则

- **复合命令没问题，隐藏逻辑才是问题。**
- **一键脚本没问题，未经验证就直接一键化才是问题。**
- **脚本应该来自已经验证的 Runbook，而不是取代 Runbook。**
- **是否进入自动化阶段由用户判断，不由 Agent 擅自推断。**
- **生成脚本前先了解用户真正怎么使用 DEPLOYMENT.md。**
- **自动化后仍保留 Runbook 作为可读来源和手工恢复方案。**
- 高风险操作仍受独立审批保护。
