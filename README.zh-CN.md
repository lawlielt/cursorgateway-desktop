# Cursor Gateway Desktop

将 Cursor 能力暴露为 OpenAI / Anthropic 兼容 API 的桌面网关应用。

**支持平台：** macOS + Windows

## 项目来源

本项目基于以下仓库重构：
- 上游： https://github.com/taxue2016/CursorGateway

本仓库不是镜像，包含桌面化、打包和稳定性增强。

## 当前发布形态

- **macOS：** DMG
- **Windows：** NSIS 安装包（`*-setup-x64.exe`）

Releases：
- https://github.com/lawlielt/cursorgateway-desktop/releases

## 核心能力

- 菜单栏/托盘常驻 + 控制面板
- 图形化 Cursor 登录
- 健康检测与模型检测（`/health`、`/v1/models`）
- 一键导入 Claude Code 配置
- 启动体验优化（loading、watchdog 自动恢复）
- Token 持久化到用户可写目录

## 快速开始

1. 在 Release 下载对应系统安装包。
2. 安装应用：
   - macOS：打开 DMG，拖到 Applications
   - Windows：运行 `Cursor Gateway Desktop-<version>-setup-x64.exe`
3. 打开应用后点击 **Cursor 登录**。
4. 点击 **状态检测**。
5. 在面板内点击 **检查 /v1/models** 验证可用。

## API 地址

- Base URL：`http://127.0.0.1:3010`
- OpenAI 兼容：`/v1/chat/completions`
- Anthropic 兼容：`/v1/messages`

## 安全说明

- Cursor token 属于高敏凭证。
- 不要在截图/issue/聊天中暴露 token。
- 默认仅建议本机使用；若公网暴露请自行加认证。

## 文档

- English README: `README.md`
