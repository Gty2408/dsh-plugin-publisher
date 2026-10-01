# dsh-plugin-publisher

把插件一键上传到 GitHub —— **给 DSH 用的工具，没有界面。**

DSH 里注册两个工具，我（agent）直接调用：

| 工具 | 作用 |
|---|---|
| `check_plugin` | 检查插件目录是否符合要求（只读，不联网） |
| `publish_plugin` | 创建 GitHub 仓库 + 上传代码 + 设置 topic |

**用途**：把插件推到 GitHub，然后**在另一台电脑上直接安装**：

```sh
dsh plugin --profile desktop add github:<owner>/<repo>
```

---

## 为什么没有界面

这个插件是**给 agent 用的**。插件由 agent 写，所以也该由 agent 发布——而
**工具就是 agent 行动的方式**。

早期版本有个设置页，那意味着**人要手动复制路径、点按钮**——而这一步正是要
消灭的东西。所以设置页连同 `lib/client.js` 和它需要的一整套路由都删掉了。

**结果**：插件里没有一行浏览器代码。

---

## 安装

```sh
dsh plugin --profile desktop add <本目录路径>
```

**需要重启 DSH**（新增 bundle 只在启动时读取）。

---

## 配置 GitHub token

三选一，**按顺序尝试**：

| 方式 | 说明 |
|---|---|
| **1. 插件配置** | profile 的 `cordis.patch.yml` 里写 `token` |
| **2. DSH 凭据服务** | 键名 `DSH_GITHUB_TOKEN` |
| **3. 环境变量** | `DSH_GITHUB_TOKEN` 或 `GITHUB_TOKEN` |

token 需要 **`repo`** 权限（建仓库 + 推代码）。

> **推荐用 2 或 3**——配置文件里的密钥更容易泄露。

**当前状态**：token 已存在 DSH 凭据服务里，键名 `DSH_GITHUB_TOKEN`，**不用再配**。

---

## 用法

### 检查一个插件

```
check_plugin  directory="C:\...\my-plugin"
```

返回逐条检查结果。**只读，不联网，不改任何东西。**

### 发布

```
publish_plugin  directory="C:\...\my-plugin"
```

**通常只需要一个参数。** 其余自动推断：

| 参数 | 默认值 |
|---|---|
| `owner` | 从 token 自动查出（顺便验证 token） |
| `repo` | `package.json` 的 `name` |
| `description` | `package.json` 的 `description` |
| `private` | `false`（公开） |
| `submit` | `false`（**不投稿市场**） |

**发布流程**：

```
1. 检查    ← 本地预检，不改任何东西
2. 验证    ← 用 token 查出你的账号（同时验证 token 有效）
3. 建仓    ← git init + commit + 创建 GitHub 仓库
4. 上传    ← 整个工作树作为一个 commit
5. 主题    ← 自动设置 dsh-plugin topic
```

**每一步都有反馈，失败会明确说卡在哪、已经完成了什么。**

---

## 上传的两条路

```
先试 git push  →  网络不通就自动改用 GitHub REST API
```

**为什么需要两条路**：实测这台机器

```
api.github.com:443    稳定，~185ms
github.com:443        不稳定，20 次里只成功 6 次，耗时 1.2–8 秒
```

`git push` 走 `github.com`，所以**经常失败**。API 走另一个域名，稳定得多。

**只有网络类错误才回退**。认证失败**不回退**——那只会用第二个错误掩盖真正的错误。

---

## 检查什么

### 错误级（阻止发布）

| 检查 | 为什么 |
|---|---|
| `dsh.bundle.patch` 已声明 | **没有它插件根本无法安装**（市场最常见的被拒原因） |
| patch 文件真实存在 | |
| **patch 里的 insert id == 包名** | 不一致则模块加载不到 |
| **浏览器半注册的 id == 包名** | **不一致则浏览器半永远不加载，且没有任何报错** |
| **没有疑似凭据的文件** | `.env` / `*.pem` / `id_rsa` / `.npmrc` … |
| 包名全小写 | npm 拒绝大写 |
| 版本号是合法 semver | |
| 入口文件存在 | 占位仓库不算 |
| owner / repo 名合法 | |

### 警告级（不阻止）

`keywords` 缺 `dsh-plugin`、没有 README、没有 `.gitignore`、根目录有超大文件……

### 最值钱的两条

**① 三方标识一致性**

插件的身份写在三个地方：

```
package.json 的 name
cordis.patch.yml 里 insert 的 id
lib/client.js 里 __ModuleLoader__.load({ id })
```

**必须完全一致。** 对不上的后果是**静默无效**——插件看起来装好了，就是什么都不做，
**没有任何地方报错**。所以是错误级。

**② 凭据文件扫描**

> **推到公开仓库的密钥，在推送那一刻就已经泄露**——事后删提交也来不及。

误报的代价（改个文件名）远低于漏报的代价（token 泄露），所以命中即错误。

---

## 已知限制

- **必须重启 DSH**：新增 bundle 只在启动时读取。
- **API 传输单文件上限 40 MB**：超大会明确报错并建议用 release asset。
- **`repo` 权限不能删仓库**：实测 `DELETE /repos/...` 返回 403
  （`Must have admin rights`）。删仓库需要单独的 `delete_repo` 权限。
- **投稿市场是可选的**（`submit: true`），默认关闭。市场还要求仓库创建满 1 天。

---

## 架构

| 文件 | 职责 |
|---|---|
| `lib/tool.js` | 两个工具的**定义**：JSON Schema、参数校验、结果渲染 |
| `lib/preflight.js` | 检查：收录要求 + 三方标识 + 凭据扫描 |
| `lib/github.js` | GitHub REST：仓库、主题 |
| `lib/transfer.js` | API 传输：blob → tree → commit → ref |
| `lib/git.js` | 通过 `ctx.subprocess` 跑 git |
| `lib/publish.js` | 编排流程（含双传输回退） |
| `lib/index.js` | 注册两个工具（**只有这一件事**） |

### 技术约束（实测得出）

**① 插件无法 `import '@deepseek-ai/*'`**

实测 `ERR_MODULE_NOT_FOUND`（`dsh-tools`、`dsh-credentials` 等全部）。
所以一切都通过 `ctx` 服务访问。

**② 工具 schema 是手写的 JSON Schema**

一线工具的 `defineTool` 在 `@deepseek-ai/dsh-tools` 里，**导入不了**。
所以参数 schema 直接写成 JSON Schema——`tools.register()` 接受原始 schema，
只要求 `output.render` 是函数。

**代价**：registry **不再帮我们校验参数**。所以 `execute` 自己校验（见
`readArgs`）。这在这里格外重要——**参数写错意味着在用户账号下创建公开仓库**。

**③ 绝对不要导出 `Config`（踩过的坑）**

Cordis 用 `runtime.Config["~standard"].validate(config)` 校验插件配置，
要求的是一个 **Standard Schema**（带 `~standard` 属性）。
**纯 JSON Schema 没有这个属性**，所以导出一个会让 `Config["~standard"]`
变成 `undefined`，插件**加载直接失败**：

```
fiberPhase: "failed"
Cannot read properties of undefined (reading 'validate')
```

Standard Schema 通常来自 schema 库（`schemastery` / `zod`），而**它们都导入不了**。
所以**不导出 Config**（本 profile 里其他能正常工作的插件也都这样），
配置改从 `apply` 的第二个参数读，并且**逐字段自己校验**。

**④ 品牌字符串运行时是恒等函数**

`credentialRef()` 只是校验后调用 `brandString()`，而 `brandString(v) { return v }`
——品牌纯粹是编译期的。所以可以直接传普通字符串给 `ctx.credentials`。

---

## 测试

```sh
node tools/publisher-preflight.test.mjs   # 收录要求 + 三方标识 + 凭据扫描（49 项）
node tools/publisher-publish.test.mjs     # 发布流程：顺序、失败、分支、主题（77 项）
node tools/publisher-tool.test.mjs        # 工具契约：schema、参数校验、结果（52 项）
node tools/publisher-eval.test.mjs        # 宿主半求值 + 确认无浏览器代码（32 项）
```

**210 项。** 关键断言：

- **没有导出 `Config`**（导出就会让 Cordis 加载失败）
- **三方标识不一致会被拦**（浏览器半静默失效的那种）
- **凭据文件会被拦**
- **工具 schema 满足 registry 契约**（`output.render` 必须是函数）
- **参数自己校验**：未知参数、类型错误、空值都被拒绝
- **没有 token 时报错清楚**，并列出所有提供方式
- **网络失败才回退 API**，认证失败不回退
- **主题设置合并而非覆盖**（不会丢掉用户自己的 topic）
- **插件里没有浏览器代码**（`window.__ModuleLoader__` 一处都没有）
- **`inject` 只声明 `tools`**——访问其他服务一律走 `ctx.get()`
