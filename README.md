# dsh-plugin-publisher

在 DSH 里把你自己做的插件**一键发布到 GitHub 并提交到插件市场**。

打开 **设置 → 发布插件**，填一个目录路径，点几下。

---

## 它做什么

```
1. 检查    ← 本地预检，不改任何东西
2. 授权    ← 验证 GitHub token
3. 建仓    ← git init + commit + 创建 GitHub 仓库 + 上传
4. 主题    ← 自动设置 dsh-plugin topic（收录硬性要求）
5. 上架    ← fork 插件市场 → 加一个 YAML → 提 PR
```

每一步都有进度反馈，**失败会明确告诉你卡在哪一步、已经完成了什么**。

**上传有两条路**：先试 `git push`，遇到网络问题自动回退到 GitHub REST API。
投稿 PR **永远走 API**。原因见下面的「两个已修复的严重 bug」。

---

## 为什么值得用

### 它替你避开了最常见的被拒原因

插件市场的官方指南明确指出：**最常见的被拒原因是 `package.json` 只声明了
`dsh.client`——那样根本无法安装**。

本插件的预检会逐条核对官方要求：

| 检查项 | 级别 |
|---|---|
| `dsh.bundle.patch` 已声明（**否则无法安装**） | ❌ 错误 |
| patch 文件真实存在 | ❌ 错误 |
| **patch 里的 insert id == 包名** | ❌ 错误 |
| **浏览器半注册的 id == 包名** | ❌ 错误 |
| **没有疑似凭据的文件**（`.env` / `*.pem` / `id_rsa` …） | ❌ 错误 |
| 包名全小写（npm 拒绝大写） | ❌ 错误 |
| 版本号是合法 semver | ❌ 错误 |
| 入口文件存在（占位仓库不收） | ❌ 错误 |
| owner / repo 名合法 | ❌ 错误 |
| 分类是官方 23 个取值之一 | ❌ 错误 |
| 英文描述以句号结尾 | ❌ 错误 |
| `keywords` 含 `dsh-plugin`（只是 npm 搜索提示） | ⚠️ 警告 |
| 描述里没有营销词 | ⚠️ 警告 |
| 描述里声称了具体数量（会被核对） | ⚠️ 警告 |
| 有 LICENSE 文件 | ⚠️ 警告 |
| 有 README / `.gitignore` | ⚠️ 警告 |
| 根目录有超大文件 | ⚠️ 警告 |

**错误会阻止发布，警告不会。** 这样你在本地就知道问题，而不是在维护者的 PR
评论里。

### 最值钱的一条：三方标识一致性

一个 DSH 插件的身份写在**三个地方**：

```
package.json 的 name
cordis.patch.yml 里 insert 的 id
lib/client.js 里 __ModuleLoader__.load({ id })
```

**三者必须完全一致。** 如果浏览器半注册的 id 和包名对不上：

> **浏览器半永远不会加载，而且没有任何地方报错。**
> 插件看起来装好了，就是什么都不做。

这是插件最糟糕的失败模式——**静默无效**。所以这是**错误级**检查，不是警告。

### 凭据文件会被拦住

发布前扫描 `.env`、`*.pem`、`*.key`、`id_rsa`、`.npmrc`、`.netrc`、含
`credential`/`secret` 的文件名，命中就是**错误**：

> **推到公开仓库的密钥，在推送那一刻就已经泄露了**——即使事后删除提交也来不及。

误报的代价（改个文件名）远低于漏报的代价（token 泄露）。

### 它按正确的顺序做事

顺序不是随意的——**不可逆的操作排在可逆的检查之后**：

```
预检（只读） → 验证 token（只读） → 本地提交 → 创建仓库 → push → 提 PR
```

所以 token 无效时，**一个仓库都不会被创建**；预检失败时，**连 GitHub 都不会碰**。

### 失败时它保住已完成的工作

如果 push 失败，**已创建的仓库仍然会告诉你地址**——工作没丢。
如果只是提 PR 失败（比如 fork 被禁用），**插件本身已经发布成功了**，
结果会明确区分这两件事。

### token 不会泄漏

GitHub token 有账号下所有仓库的写权限。所以：

- 存在 **DSH 宿主的凭据服务**里（`ctx.credentials`），不是配置文件、不是浏览器
- **浏览器端永远拿不到 token**——它只能查到「配了没有」这一个布尔值
- 保存前**先验证**：无效的 token 会立刻报错，而不是等到 push 时给你一句模糊的失败
- push 时临时把 token 嵌进 URL，**用完立即移除**，不会留在 `.git/config` 里
- 任何错误信息都会**脱敏**（`ghp_…` 之类会被替换成 `<redacted>`）

### 它拒绝提交脏 fork

提交前会检查 fork 的工作树。如果里面有多余的改动（比如你的 fork 过期了），
**它会拒绝提交并说明原因**，而不是把别人的修改一起推上去。

---

## 安装

```sh
dsh plugin --profile desktop add <本目录路径>
```

**需要重启 DSH**——新增 bundle 只在启动时读取。

---

## 用法

### 1. 准备一个 GitHub token

GitHub → Settings → Developer settings → **Personal access tokens (classic)**
→ Generate new token，勾选 **`repo`** 权限。

> 细粒度 token 也可以，需要 **Contents: Read and write** 和
> **Pull requests: Read and write**。

### 2. 填进插件

**设置 → 发布插件 → 2 · GitHub access**，粘贴 token，点「Save token」。

保存时会**先调用 GitHub 验证**，成功后会显示你的账号名。

token 存在宿主的凭据服务里，键名 `DSH_GITHUB_TOKEN`。也可以用同名环境变量提供。

### 3. 填目录和上架信息

| 字段 | 说明 |
|---|---|
| Plugin directory | 你插件目录的**绝对路径** |
| GitHub owner | 你的 GitHub 用户名 |
| Repository name | 想要的仓库名 |
| Category | 官方 23 个分类之一 |
| Description | **英文、一行、以句号结尾**（必填） |
| 中文描述 | 可选 |

### 4. 先点「Check」

预检结果会逐条列出。**错误必须清零**，警告可以自行判断。

### 5. 点「Publish to GitHub」

完成后再点一次也可以——**重复运行是安全的**：

- 已存在的仓库会复用，不会报错
- 已存在的 PR 会被找到，不会开第二个
- remote 会被更新，不会因「已存在」失败

---

## 两个已修复的严重 bug

这两个都**实际发生过**，不是假设。写在这里是因为它们直接决定了代码的形状。

### 1. 所有投稿共用一个分支 → 互相覆盖

初版用一个**固定分支名** `add-plugin` 提交所有插件。fork 上只有**一个**这样的分支，
所以第二次发布**覆盖了第一次的提交**。

**实际后果**：`dsh-word-translate` 的投稿 PR 标题写着 word-translate，
但 diff 变成了 publisher，而 word-translate 的投稿文件**从分支上被删掉了**——
那个 PR 永远无法正确合并。

**修法**：分支名从插件仓库名派生（`add-<repo>`）。每个插件有自己的分支，互不干扰；
同一个插件重跑仍能找到自己的分支（"已存在 PR"检测才有效）。

回归断言：**两个不同插件必须用两个不同分支**。

### 2. `git push` 在部分网络下不可能成功

实测这台机器：

```
api.github.com:443    ✅  185ms
github.com:443        ❌  22 秒超时（TCP 连接失败）
```

`git push` 走 `github.com`，所以**物理上无法成功**——第一次发布就是这样失败的
（`curl 52 Empty reply from server`）。

**修法**：双传输。先试 `git push`，**仅在网络类错误时**回退到 REST API
（`blobs → tree → commit → ref`）。认证失败**不会**触发回退——那只会掩盖真正的错误。
结果里会报告实际用了哪种传输（`transport: 'git' | 'api'`）。

> **投稿 PR 永远走 API**，不走 clone。API 路径用 `base_tree` 构造，天然是**增量**的
> （在 fork 现有内容之上加一个文件），所以没有"脏工作树"风险。
>
> 这一点有专门的断言守着：**提交树必须带 `base_tree`**。漏掉它会生成一个
> 只含投稿文件的提交，**静默删掉整个插件列表**。

---

## 已知限制

- **必须重启 DSH**：新增 bundle 需要重启才加载。宿主半的改动同理
  （本 profile 的 HMR 默认不监听任何模块根目录）。
- **仓库创建满 1 天**才能被收录——这是市场的规定，插件无法绕过。
  刚建的仓库提 PR 会被 CI 拒。
- **topic 自动设置**，不需要手动操作。实测 `PUT /repos/:o/:r/topics`
  在 `repo` 权限下可用；如果失败，只是**警告**而不是发布失败
  （代码已经上传，你可以手动补）。
- **不能发 npm**：本插件只做 GitHub 发布 + 市场收录。
  发布到 npm 是另一条独立的路（市场收录不依赖它）。
- **API 传输有单文件上限**：40 MB（GitHub blob API 的限制）。
  超过的文件会明确报错并建议改用 release asset。

---

## 架构

| 文件 | 职责 |
|---|---|
| `lib/preflight.js` | 收录要求 + 三方标识 + 凭据扫描 + 生成投稿 YAML |
| `lib/github.js` | GitHub REST 调用（仓库、主题、fork、PR） |
| `lib/transfer.js` | API 传输：blob → tree → commit → ref；投稿 PR |
| `lib/git.js` | 通过 `ctx.subprocess` 跑 git |
| `lib/publish.js` | 编排整个流程（含双传输回退） |
| `lib/index.js` | 宿主半：4 条 loopback 路由 |
| `lib/client.js` | 浏览器半：设置页 |

### 两个技术约束（实测得出）

**① 插件无法 `import '@deepseek-ai/*'`。**
本部署里这些包不可解析（实测 `ERR_MODULE_NOT_FOUND`）。
所以一切都通过 `ctx` 服务访问，而不是 import 类型或工具函数。

**② 品牌字符串运行时是恒等函数。**
`credentialRef()` 只是校验后调用 `brandString()`，而
`brandString(value) { return value }`——品牌纯粹是编译期的。
所以可以直接传普通字符串给 `ctx.credentials`，不需要导入那个包。

### 为什么用设置页而不是聊天界面

发布是一个**偶尔发生的、表单形状的、结果很长的**操作。
设置页是 DSH 给这类操作的正式位置，`dsh-market` 已经这么做了，属于既有模式。

---

## 测试

```sh
node tools/publisher-preflight.test.mjs   # 收录要求 + 三方标识 + 凭据扫描（49 项）
node tools/publisher-publish.test.mjs     # 发布流程：顺序、失败、分支、主题、脱敏（77 项）
node tools/publisher-eval.test.mjs        # 两端模块求值 + 路由守门（38 项）
```

**164 项。** 覆盖的关键行为：

- 预检对**真实可发布插件**通过、对**故意做坏的包**报出每一条错误
- **三方标识不一致会被拦**（浏览器半静默失效的那种）
- **凭据文件会被拦**（`.env` / 私钥 / `.npmrc` …）
- 发布流程的**顺序**（预检 → token → 本地提交 → 建仓 → 上传 → 主题 → 提 PR）
- **失败语义**：坏 token 不建仓库；预检失败不碰 GitHub；
  上传失败仍报告已建仓库；仅提 PR 失败时发布仍算成功
- **网络失败才回退 API**，认证失败不回退（否则掩盖真正的错误）
- **两个不同插件用两个不同分支**（防止投稿互相覆盖）
- **提交树必须带 `base_tree`**（漏掉会静默删掉整个插件列表）
- **主题设置合并而非覆盖**（不会丢掉用户自己的 topic）
- **token 不泄漏**：不出现在结果里、不出现在步骤详情里、错误信息被脱敏
- 每条路由都拒绝非本机来源和非 POST 方法
