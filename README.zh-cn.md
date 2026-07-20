# Unity Plus

Unity Plus 是一个 Unity + VS Code 工作流修复工具集。

[English](README.md)

## 为什么需要 Unity Plus

长期使用 VS Code 开发 Unity 项目的人，应该都多少感受过这套工作流的尴尬处境：它不是不能用，但始终不像 Visual Studio 或 Rider 那样被认真对待。

Unity Technologies 和 Microsoft 对 Unity + VS Code 工作流的维护长期不够充分。结果也并不意外：旧插件停止维护，项目文件容易过期，重命名脚本和类时行为脆弱，许多本该由编辑器稳定提供的 Unity 相关功能，只能分散依赖各种插件、脚本或临时方案。它们有时能用，有时失效；有时解决一个问题，又带来新的维护成本。

Unity Plus 正是为此而生。Unity 开发者不应该为了获得一套可靠的 VS Code 工作流，而各自重复承担这些零散而隐性的维护工作。

在构建 Unity Plus 的过程中，我们调研了 Unity + VS Code 的扩展生态。结果发现了数十个小插件——大量已停止维护，功能彼此重叠，每个只解决拼图的一小块。Unity Plus 将其中最核心的能力整合进一个持续维护的扩展中。

## 功能特性

| 功能 | 说明 |
|---|---|
| [Unity Test Runner](#unity-test-runner) | 在 VS Code Testing 面板中浏览、运行和查看 Unity 测试 |
| [重命名同步](#重命名同步) | 顶层 C# 类型重命名时自动同步 `.cs` 文件名 |
| [项目同步](#项目同步) | 脚本创建/移动/删除时自动刷新 `.csproj` |
| [事件引用](#事件引用) | UnityEvent CodeLens、悬停提示和引用位置 |
| [序列化实例](#序列化实例) | 每个脚本的 MonoBehaviour/ScriptableObject 实例计数 |
| [Unity YAML CodeLens](#unity-yaml-codelens) | YAML 资源到 C# 脚本的 CodeLens 链接 |
| [元文件与 Unity 集成](#元文件与-unity-集成) | 打开 Meta 文件、在 Unity 中打开、隐藏 Explorer 中的 .meta |
| [C# 脚本创建](#c-脚本创建) | 从资源管理器创建 C# 脚本 / ScriptableObject |

---

### Unity Test Runner
- 通过 `com.unity.ide.visualstudio` 的 IDE 消息桥接发现 Unity 的所有 EditMode 和 PlayMode 测试。
- 在 VS Code 内置 Testing 面板中以树形层级（项目 → 程序集 → 命名空间 → 类 → 方法）查看测试。
- 一键运行单个测试、类、命名空间或整个测试套件。
- 测试结果（通过 / 失败 / 跳过）内联显示在 Testing 面板中。
- 通过 `unityPlus.refreshUnityTests` 命令或 Testing 面板工具栏按钮手动刷新，桥接重连时自动刷新。
- 需要 Unity Editor 开启并启用 Visual Studio Editor 包 (`com.unity.ide.visualstudio`)。

### 重命名同步
- 当顶层 C# 类型（`class`、`struct`、`enum`、`interface`、`record`）被重命名时，自动同步重命名 `.cs` 文件 —— 包括 `MonoBehaviour` 和 `ScriptableObject`。
- 安全预览：应用重命名前显示受影响的类、脚本文件和 `.meta` 文件。
- 支持 `class`、`struct`、`enum`、`interface` 和 `record` 顶层类型。
- 保留命名空间；避免对包含多个主类的文件进行不安全修改。
- 可配置预览模式：静默、询问或询问+警告。

### 项目同步
- `.cs` 脚本创建、移动或删除时自动刷新 `.csproj` 文件。
- 自动创建缺失的 `.cs.meta` 文件（含正确的 `MonoImporter` 元数据）。
- 解析最近的 `.asmdef` 以将脚本添加到正确的程序集项目。
- 对无 asmdef 的脚本回退到 `Assembly-CSharp` / `Assembly-CSharp-Editor`。
- 通过 `unityPlus.refreshProjectFiles` 手动刷新，显示扫描/更新计数。
- 删除或手动刷新时检测并移除过期的编译条目。

### 事件引用
- CodeLens 在 C# 方法上方显示 UnityEvent 引用计数。
- 悬停提示显示场景/预制体路径、GameObject 名称、组件和事件字段详情。
- 扫描 `.unity` 场景、`.prefab` 预制体和 `.asset` 资源中的持久调用。
- 通过 Unity 元数据索引（GUID → 资源路径）解析目标脚本。
- 状态栏显示扫描进度和最终计数（引用 + 序列化实例）。
- 当前脚本的优先扫描可在后台扫描运行期间提供即时反馈。

### 序列化实例
- CodeLens 显示每个脚本的 `MonoBehaviour` / `ScriptableObject` 序列化实例计数。
- 引用位置通过 GUID 元数据和编辑器类标识符文本搜索解析。
- 诊断信息跟踪已解析、未解析和去重后的实例计数。

### Unity YAML CodeLens
- 在 `.unity`、`.prefab` 和 `.asset` 文件中：CodeLens 链接到关联的 C# MonoBehaviour 脚本。
- `unityPlus.openUnityYamlMonoBehaviourScript` 命令可直接从 YAML 打开脚本。

### 元文件与 Unity 集成
- 资源管理器上下文菜单和编辑器标题栏中的「打开 Meta 文件」命令 (`$(file-code)`)。
- 「在 Unity 中打开」命令 (`$(rocket)`) 通过 IDE 消息将选中资源发送到 Unity 编辑器。
- 「选择 Unity 编辑器」会发现所有存活的本地 IDE 消息端点，并询问当前项目应连接哪个实例。选择仅在该端点存活期间有效；重启 Unity 后会重新询问。
- 可选择在 VS Code 资源管理器中隐藏 `.meta` 文件 (`unityPlus.metaFiles.hideInExplorer`)。

### C# 脚本创建
- 从资源管理器上下文菜单「创建 C# 脚本」和「创建 ScriptableObject」。
- 通过 `unityPlus.templates.*` 设置自定义模板。

## 环境要求

- 安装 Unity Plus 的 VS Code 扩展依赖：C# Dev Kit (`ms-dotnettools.csdevkit`) 和 C# (`ms-dotnettools.csharp`)。建议同时安装 Microsoft 官方 Unity VS Code 扩展 (`VisualStudioToolsForUnity.vstuc`) 以获得更完整的 Unity-VS Code 集成体验，但 Unity Plus 不将其作为强制依赖。
- 在每个 Unity 项目中启用 Unity 官方 Visual Studio Editor 包 (`com.unity.ide.visualstudio`)。Unity Plus 依赖该编辑器端包进行项目文件生成和 Unity IDE 消息通信。

## 路线图

- `v0.1 基础`：VS Code 扩展脚手架、Unity 工作区检测、日志和 CI。✅
- `v0.2 重命名安全`：顶层 C# 类型（`class`、`struct`、`enum`、`interface`、`record`）的类/文件同步。✅
- `v0.3 项目同步`：手动和自动 Unity 项目文件刷新。✅
- `v0.4 事件引用`：场景和预制体 UnityEvent CodeLens、悬停、序列化实例和 Unity YAML CodeLens。✅
- `v0.5 Unity Test Runner`：通过 VS Code Testing API 进行测试发现与执行。✅

## 已知限制

- Unity Plus 依赖 Microsoft C# 和 C# Dev Kit 扩展提供语言服务功能。Unity 项目还需要在编辑器端启用 `Visual Studio Editor` 包以进行项目文件生成和 Unity IDE 消息通信。
- **测试失败堆栈跟踪**：`com.unity.ide.visualstudio` 的 `TestResultAdaptor` 从 Unity 的 `ITestResultAdaptor` 拷贝了 `ResultState` 和 `StackTrace`，但未拷贝 `Message`（NUnit 存放实际断言失败文本的字段）。因此失败测试可能仅显示其 FullName 和 TestStatus，而无法显示详细失败原因。这是 Unity 侧桥接包的自身限制。

## 参与贡献

欢迎提交 Issue 和 Pull Request。Issue 跟踪器是计划工作的唯一真实来源。

## 本地打包

- 运行 `npm run package:vsix` 构建 `dist/unity-plus-<version>.vsix`。
- 运行 `npm run package:install` 构建 VSIX 并安装到 VS Code 中进行本地测试。
- 如果 `code` 不在 `PATH` 中，可设置 `CODE_CLI` 为自定义 VS Code CLI 路径。

## 免责声明

Unity Plus 是一个独立的社区驱动项目，与 Unity Technologies 或 Microsoft 无任何关联、 endorsement 或赞助关系。Unity 及 Unity 徽标是 Unity Technologies 的商标。Visual Studio、VS Code 和 Microsoft 是 Microsoft Corporation 的商标。
