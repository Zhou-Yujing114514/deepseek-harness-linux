# DeepSeek Harness · Linux 桌面版

> 给官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面端补上**一等公民级的 Linux 打包** —— 开箱即用的 AppImage / `.deb` / `.tar.gz`，覆盖 x64 与 arm64 双架构，配套原生 CI 与 AppImage 自动更新。

官方桌面端只发布 macOS 与 Windows；Linux 用户要么退而用 Web 版，要么自己从源码硬编。本项目就是这个缺口的补完：在保留官方桌面全部功能的前提下，把 Linux 当成**正式支持平台**来打包、测试、分发。

## 这是什么 / 不是什么

- ✅ **是**：一个下游 fork，专注做一件事——让 dsh 桌面端在 Linux 上「能下载、能装、能更新」。
- ❌ **不是**：不是官方 DeepSeek 项目，也不魔改 agent 内核。agent 能力、插件体系、通信协议全部跟随上游。

## 产物一览

每次构建为每种架构产出三种安装包：

| 格式 | 用途 | 典型文件名 |
|------|------|-----------|
| **AppImage** | 单文件免安装，支持自动更新 | `deepseek-harness-0.2.0-rc.2-linux-x64.AppImage` |
| **.deb** | Debian / Ubuntu 系原生包管理 | `deepseek-harness-0.2.0-rc.2-linux-x64.deb` |
| **.tar.gz** | 便携解压即用 | `deepseek-harness-0.2.0-rc.2-linux-x64.tar.gz` |

支持架构：`x64`（AMD / Intel）、`arm64`（树莓派 5、Apple Silicon 上的 Linux、ARM 服务器等）。

## 快速开始

### 方式一：AppImage（推荐，支持自动更新）

1. 到 [Releases](../../releases) 下载对应架构的 `.AppImage`。
2. 安装运行时依赖（AppImage 需要 FUSE 2）：
   ```sh
   sudo apt install libfuse2          # Debian / Ubuntu
   # Fedora / RHEL 系: sudo dnf install fuse2
   ```
3. 赋予执行权限并运行：
   ```sh
   chmod +x deepseek-harness-*-linux-x64.AppImage
   ./deepseek-harness-*-linux-x64.AppImage
   ```

### 方式二：.deb

```sh
sudo dpkg -i deepseek-harness-*-linux-x64.deb
deepseek-harness            # 或直接从应用菜单启动
```

### 方式三：.tar.gz（便携）

```sh
tar -xzf deepseek-harness-*-linux-x64.tar.gz
cd deepseek-harness-*-linux-x64
./deepseek-harness          # 运行解压目录内的启动入口
```

> 在无显示环境（如远程服务器 + VNC）运行时，确保已设置 `DISPLAY`（例如 xfce4 + TigerVNC 下的 `:1`），桌面会自动拉起。

## 从源码构建（开发者）

需要 Node.js 24+、pnpm，以及构建主机上的 `libfuse2`（AppImage 组装所需）。

```sh
git clone https://github.com/Zhou-Yujing114514/deepseek-harness-linux.git
cd deepseek-harness-linux
pnpm install
cp apps/desktop/.env.linux.example apps/desktop/.env.linux   # 按需填写发布设置
pnpm --dir apps/desktop run package:linux:x64                # x64
pnpm --dir apps/desktop run package:linux:arm64              # arm64
```

`Desktop (Linux)` 工作流会在原生 runner 上按需构建两种架构（`ubuntu-24.04` / `ubuntu-24.04-arm`），产物可在 Actions Artifacts 或自动发布的 Release 中获取。

## 自动更新

AppImage 通过 `electron-updater` 走 AppImage 更新通道，更新描述符为 `nightly-linux.yml`，全程 HTTPS。未签名构建下，更新**仅依赖 HTTPS 传输与 feed 元数据校验**，无代码签名验签——请勿用于高信任场景，下载时务必核对 Release 附带的 SHA256。

## 已知限制

1. **未签名**：Linux 构建不带代码签名。这是社区构建，分发时请在 Release 中核对校验和。
2. **Office 文档转换暂缺**：桌面内嵌的 DOCX / XLSX / PPTX → PDF 转换依赖 LibreOffice Kit 的 Linux 原生绑定，本版本尚未将其随包分发，该功能在 Linux 下暂不可用。其余桌面功能（agent、skill、联网、前端）均正常。
3. **上游处于 developer preview**：官方迭代快、破坏性变更频繁，本项目会持续 rebase 上游提交。
4. **无公证 / 无商店上架**：不走任何系统级公证或应用商店流程。

## 与上游的关系

- 上游：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，DeepSeek-AI）。
- 本仓库是其下游 fork：**agent 内核与官方保持同步**，新增内容仅限于 Linux 打包层——CI 工作流、electron-builder 配置、类型声明补全、POSIX launcher 兼容、桌面端打包说明与单元测试用例。
- 计划将 Linux 打包支持以 PR / Discussion 形式回喂上游，让官方原生支持 Linux 桌面。

## 安全须知

- 运行前请阅读上游 [SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)。
- 未签名二进制存在供应链风险：只从本仓库 Release 下载，并核对 SHA256 校验和。
- 自动更新通道未做代码签名验签，仅依赖 HTTPS + feed 元数据。

## 许可证

本项目基于上游 **MIT** 许可证分发。DeepSeek Harness 由 DeepSeek-AI 开发，版权归其所有；Linux 打包层在同一 MIT 许可下新增。详见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
