# dsh-ssh-files-sidebar

一个面向 DeepSeek Harness 的一体化 Remote SSH 插件层：把 `dsh-better-sidebar` 的右侧工作台、`@linxin666/dsh-ssh` 的 SSH 运维能力、`dsh-rw` 的远程工作区/原生工具 Shim，以及本项目自己的 SSH Files / 部署 Runbook 组合到同一套体验里。

> 0.8.0 起，`dsh-better-sidebar` 已经和 SSH / Remote Workspace 一样由本项目内部挂载。Profile **不再需要单独启用 `dsh-better-sidebar`**；只启动 `dsh-ssh-files-sidebar` 即可获得右侧工作台和 SSH Files。

> 0.4.0 起，用户只维护一份 SSH 主机配置：`~/.dsh/dsh-ssh.json`。不再需要同时在 `@linxin666/dsh-ssh` 和 `dsh-rw` 各配一遍服务器。

## 0.8.0 主要变化

- `dsh-better-sidebar@0.16.1` 从外部 peer 改为本项目的内部运行依赖。
- Host 端直接挂载 Better Sidebar 的 `/sidebar/*` 路由、终端/文件 API 和相关能力。
- Browser 端把 Better Sidebar client source 编译进本项目自己的 `client.js`，并在注册 `SSH Files` 之前先提供 `ctx.betterSidebar`。
- 本项目不再声明 `betterSidebar` 外部服务依赖，因此关闭/卸载独立 `dsh-better-sidebar` 后不会再出现 `pending (waiting for service: betterSidebar)`。
- Better Sidebar、SSH、Remote Workspace 都只需要一个顶层 loader row：`dsh-ssh-files-sidebar`。
- 为 Better Sidebar 的 client core 补齐 `sessions / workspaces / modules` 等注入以及普通 CSS 构建支持。

### 从 0.7.x 升级到 0.8.0

先更新和构建本项目：

```powershell
cd E:\fangzeming\deepseekHarness\dsh-ssh-files-sidebar

git pull
pnpm install
pnpm build
```

然后把 Profile 中**单独安装的 Better Sidebar 删除**，再同步一次本项目的 `link:`：

```powershell
cd E:\fangzeming\deepseekHarness\deepseek-harness

pnpm dsh plugin --profile web remove dsh-better-sidebar
pnpm dsh plugin --profile web add link:E:/fangzeming/deepseekHarness/dsh-ssh-files-sidebar
pnpm dsh web
```

如果 `remove dsh-better-sidebar` 提示未安装，可以忽略。启动后建议浏览器执行一次 `Ctrl + Shift + R` 硬刷新。

> 不建议同时挂载独立 `dsh-better-sidebar` 和 0.8.0 的集成版本；两边都会尝试注册同一组 `/sidebar/*` 路由和右侧面板。

## 0.4.0 主要变化

- 顶层插件会自动激活 `@linxin666/dsh-ssh`，保留原来的 SSH 主机管理、Web Terminal、SFTP、隧道和 Agent SSH 工具。
- 内部挂载 `dsh-rw` 的远程 Workspace 路由、`rw_*` 工具和原生工具 Shim，但它读取同一份 `~/.dsh/dsh-ssh.json`。
- “添加工作区”恢复为明确的 **本机 / 远程 SSH** 两个选项；只有主动选择本机时才会打开 Windows 系统文件夹选择器。
- `SSH Files` 只对 `dsh-rw` 远程工作区开放；普通本机工作区不会再沿用上一会话的 131 文件树。
- Git 状态功能和 Git 按钮全部移除。
- PNG/JPG/GIF/WebP/BMP/ICO/AVIF 图片预览修正 MIME 后再显示。
- TAR/TGZ/TAR.GZ/TAR.BZ2/TAR.XZ/ZIP/GZ/BZ2/XZ/7Z/RAR 支持查看压缩包目录/元信息；具体格式依赖服务器上的 `tar` / `gzip` / `unzip` / `7z` / `unrar` 等命令。
- `Ctrl/Cmd + 点击` 增减多选，`Shift + 点击` 范围多选，树获得焦点后 `Ctrl+A` 可选择当前已展开的可见项目。
- 多选后可批量删除，也可连续触发多个文件下载。
- 重命名改成文件树中的**原地编辑**，不再弹浏览器 prompt；也支持 `F2`。
- `Delete` 可删除当前选择。
- 右键文件/目录继续提供常用文件操作；多选时右键已选中的项目会保留整组选择。
- CodeMirror 编辑器继续支持语法高亮、行号、搜索替换、`Ctrl+S` 保存。
- 文件树 / 编辑器高度可拖拽调整，并按 DSH 会话记忆。
- 每个远程会话继续分别记住上次展开的目录。

## 架构

```text
一个顶层安装：dsh-ssh-files-sidebar
│
├─ dsh-better-sidebar（内部复用）
│  ├─ 右侧工作台 / Files / Editor / Terminal / Browser
│  ├─ betterSidebar Tab / Viewer registry
│  └─ /sidebar/* host routes + client shell
│
├─ @linxin666/dsh-ssh（内部复用）
│  ├─ ~/.dsh/dsh-ssh.json   ← 唯一 SSH 主机/凭据配置
│  ├─ SSH 主机管理 UI
│  ├─ Web Terminal / SFTP / Tunnel
│  └─ /api/dsh-ssh/* + ssh_* Agent tools
│
├─ dsh-rw（内部复用）
│  ├─ 添加工作区：本机 / 远程 SSH
│  ├─ ~/.dsh/remote-workspaces/<alias>/<name> 占位 Workspace
│  ├─ rw_* tools
│  └─ Read / Write / Edit / Glob / Grep / Bash 透明远程 Shim
│
└─ SSH Files（注册到内部 Better Sidebar）
   ├─ 远程文件树
   ├─ CodeMirror 编辑/保存
   ├─ 图片/PDF/压缩包预览
   ├─ 多选
   ├─ 上传/下载
   ├─ 原地重命名
   ├─ 新建目录/删除
   └─ 会话级目录展开记忆
```

0.8.0 起，右侧 Better Sidebar、SSH 和远程工作区都由本项目一次安装带入，不需要再维护一个独立的 `dsh-better-sidebar` loader row。

## 首次安装

```powershell
git clone https://github.com/qigelunbiya/dsh-ssh-files-sidebar.git
cd dsh-ssh-files-sidebar
pnpm install
pnpm build
```

然后在 DeepSeek Harness 源码目录中：

```powershell
pnpm dsh plugin --profile web add link:E:/你的路径/dsh-ssh-files-sidebar
pnpm dsh web
```

## 从 0.3.x 升级到 0.4.x

0.4.x 已经会自己激活 `@linxin666/dsh-ssh`，并且内部接入 `dsh-rw`。为了避免重复插件 row、重复 API route 或两套 Shim，先把 profile 中**单独安装**的旧条目移除：

```powershell
cd E:\fangzeming\deepseekHarness\deepseek-harness

pnpm dsh plugin --profile web remove @linxin666/dsh-ssh
pnpm dsh plugin --profile web remove dsh-rw
```

如果其中某条提示没有安装，可以忽略。

随后更新本项目：

```powershell
cd E:\fangzeming\deepseekHarness\dsh-ssh-files-sidebar

git pull
pnpm install
pnpm build
```

因为 0.4.0 新增了集成依赖，建议让 DSH profile 对 `link:` 再同步一次依赖：

```powershell
cd E:\fangzeming\deepseekHarness\deepseek-harness

pnpm dsh plugin --profile web add link:E:/fangzeming/deepseekHarness/dsh-ssh-files-sidebar
pnpm dsh web
```

浏览器启动后执行一次硬刷新：`Ctrl + Shift + R`。

> 原来 `@linxin666/dsh-ssh` 保存的 `~/.dsh/dsh-ssh.json` 不需要删除，也不需要重新配置服务器。0.4.0 正是复用这份配置。

## 工作区使用方式

点击“添加工作区”后会出现两个选项：

- **本机**：手动输入本机路径，或点击按钮后再打开 Windows 系统目录选择器。
- **远程 SSH**：直接读取左侧 SSH 已经配置的主机，选服务器、浏览远程目录并设为 Workspace。

创建远程 Workspace 后，DSH 的会话 cwd 是本机的轻量占位目录，但 Agent 的 `Read/Write/Edit/Glob/Grep/Bash` 会由 dsh-rw Shim 自动转发到对应服务器；远程文件仍以服务器为 source of truth，不做本地镜像。

`SSH Files` 会根据当前会话的远程 Workspace 或 Linked SSH 自动绑定服务器，服务器目标仍然跟随当前 Conversation，不提供独立的第二套主机选择。

## 文件树操作

单选：直接点击。

多选：

```text
Ctrl/Cmd + 点击   增加/取消一个项目
Shift + 点击      从锚点到当前项目范围选择
Ctrl/Cmd + A      选择当前文件树已经展开并可见的项目
```

快捷键：

```text
F2       原地重命名
Delete   删除当前选择
Ctrl+S   保存编辑文件
Ctrl+F   CodeMirror 搜索/替换
```

右键文件：

```text
打开 / 预览 / 编辑
下载（多选时下载选中的文件）
刷新所在目录
重命名（原地编辑）
删除（多选时删除选中的项目）
```

右键目录：

```text
刷新目录
上传文件到这里
新建目录
重命名（原地编辑）
删除
```

文件树空白区域代表远程 `/`，可右键刷新、上传和新建目录。

## 预览和编辑

文本文件：CodeMirror 编辑器，支持常见语言的语法高亮、行号、搜索替换、代码折叠和远程保存。

HTML：可在“源码 / 预览”之间切换；HTML 预览使用 sandbox iframe。

图片：PNG/JPG/JPEG/GIF/WebP/BMP/ICO/AVIF 在侧栏中显示。

PDF：浏览器内嵌预览。

压缩包：不把整个归档解压到浏览器，而是在远程服务器读取目录或压缩信息并显示。常见 `.tar.gz` / `.tgz` 在 Linux 上通常只依赖 `tar`；ZIP/7Z/RAR 若服务器缺对应命令，会显示明确错误，不会修改压缩包。

自动文本预览默认限制 8 MB，图片/PDF 自动预览默认限制 64 MB；超限文件仍可下载。

## SSH 配置与安全

唯一 SSH 配置源是：

```text
~/.dsh/dsh-ssh.json
```

由内部挂载的 `@linxin666/dsh-ssh` 负责主机管理和原有 SSH UI。远程 Workspace 侧通过兼容适配器读取同一文件，因此不需要再维护 `~/.dsh/dsh-rw.json` 的第二份主机列表。

删除目录会执行远程 `rm -rf -- <path>`，UI 会先要求确认；文件操作权限与当前 SSH 登录用户一致。重命名和新建目录分别通过远程 `mv` / `mkdir` 完成。

## 上游依赖

- `dsh-better-sidebar@0.16.1`：MIT，来源 `omdsh-dev/DSH-better-sidebar`
- `@linxin666/dsh-ssh`：Apache-2.0，来源 `DamonKoy/dsh-web-ui/packages/dsh-ssh`
- `dsh-rw`：MIT，来源 `MDR-EX1000/dsh-rw`

更完整的归属信息见 `NOTICE`。
