# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架 / AI 智能体）。

它既可以通过 `npx @deepseek-ai/dsh web` 在本机一键拉起 Web UI 自托管运行，也可以在 Linux（Ubuntu 24.04 / Debian / 树莓派 5 / ARM 服务器）上打包成桌面客户端（AppImage / `.deb` / `.tar.gz`）使用 —— 一个开源、可本地部署的 DeepSeek 客户端与 AI 助手框架。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

### Linux 桌面端

桌面应用可在 Ubuntu 24.04（或兼容发行版）上打包，支持两种架构（x64/ARM64），每种架构产出三种安装格式（AppImage、Debian `.deb`、便携 `.tar.gz`）：

```sh
pnpm install
cp apps/desktop/.env.linux.example apps/desktop/.env.linux   # 然后填入发布配置
pnpm --dir apps/desktop run package:linux:x64                # x64（AMD/Intel）：AppImage + deb + tar.gz
pnpm --dir apps/desktop run package:linux:arm64              # ARM64：AppImage + deb + tar.gz
```

打包 AppImage 时构建机需要 FUSE 2（`libfuse2`）；`.deb` 打包需要 maintainer 字段（Linux 配置中已内置）。Linux 构建不做代码签名：自动更新走 `electron-updater` 的 AppImage 渠道，链路依赖 HTTPS 与 `nightly-linux.yml` 元数据、无签名校验，若要向第三方分发，这是需要评估的供应链环节。`.deb` 与 `.tar.gz` 作为同版本安装包一并发布。仓库内置 `Desktop (Linux)` 工作流可在原生双架构 runner 上一键构建。发布版本号、上传与各平台环境变量文件详见[桌面端打包说明](apps/desktop/README.md)。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 如果你在搜索这些词

- **DeepSeek Linux** / **DeepSeek 桌面端 Linux** / **DeepSeek on Linux**
- **DeepSeek 客户端下载** / **DeepSeek 桌面客户端** / **DeepSeek 安装包**
- **DeepSeek AppImage** / **DeepSeek .deb** / **Ubuntu 安装 DeepSeek** / **Debian DeepSeek**
- **树莓派 DeepSeek** / **ARM64 DeepSeek** / **DeepSeek Linux 安装**
- **开源 DeepSeek** / **本地部署 DeepSeek** / **自托管 AI 助手** / **DeepSeek 智能体**

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
