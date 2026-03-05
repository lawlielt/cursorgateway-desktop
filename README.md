# Cursor Gateway Desktop

> 一个面向 macOS 的桌面网关应用：将 Cursor 能力暴露为 OpenAI / Anthropic 兼容接口，开箱即用（DMG 安装）。

## 1) 项目来源（Fork / Refactor 说明）

本项目基于以下开源项目重构：
- 上游仓库：`https://github.com/taxue2016/CursorGateway`

本仓库不是简单镜像，已做桌面化与稳定性改造（见下一节）。

---

## 2) 我们做了哪些改动（相对上游）

### 桌面化能力
- 新增 macOS 菜单栏应用（Menubar）
- 新增控制面板（启动/停止服务、登录、状态检测、模型检测）
- 新增 DMG 打包与 Release 发布流程

### 启动体验与可用性
- 首次启动自动打开主面板（避免仅 Dock 跳动）
- 增加 Loading 反馈（主窗口内可见）
- 登录状态可视化（已登录/未登录）

### 认证与路径稳定性
- 修复打包后路径不可写问题（不再写入 app.asar）
- Token 改为用户目录持久化
- 增加多路径 token 兜底读取，降低 401 误报

### 问题修复（历史）
- 修复 `ERR_REQUIRE_ESM`
- 修复 `spawn ENOTDIR`
- 修复启动语法错误（多行字符串）
- 修复控制面板“看似已登录但接口仍 401”的一致性问题

---

## 3) 用户手册（安装与使用）

### 3.1 安装
1. 打开 Releases：
   `https://github.com/lawlielt/cursorgateway-desktop/releases`
2. 下载最新 `v3.x.x-desktop` 的 DMG
3. 拖拽 `Cursor Gateway Desktop.app` 到 Applications

### 3.2 首次启动
1. 打开 App（会自动打开控制面板）
2. 点击 **Cursor 登录**
3. 浏览器完成登录
4. 回到 App 点击 **状态检测**
5. 点击 **检查 /v1/models** 确认可用

### 3.3 API 地址
- Base URL：`http://127.0.0.1:3010`
- OpenAI 兼容：`/v1/chat/completions`
- Anthropic 兼容：`/v1/messages`

### 3.4 自检命令
```bash
curl http://127.0.0.1:3010/health
curl http://127.0.0.1:3010/v1/models
```

---

## 4) Claude Code / OpenAI SDK 配置示例

### Claude Code（示例）
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3010",
    "ANTHROPIC_API_KEY": "unused"
  },
  "model": "claude-4.5-sonnet"
}
```

### OpenAI SDK（示例）
```python
from openai import OpenAI
client = OpenAI(api_key="unused", base_url="http://127.0.0.1:3010/v1")
```

---

## 5) Cursor 安全性说明（务必阅读）

### 5.1 Token 安全
- Cursor token 是高敏凭证，等同账号访问能力
- **不要**在聊天、issue、截图中暴露完整 token
- 若泄露，请立刻在 Cursor 侧重新登录/轮换 token

### 5.2 本地存储位置
当前 token 可能位于（按版本兼容）：
- `~/Library/Application Support/cursor-gateway/.cursor-token`
- `~/Library/Application Support/Cursor Gateway Desktop/.cursor-token`

建议你：
- 仅本机保存
- 定期轮换
- 不同步到云盘/公开仓库

### 5.3 网络与暴露面
- 默认只监听本机 `127.0.0.1:3010`
- 不建议直接暴露到公网
- 若要远程访问，请额外加网关认证与访问控制

### 5.4 开源声明
本项目用于本地个人/团队开发场景；请确保使用方式符合 Cursor 服务条款及你所在组织的安全规范。

---

## 6) 故障排查（最常见）

### Q1: `/v1/models` 返回 401
- 先确认登录成功
- 再看 token 文件是否存在（注意路径空格需引号）
- 完全退出 App 后重开最新版

### Q2: 打开应用只跳 Dock
- 使用最新 release
- 首次会自动打开主面板
- 若异常，查看日志：
  `~/Library/Application Support/cursor-gateway/desktop-crash.log`

### Q3: 命令行可用，面板报错
- 多为旧进程或旧包残留
- `pkill -f "Cursor Gateway Desktop"` 后重开

---

## 7) 致谢
- 上游项目：`taxue2016/CursorGateway`
- 感谢社区贡献者与测试反馈用户
