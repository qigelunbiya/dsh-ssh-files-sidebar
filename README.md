# dsh-ssh-files-sidebar

把 `@linxin666/dsh-ssh` 已经配置好的 SSH 主机直接显示到 `dsh-better-sidebar` 右侧栏，不再配置第二份 SSH。

## 当前功能

- 复用 `@linxin666/dsh-ssh` 的 `/api/dsh-ssh/hosts` 与 `/api/dsh-ssh/ls`
- 单主机时自动选择
- 多主机下拉切换
- 从远程 `/` 根目录开始浏览
- 文件夹按需展开，避免递归扫描整台服务器
- 文件夹优先、文件其次
- 显示文件大小
- 支持根目录刷新
- SSH/SFTP 错误只显示在侧栏，不影响主聊天

## 前置插件

需要已安装并启用：

```text
@linxin666/dsh-ssh
dsh-better-sidebar
```

SSH 主机只需要在 `@linxin666/dsh-ssh` 中配置一次。

## 本地开发安装

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

启动后，在 `dsh-better-sidebar` 右侧栏的 `+` 菜单中打开 **SSH Files**。

## 原理

本插件不维护 SSH 密码和连接配置。浏览器侧直接复用 `@linxin666/dsh-ssh` 已公开的同源 API：

```text
/api/dsh-ssh/hosts
/api/dsh-ssh/ls?alias=131&path=/
```

因此主机配置、认证方式、ProxyJump 与连接池都继续由 `@linxin666/dsh-ssh` 负责。

## 计划

- 点击文件预览
- 下载文件
- 上传到当前目录
- 新建目录
- 重命名
- 删除
- 记住每个会话上次展开的目录
