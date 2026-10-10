# obsidian-dsh

DeepSeek Harness (DSH) 原生 Obsidian 记忆插件。Agent 通过四个工具把耐久结论写入 Obsidian Markdown，并按需检索、完整读取和生成有界提示词卡片；不是 Obsidian 内部插件，也不依赖 Basic Memory。

仓库名为 `obsidian-dsh`；Harness 包名仍为 `dsh-obsidian-memory`，插件 entry ID 仍为 `obsidian-memory`，保持现有配置兼容。

## 获取源码

```bat
git clone https://github.com/jianyank/obsidian-dsh.git "D:\AI\obsidian-dsh"
cd /d "D:\AI\obsidian-dsh"
```

本仓库仅包含插件源码、测试和文档，不包含 Harness runtime、Obsidian 笔记、desktop profile 或作者工作区的 `_diag` 安装脚本。获取源码不会安装插件或修改你的库。

## 工具与数据

| 工具 | 行为 |
|---|---|
| `memory_write` | 写入或更新一条记忆；同类型、同标题映射到同一文件 |
| `memory_search` | 按关键词查询标题、标签和索引正文，默认只返回 active 条目 |
| `memory_read` | 从源文件读取完整正文和当前元数据，不受索引的 4000 字符限制 |
| `memory_list` | 按类型和状态列出记忆，默认 active、最多 50 条 |

七种类型：`preference`、`project-state`、`decision`、`lesson`、`error-fix`、`open-question`、`glossary`。对应目录见 `lib/vault.js` 的 `TYPE_DIRS`。

笔记 ID 使用单数类型，例如 `decision/代理配置`；文件相对路径则是 `decisions/代理配置.md`。`memory_read` 接受这两种形式，也接受去掉 `.md` 的相对路径。路径相对于记忆子树，不是库根目录。

```json
{
  "type": "decision",
  "title": "代理配置",
  "body": "GitHub 使用代理，内部服务使用直连。",
  "tags": ["网络", "GitHub"],
  "confidence": "high",
  "evidence": "用户确认采用该配置。",
  "supersedes": ["decision/旧代理方案"]
}
```

将以上参数交给 `memory_write`。同标题更新会保留原始 `created`，更新 `updated`；不同标题需要通过 `supersedes` 明确指出被替代的 ID。旧笔记保留但标记为 `superseded`，不会默认进入检索或提示词卡。`retracted` 可以在 Obsidian 中手工设置；本插件没有单独的撤回或删除工具。

写入后默认生成 `Memory/_index.md`。该文件是生成物，手工修改会被覆盖。正文、依据、置信度、来源会话及事件序号保存在笔记中，可在 Obsidian 中查看。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `vaultPath` | `D:/AI/Obsidian/Deepseek Harness` | 库根目录 |
| `memoryRoot` | `Memory` | 插件管理的库内子树 |
| `sandboxMode` | `workspace-write` | 写入限定到 vaultPath；不要无必要地使用 danger-full-access |
| `project` | `deepseek-harness` | 写入笔记的项目标识，不是检索隔离条件 |
| `injectBudgetChars` | `2400` | 卡片严格字符上限，包含省略提示；0 禁用卡片 |
| `alwaysInjectTypes` | `["preference", "open-question"]` | 优先类型；手工 pinned 的 active 条目也优先 |
| `cardRecentCount` | `8` | 额外候选的最近更新条目数 |
| `refreshTtlMs` | `5000` | 检索缓存有效期；过期后在访问时刷新，不是定时轮询 |
| `searchLimit` | `12` | 检索默认返回上限 |
| `rebuildIndexOnWrite` | `true` | 写入后生成索引文件；关闭时仍刷新内存索引 |

profile 的 `cordis.patch.yml` 可以按 `obsidian-memory` entry ID 覆盖配置。不要修改 runtime 安装包来保存配置：

```yaml
- id: obsidian-memory
  name: dsh-obsidian-memory
  config:
    vaultPath: 'D:/AI/Obsidian/Deepseek Harness'
    memoryRoot: 'Memory'
    sandboxMode: workspace-write
    project: deepseek-harness
    injectBudgetChars: 2400
    alwaysInjectTypes: [preference, open-question]
    cardRecentCount: 8
    refreshTtlMs: 5000
    searchLimit: 12
    rebuildIndexOnWrite: true
```

## 安装

此目录仅有源码不代表宿主已加载。插件运行时需要宿主提供 `@deepseek-ai/schemastery` 和 `@deepseek-ai/dsh-tools`，以及 `tools`、`systemPrompt`、`fs` 服务。本机测试使用已安装的 Harness `0.2.0-rc.2` SDK；其他宿主版本尚未验证。

需要安装时，先完全退出 Harness，并备份 desktop profile 的配置。以下安装脚本仅存在于作者的原工作区，不在本仓库中；克隆本仓库后不能直接使用这条命令：

```bat
cd /d "D:\AI\Deepseek Harness-plugin"
pwsh -NoProfile -ExecutionPolicy Bypass -File "_diag\install-obsidian-memory.ps1"
```

该脚本要求 PowerShell 7，会执行 pnpm install、链接源码包并注册 bundle，因此会修改 profile。不要在 Harness 运行时调用。其他工作区需要在自己的 Harness profile 中安装或链接本包，并按上面的 entry 配置注册插件。安装后重启宿主，检查工具列表，再在专用测试库验证写入、检索、读取和更新；离线测试不等于宿主端到端验证。

## 测试

使用 Node.js 24.15.0 或更新版本执行完整测试。测试只使用内存文件系统，不接触真实 Obsidian 库，不启动模型，不修改 profile。

```bat
cd /d "D:\AI\obsidian-dsh"
set "DSH_SDK_ROOT=C:\path\to\harness\node_modules"
npm test
npm run test:unit
npm run test:tools
```

将示例 `DSH_SDK_ROOT` 替换为包含 `@deepseek-ai/schemastery` 和 `@deepseek-ai/dsh-tools` 的实际 node_modules 路径。单元测试 `npm run test:unit` 不依赖 Harness SDK；完整测试和工具测试依赖 SDK，不能只靠 `npm install` 获取宿主服务。

工具测试使用真实 `defineTool` 和 SDK 的 JSON 值校验。测试解析器先使用已可解析的包，否则使用 `DSH_SDK_ROOT`；未设置该变量时，会尝试作者原工作区布局中的 `runtime\desktop\node_modules`。若已安装的 desktop profile 包含 SDK，也可使用：

```bat
set "DSH_SDK_ROOT=C:\Users\yk\.dsh\profiles\desktop\node_modules"
npm test
```

作者原工作区的离线冒烟脚本仍可运行，但同样不在本仓库中：

```bat
cd /d "D:\AI\Deepseek Harness-plugin"
node "_diag\memory-smoke.mjs"
```

## 能力边界

- 不会自动总结每轮对话。Agent 必须调用 `memory_write`；会话投影只保留少量统计和近期用户文本，不写笔记、不调用模型。
- 关键词检索不是语义检索。使用 Unicode 规范化、中文分词和标题/标签/正文加权；多个词是加分排序，不是必须全部匹配。索引正文仍只保留前 4000 字符，尾部内容需用 `memory_read` 读取。
- 提示词卡只包含完整条目，不裁断标题或路径；预算不足时省略后续条目。预算极小到容纳不了标题和省略提示时返回空卡片。常驻协议不属于卡片预算，设置 0 不会移除协议和工具。
- 首次提示词装配可能没有卡片，因为宿主的卡片提供器是同步的。工具会等待初始扫描和已排队写入；读取已索引笔记时总是访问源文件，因此正文和元数据不受缓存 TTL 限制。新增/改名笔记的发现仍依赖缓存刷新。
- 同一插件实例内的写入按调用顺序执行，防止本插件自身的更新竞争；不提供跨进程锁或多文件事务。Obsidian 同时编辑同一文件仍可能发生覆盖。工具写入出错会传播给宿主；新笔记、旧笔记标记和索引并非原子提交，失败后应检查文件与返回结果再重试。
- frontmatter 解析器只支持当前固定结构的标量及列表，不是完整 YAML 解析器；请避免嵌套对象和多行 YAML 值。同标题对应经过清理并截到 64 字符的文件名，过长标题或清理后相同的标题可能映射到同一文件。
- `stability=session` 只是元数据，不会自动过期；`project` 也不会隔离不同会话的检索。需要隔离时使用不同的 memoryRoot 或 vaultPath。
