# dsh-ssh-files-sidebar

把 `@linxin666/dsh-ssh` 已经配置好的 SSH 主机直接显示到 `dsh-better-sidebar` 右侧栏，不再配置第二份 SSH。

## 当前功能

- 复用 `@linxin666/dsh-ssh` 的主机配置、SSH/SFTP 连接和同源 API
- 单主机自动选择，多主机下拉切换
- 从远程 `/` 根目录开始浏览
- 文件夹按需展开，避免递归扫描整台服务器
- 文件夹优先、文件其次，显示文件大小和修改时间
- 点击文本文件直接预览和编辑：HTML、Python、JS/TS、JSON/YAML、Shell、Markdown、CSS、SQL、C/C++、Java、Go、Rust 等
- HTML 支持“源码 / 预览”切换，预览使用 sandbox iframe
- 图片支持侧栏内预览，PDF 支持浏览器内嵌预览
- 文本编辑后直接通过 SFTP 保存回服务器，并显示未保存状态
- 切换文件、切换主机或关闭编辑器时，有未保存修改会提醒
- 文件下载
- 新建目录
- 文件/目录重命名
- 文件/目录删除（删除前二次确认）
- 每个 DSH 会话分别记住：上次选择的 SSH 主机、上次展开的远程目录
- SSH/SFTP 错误只显示在侧栏，不影响主聊天

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
pnpm build

cd E:\你的路径\deepseek-harness
pnpm dsh web
```

启动后，在 `dsh-better-sidebar` 右侧栏的 `+` 菜单中打开 **SSH Files**。

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
- `upload`：保存编辑后的文件
- `exec`：执行很短的文件系统操作命令，用于 mkdir / mv / rm

因此主机配置、认证方式、ProxyJump 与连接池仍然全部由 `@linxin666/dsh-ssh` 负责。

## 安全与限制

- 删除目录使用远程 `rm -rf -- <path>`，UI 会先弹出确认框；服务器权限与 SSH 登录用户一致。
- 重命名和新建目录通过远程 `mv` / `mkdir` 执行。
- 自动文本预览默认限制 8 MB，图片/PDF 自动预览默认限制 32 MB，避免大文件拖慢浏览器；大文件仍可下载。
- HTML 预览使用 sandbox iframe，不允许页面脚本继承 DSH 页面权限。
- 当前编辑器是轻量文本编辑器，还没有 CodeMirror/Monaco 的语法高亮与高级补全。

## 后续可选增强

- CodeMirror 语法高亮、搜索替换、行号
- 上传文件到当前目录
- 右键菜单
- 拖拽调整文件树 / 编辑器高度
- Git 状态标记
