# dsh-plugin-publisher

把插件一键上传到 GitHub，**并且让多台电脑上的 DSH 协作开发同一个仓库** ——
**给 DSH 用的工具，没有界面。**

DSH 里注册七个工具，我（agent）直接调用：

| 工具 | 作用 |
|---|---|
| `check_plugin` | 检查插件目录是否符合要求（只读，不联网） |
| `publish_plugin` | 创建 GitHub 仓库 + 上传代码 + 设置 topic |
| `share_project` | 把本机目录变成"协作项目"（写 `main`，建本机分支） |
| `join_project` | 在另一台电脑加入已有项目（建本机分支 + 装 SSH key） |
| `sync_project` | **日常用的那条**：拉 `main` → 合并 → 推本机分支 |
| `merge_project` | 把别的机器分支合并进来（本地三方合并） |
| `project_status` | 报告本机在这个项目里的状态（只读） |

**用途**：把插件推到 GitHub，然后**在另一台电脑上直接安装**：

```sh
dsh plugin --profile desktop add github:<owner>/<repo>
```

---

## 多机协作：怎么用

### 一句话模型

```
main              大家商量好的结果，只有 share_project 写它
machine/<机器名>   每台电脑自己的分支，只有它自己能写
```

**一台电脑一个分支，谁也不写别人的分支。** 合并发生在**本地 git** 里，
因为 GitHub 的合并 API 遇到冲突会**整体失败**、而且**不给冲突标记**——
那样 agent 就没法自己修冲突了。

### 两个人（或两台电脑）各自要做什么

| 场景 | 需要手动做的事 |
|---|---|
| **同一个 GitHub 账号的第二台电脑** | 装插件 + 配 token，然后 `join_project` |
| **另一个人** | 装插件 + 配 token + 让仓库管理员把你加成 collaborator（`share_project` 的 `collaborator` 参数可以直接邀请） |

**SSH key 不用你管。** 插件会为每台机器自动生成一把钥匙并自动装到仓库上。
（需要手动做一次的事只有一件：如果你愿意，可以自己 `git clone` 一次仓库——
不 clone 也行，`join_project` 会直接在本机目录里 `git init`。）

### 完整流程

```
第一台电脑：
  share_project   directory="C:\...\my-plugin"        ← 建仓库、推 main、建本机分支

第二台电脑：
  join_project    directory="C:\...\my-plugin"        ← 自动装 SSH key、建本机分支、合并 main

之后每台电脑：
  改代码 …
  sync_project    directory="C:\...\my-plugin"        ← 拉 main、合并、推自己的分支

要合别人的活：
  merge_project   directory="C:\...\my-plugin"        ← 默认合进本机分支，检查无误再 into="main"

随时看状态：
  project_status  directory="C:\...\my-plugin"
```

### 冲突怎么办

`sync_project` / `merge_project` / `join_project` 遇到冲突会**停下来并列出文件名**，
不会推任何东西。然后我（agent）去读文件里的标记：

```
<<<<<<< HEAD
=======
>>>>>>> machine/other
```

改完、把标记删掉，**再跑一次同一条命令**就继续了。**不需要人来解冲突。**

### 为什么每台机器一把钥匙

| 原因 | 说明 |
|---|---|
| 一把钥匙只能绑一个仓库 | 实测同一个公钥装到第二个仓库会 **422**，所以钥匙文件按仓库名命名 |
| 账号级 key 管理做不了 | 实测 `GET /user/keys` 返回 **404**（`repo` 权限不够），但**仓库级 deploy key 可以** |
| 没有 ssh-agent | 实测 `ssh-add -l` 报 "No such file or directory"，所以钥匙**不带口令**（否则会卡住等输入） |
| 路径必须用正斜杠 | git 会把 `core.sshCommand` 里的反斜杠吃掉，报错却长得像认证问题 |

**权限决定传输方式，不是偏好**：仓库管理员 → 装 deploy key 走 SSH；
只是 collaborator → 走 HTTPS + token（**只有管理员能管仓库的 deploy key**）。

### 安全默认值

- **`replace_existing` 默认 `false`**：`share_project` 遇到 `main` 已有提交会**拒绝**，
  因为覆盖上传会**删掉别的机器的工作**。
- **推自己的分支从不加 `--force`**：并发推送会**响亮地失败**，不会被悄悄覆盖。
- **只有 `share_project` 用 `--force`**，而且受上面的覆盖保护拦截。
- **推 `main` 之前先查 `/compare/{base}...{head}`**，落后就要求先 `sync_project`。
  （这个查询**只用来提前警告**，合并本身永远是本地三方合并。）

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
| **`replace_existing`** | **`false`（不覆盖已有代码）** |
| `submit` | `false`（**不投稿市场**） |

**发布流程**：

```
1. 检查    ← 本地预检，不改任何东西
2. 验证    ← 用 token 查出你的账号（同时验证 token 有效）
3. 建仓    ← git init + commit + 创建 GitHub 仓库
4. 保护    ← 仓库已有代码？默认拒绝覆盖
5. 上传    ← 整个工作树作为一个 commit
6. 主题    ← 自动设置 dsh-plugin topic
```

**每一步都有反馈，失败会明确说卡在哪、已经完成了什么。**

---

## 默认不覆盖你的代码

这是这个工具**唯一有破坏性的操作**，所以默认关掉。

| 仓库状态 | 行为 |
|---|---|
| 全新仓库 | ✅ 直接发布 |
| 只有 GitHub 自动生成的初始提交 | ✅ 直接发布（那个提交是空的 README） |
| **已有你的提交** | ❌ **拒绝，什么都不改** |

被拒绝时会明确告诉你：

> `the branch "main" already has commits; refusing to replace them.`
> `Nothing was changed. Pass replace_existing to overwrite, or choose a different repository name to keep both.`

**为什么这么设计**：上传会**替换**仓库内容。如果那个仓库里有你在另一台电脑上推的东西，**默认覆盖就等于删掉它**。

**检查在任何文件上传之前**，所以拒绝**零代价**——不会留下半个仓库。

要覆盖就显式传 `replace_existing: true`，这时会**明确警告**正在替换。

---

## 安装命令给两条

发布成功后会打印**两条**安装命令：

```
dsh plugin --profile desktop add github:你/插件名
    (resolved through git; that machine needs git installed)

dsh plugin --profile desktop add https://codeload.github.com/你/插件名/tar.gz/HEAD
    (fetched over HTTPS; needs no git)
```

**为什么给两条**：`github:` 那条**需要目标机器装了 git**。第二条走 HTTPS，**不需要 git**。

**这台机器实测**：`github.com` 20 次只通 6 次。另一台电脑如果更差，第一条会失败——**有备选就不会卡住**。

还会额外给一条**固定到具体版本**的（用 commit SHA），装"确定是这一版"而不是"跟着 HEAD 走"。

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
lib/client.js 里 __ModuleLoader__.load({ id })   ← 有浏览器半的插件才有
```

**必须完全一致。** 对不上的后果是**静默无效**——插件看起来装好了，就是什么都不做，
**没有任何地方报错**。所以是错误级。（本插件没有浏览器半，第三条不适用。）

**② 凭据文件扫描**

> **推到公开仓库的密钥，在推送那一刻就已经泄露**——事后删提交也来不及。

误报的代价（改个文件名）远低于漏报的代价（token 泄露），所以命中即错误。

---

## 已知限制

- **必须重启 DSH**：新增 bundle 只在启动时读取。
- **API 传输单文件上限 40 MB**：超大会明确报错并建议用 release asset。
- **`repo` 权限不能删仓库**：实测 `DELETE /repos/...` 返回 403
  （`Must have admin rights`）。删仓库需要单独的 `delete_repo` 权限。
- **`repo` 权限管不了账号级 SSH key**：实测 `GET /user/keys` 返回 404。
  仓库级 deploy key 可以（这也是协作走 deploy key 的原因）。
- **API 传输会丢文件模式**：符号链接和 `100755` 权限位在 API 路径上不保留。
- **二进制文件没法文本合并**：冲突时只能二选一，不会自动合。
- **公开仓库里的草稿是公开可见的**：推到公开仓库那一刻就可见了。
- **投稿市场是可选的**（`submit: true`），默认关闭。市场还要求仓库创建满 1 天。

---

## 架构

| 文件 | 职责 |
|---|---|
| `lib/tool.js` | 发布两个工具的**定义**：JSON Schema、参数校验、结果渲染 |
| `lib/preflight.js` | 检查：收录要求 + 三方标识 + 凭据扫描 |
| `lib/github.js` | GitHub REST：仓库、主题、deploy key、分支比较 |
| `lib/transfer.js` | API 传输：blob → tree → commit → ref |
| `lib/git.js` | 通过 `ctx.subprocess` 跑 git |
| `lib/publish.js` | 编排发布流程（含双传输回退） |
| `lib/collab.js` | 协作的零件：机器名、分支名、SSH key、URL 解析 |
| `lib/collab-sync.js` | 协作的五个流程：join / share / sync / merge / status |
| `lib/collab-tools.js` | 五个协作工具的**定义** |
| `lib/index.js` | 注册七个工具（**只有这一件事**） |

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
node tools/publisher-tool.test.mjs        # 工具契约：schema、参数校验、结果（53 项）
node tools/publisher-overwrite.test.mjs   # 覆盖保护：拒绝、放行、警告（22 项）
node tools/publisher-eval.test.mjs        # 宿主半求值 + 确认无浏览器代码（59 项）
node tools/publisher-collab.test.mjs      # 协作：分支、钥匙、合并、冲突（104 项）
node tools/hermetic-selftest.mjs          # 确认没有任何测试能碰真实账号（28 项）
```

**392 项。** 关键断言：

- **覆盖保护真的会拦**，且**零代价**（拒绝时一个文件都没上传）
- **只有"自动生成的初始提交"不算已有代码**（否则新仓库永远发不出去）
- **没有导出 `Config`**（导出就会让 Cordis 加载失败）
- **三方标识不一致会被拦**（浏览器半静默失效的那种）
- **凭据文件会被拦**
- **工具 schema 满足 registry 契约**（`output.render` 必须是函数）
- **没有任何测试能碰真实账号**（这条是**扫描其他测试文件**得出的，不是自称）
- **参数自己校验**：未知参数、类型错误、空值都被拒绝
- **没有 token 时报错清楚**，并列出所有提供方式
- **网络失败才回退 API**，认证失败不回退
- **主题设置合并而非覆盖**（不会丢掉用户自己的 topic）
- **插件里没有浏览器代码**（`window.__ModuleLoader__` 一处都没有）
- **`inject` 只声明 `tools`**——访问其他服务一律走 `ctx.get()`
- **一台机器只写自己的分支**（分支名带 `machine/` 前缀，且按名字排序）
- **钥匙文件按仓库命名**（一把钥匙只能绑一个仓库，同名会互相覆盖）
- **Windows 路径转成正斜杠**（反斜杠会被 git 吃掉，报错像认证问题）
- **钥匙不带口令**（没有 ssh-agent，带口令会卡住等输入）
- **冲突时停下来列文件名、且一个字节都不推**
- **`owner` 只给一半时宁可丢掉**（半对会让流程忽略本来就在那儿的 remote）
