# Antigravity bridge for DeepSeek Harness

通过官方 Antigravity CLI 的 ACP 接口，把本机可用的模型接入 DeepSeek Harness (DSH)。默认 `safe-bridge` 安全桥接模式**完整保留官方 `systemInstruction` 不篡改**，通过 ACP 原生元数据关闭 `agy` 内置工具，由 DSH 100% 接管工具声明、执行与审批；同时融合了多个社区优秀方案的核心工程与防封能力：

- **默认 `safe-bridge` 防封模式**：不传 `--agent dsh-bridge`、不设 `excludeDefaultComponents: true`、不修改 `_meta.antigravity.systemPrompt`；通过 `_meta.antigravity: { enabledTools: [], eagerMcpServers: ['dsh'] }` 关闭原生工具并将中性化工作区指南与精确工具签名放入首轮消息（仍保留 `bridge` / `native` 可切换）。
- **429 / 403 / TOS 首轮熔断器（`circuitBreakerOn429: true`）**：检测到上游 `RESOURCE_EXHAUSTED` / `TOS_VIOLATION` / `PERMISSION_DENIED` / `UNAUTHENTICATED` 时立刻发 `session/cancel` 截断 `agy` 内部重试风暴，避免连撞升级为封号。
- **完整兼容 `agy 1.5.15+` 会话后缀**：权限门禁与回环调用严格识别 `mcp_dsh_<8hex>_<tool>` 与 `dsh_<8hex>`，同时 100% 拒绝所有 `agy` 原生工具与外来 MCP。
- **MCP 参数清洗与前置校验**：自动剔除未声明的 `toolSummary` 字段保护严格 Schema；缺必填参数时在桥接层直接返回带正确签名的可修正报错。
- **环境变量隔离与 macOS 自动探测**：拉起子进程前自动剥离 `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `AGY_ADC_AUTH` / `DSH_AGY_LOCAL_KEY` 防止误扣按量费；自动探测 macOS 常见 `agy` 路径。
- **保留原有全部长处**：SSE 立即发响应头 + 15s 保活 + 85s `dsh_await_result` 长时工具中继、`splitReplay` 长历史安全分片、5 维 SQLite 暗降级检测、多账号池与额度胶囊、`xhigh` 思考档、DSH `0.2.2-rc.5` `LlmError.fromFailure` 兼容。

## 安装

需要兼容的 DSH 0.2.x 宿主、Node.js 22.19 或更高版本，以及已通过官方流程登录的 agy CLI（1.5.0 或更高版本）。在运行 DSH 的操作系统账号下确认 `agy --version` 可用。包内已包含编译好的 `lib/`。

在 DSH 的插件安装入口使用本仓库的 Git 地址：

```text
git+https://github.com/NaghtSieger/dsh-antigravity-bridge.git
```

使用 DSH CLI 时，将 `PROFILE_NAME` 替换为实际运行的配置名，例如桌面端通常是 `desktop`，Web 服务通常是 `web`。

```sh
dsh plugin --profile PROFILE_NAME add "git+https://github.com/NaghtSieger/dsh-antigravity-bridge.git"
```

也可在本仓库根目录运行 `npm pack`，把生成的 tgz 安装到目标 DSH 配置。在插件管理中确认已启用，然后从模型选择器的 Antigravity 分组选择模型。

## 配置与会话

- 默认查找本机安装的 agy。可通过插件的 `command` 指定可执行文件，通过 `home` 指定插件数据目录。
- 首次安装默认使用当前操作系统账号的官方 CLI 登录状态。模型可用性和额度取决于该账号。
- `hiddenModels` 默认为空。按需隐藏名称或模型 ID；支持通配符，新模型只要与隐藏规则不匹配便可显示。
- 默认使用 CLI 的标准上下文配置。启动时仅在显式配置 `patchScript` 后运行可选检查，`autoPatch` 默认关闭。
- 会话续接和长历史交接使用 DSH 提供的会话消息及已有摘要。工具权限与审批由实际使用的 DSH 会话决定。

## 开发

`src/` 存放源码，`lib/` 是供宿主直接加载的产物，`tests/` 包含使用模拟 ACP 进程的回归测试。源码开发需要兼容的 DSH SDK 和 TypeScript。设置 `DSH_CHECKOUT` 为已安装依赖并构建的 DSH 源码目录，再运行 `npm run build` 与 `npm test`。直接安装预编译插件无需设置此变量。

## 来源与许可

基于 lili-luo 的 dsh-llm-antigravity-acp，保留原作者 MIT 许可。本仓库提供独立分发的桥接适配。[上游源码](https://github.com/lili-luo/dsh-plugin-bundle/tree/main/dsh-llm-antigravity-acp) · [MIT 许可证](LICENSE)

## 已验证范围

在 Windows 上用 DSH 0.2.1-rc.5 CLI 将压缩包安装到新命名的空配置，使用宿主 SDK 加载插件并核对默认设置。使用模拟 ACP 进程运行的 282 项回归中有 278 项通过。4 项在发布前的基线上也能复现：一项涉及跨工具步骤的重答预算，两项涉及系统提示及工具契约文本断言，一项需要 Windows 测试进程具备创建符号链接的权限。
