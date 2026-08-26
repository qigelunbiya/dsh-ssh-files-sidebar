# dsh-ssh-files-sidebar

把 `@linxin666/dsh-ssh` 已经配置好的 SSH 主机直接显示到 `dsh-better-sidebar` 右侧栏，不再配置第二份 SSH。

## 当前功能

- 复用 `@linxin666/dsh-ssh` 的主机配置、SSH/SFTP 连接和同源 API
- 单主机自动选择，多主机下拉切换
- 从远程 `/` 根目录开始浏览
- 文件夹按需展开，避免递归扫描整台服务器
- 文件夹优先、文件其次，显示文件大小和修改时间
- CodeMirror 编辑器：行号、语法高亮、当前行高亮、括号匹配、代码折叠
- CodeMirror 搜索 / 替换：点击“搜索”或使用 `Ctrl+F`
- `Ctrl+S` / `Cmd+S` 直接保存远程文件
- 支持 HTML、Python、JS/TS、JSON/YAML、Markdown、CSS、SQL、C/C++、Java、Go、Rust、XML 等常见语言高亮
- HTML 支持“源码 / 预览”切换，预览使用 sandbox iframe
- 图片支持侧栏内预览，PDF 支持浏览器内嵌预览
- 文本编辑后直接通过 SFTP 保存回服务器，并显示未保存状态
- 切换文件、切换主机或关闭编辑器时，有未保存修改会提醒
- 文件下载
- 上传一个或多个文件到当前目录；存在同名文件时先确认再覆盖
- 新建目录
- 文件/目录重命名
- 文件/目录删除（删除前二次确认）
- 文件和目录右键菜单：打开/编辑、下载、刷新、上传、新建目录、刷新 Git 状态、重命名、删除
- 文件树空白处右键可对远程 `/` 执行上传、新建目录、刷新和 Git 检测
- 文件树 / 编辑器之间可拖拽调整高度，并按会话记住比例
- Git 状态标记：在 Git 工作树内选中文件或目录后自动读取 `git status --porcelain`，文件显示 `M/A/D/R/U/?`，有改动的父目录显示 `•`
- 每个 DSH 会话分别记住：上次选择的 SSH 主机、上次展开的远程目录、文件树/编辑器分割比例
- SSH/SFTP/Git 错误只显示在侧栏，不影响主聊天

## 前置插件

需要已安装并启用：

```text
@linxin666/dsh-ssh
dsh-better-sidebar
```

SSH 主机只需要在 `@linxin666/dsh-ssh` 中配置一次。

## 本地开发安装 / 更新

首次安装：

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

已经使用 `link:` 安装后，更新只需要：

```powershell
cd E:\你的路径\dsh-ssh-files-sidebar
git pull
pnpm install
pnpm build

cd E:\你的路径\deepseek-harness
pnpm dsh web
```

> 从 0.2.x 升级到 0.3.x 需要重新执行一次 `pnpm install`，因为新增了 CodeMirror 依赖。以后代码更新如果依赖没有变化，可以只 `git pull && pnpm build`。

启动后，在 `dsh-better-sidebar` 右侧栏的 `+` 菜单中打开 **SSH Files**。

## 右键菜单

文件：

```text
打开 / 编辑
下载
刷新目录
刷新 Git 状态
重命名
删除
```

目录：

```text
刷新目录
上传文件到这里
新建目录
刷新 Git 状态
重命名
删除
```

文件树空白区域代表远程 `/`，右键可以刷新、上传、新建目录和检测 Git 状态。

## Git 状态

当选中的文件或目录位于 Git 工作树中时，插件会调用远程：

```text
git rev-parse --show-toplevel
git status --porcelain=v1 --untracked-files=all
```

状态标记：

```text
M  modified
A  added
D  deleted
R  renamed
U  conflict/unmerged
?  untracked
•  目录下存在 Git 变更
```

保存、上传、重命名、删除、新建目录后会重新刷新所在工作树的状态。非 Git 目录不会报错，只会清空 Git 标记。

## 原理

本插件不维护 SSH 密码和连接配置。浏览器侧复用 `@linxin666/dsh-ssh` 已公开的接口：

```text
GET  /api/dsh-ssh/hosts
GET  /api/dsh-ssh/ls
GET  /api/dsh-ssh/download
POST /api/dsh-ssh/upload
POST /api/dsh-ssh/exec
```

用途：

- `hosts`：读取已经配置好的 SSH 主机
- `ls`：远程目录树
- `download`：文件预览和下载
- `upload`：编辑保存、上传本地文件
- `exec`：执行短文件系统/Git 命令，用于 mkdir / mv / rm / git status

因此主机配置、认证方式、ProxyJump 与连接池仍然全部由 `@linxin666/dsh-ssh` 负责。

## 安全与限制

- 删除目录使用远程 `rm -rf -- <path>`，UI 会先弹出确认框；服务器权限与 SSH 登录用户一致。
- 重命名和新建目录通过远程 `mv` / `mkdir` 执行。
- 自动文本预览默认限制 8 MB，图片/PDF 自动预览默认限制 32 MB，避免大文件拖慢浏览器；大文件仍可下载。
- HTML 预览使用 sandbox iframe，不允许页面脚本继承 DSH 页面权限。
- Git 标记面向普通工作树状态；极少见的包含换行符的 Git 文件名不做特殊解析。
- Git 状态只在进入/选中某个 Git 工作树后显示，不会递归扫描整台服务器寻找仓库。
