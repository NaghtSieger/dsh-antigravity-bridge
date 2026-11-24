# Antigravity bridge for DeepSeek Harness

通过官方 Antigravity CLI 的 ACP 接口，把本机可用的模型接入 DeepSeek Harness (DSH)。默认 bridge 模式由 DSH 声明工具、执行工具并处理审批。插件使用当前会话提供的工作区、工具和规则；模型目录来自 CLI，显示名称和隐藏规则由每个安装实例单独配置。

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

基于 [catcatchcatast/dsh-antigravity-bridge](https://github.com/catcatchcatast/dsh-antigravity-bridge) 与 [lili-luo 的 dsh-llm-antigravity-acp](https://github.com/lili-luo/dsh-plugin-bundle/tree/main/dsh-llm-antigravity-acp)，保留原作者 MIT 许可。[MIT 许可证](LICENSE)

本仓库在上游基础上额外叠加了 3 项加固与兼容：
- **macOS / Linux 常见路径自动探测**：未配置 `command` 且 `PATH` 缺失时自动探测 `~/.local/bin/agy`、`~/.antigravity/bin/agy`、`/opt/homebrew/bin/agy`、`/usr/local/bin/agy` 等独立 CLI 路径（不误选 IDE shim）。
- **子进程认证环境隔离**：启动 `agy` 时通过 tombstone 剥离 `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`AGY_ADC_AUTH`、`DSH_AGY_LOCAL_KEY`，避免环境残留覆盖订阅 OAuth。
- **401 / 403 / TOS 首轮立即取消**：流中首次出现明确认证/策略拒绝时立刻取消并保留原始错误与 `requestId`，防止工具结果晚到触发二次请求，同时保持上游 429 与额度分类逻辑不变；兼容 DSH `0.2.2-rc.5` `LlmError.fromFailure`。

## 已验证范围

在 Windows 上用 DSH 0.2.1-rc.5 CLI 将压缩包安装到新命名的空配置，使用宿主 SDK 加载插件并核对默认设置。使用模拟 ACP 进程运行的 282 项回归中有 278 项通过。4 项在发布前的基线上也能复现：一项涉及跨工具步骤的重答预算，两项涉及系统提示及工具契约文本断言，一项需要 Windows 测试进程具备创建符号链接的权限。
