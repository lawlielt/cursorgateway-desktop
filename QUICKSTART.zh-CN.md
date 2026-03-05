# Cursor Gateway Desktop（免手工环境）

基于 `taxue2016/CursorGateway` 重构：
- 不依赖 Cursor Agent CLI
- 直接使用 Cursor Token
- 提供 macOS 桌面应用（菜单栏常驻）

## 一次性构建 DMG（开发机）
```bash
npm install
npm run dist:app
```

产物：`dist/*.dmg`

## 用户侧安装与使用（无需 npm / node）
1. 双击安装 DMG
2. 打开 `Cursor Gateway Desktop`
3. 菜单栏点击 `CG`，打开控制面板
4. 点击“Cursor 登录”完成 token 获取（或放置 `.cursor-token`）
5. 检查 `/health` 与 `/v1/models`

默认端点：
- `http://127.0.0.1:3010/v1`

## 兼容接口
- OpenAI Chat Completions: `/v1/chat/completions`
- Anthropic Messages: `/v1/messages`
