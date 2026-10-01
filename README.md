# dsh-plugin-publisher

在 DSH 里把你自己做的插件**一键发布到 GitHub 并提交到插件市场**。

打开 **设置 → 发布插件**，填一个目录路径，点几下。

---

## 它做什么

```
1. 检查    ← 本地预检，不改任何东西
2. 授权    ← 验证 GitHub token
3. 建仓    ← git init + commit + 创建 GitHub 仓库 + push
4. 上架    ← fork 插件市场 → 加一个 YAML → 提 PR
```

四步都有进度反馈，**失败会明确告诉你卡在哪一步、已经完成了什么**。

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
| 包名全小写（npm 拒绝大写） | ❌ 错误 |
| 版本号是合法 semver | ❌ 错误 |
| `keywords` 含 `dsh-plugin` | ❌ 错误 |
| 入口文件存在（占位仓库不收） | ❌ 错误 |
| owner / repo 名合法 | ❌ 错误 |
| 分类是官方 23 个取值之一 | ❌ 错误 |
| 英文描述以句号结尾 | ❌ 错误 |
| 描述里没有营销词 | ⚠️ 警告 |
| 描述里声称了具体数量（会被核对） | ⚠️ 警告 |
| 有 LICENSE 文件 | ⚠️ 警告 |
| 有 README / `.gitignore` | ⚠️ 警告 |
| 根目录有超大文件 | ⚠️ 警告 |

**错误会阻止发布，警告不会。** 这样你在本地就知道问题，而不是在维护者的 PR
评论里。

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

## 已知限制

- **必须重启 DSH**：新增 bundle 需要重启才加载。宿主半的改动同理
  （本 profile 的 HMR 默认不监听任何模块根目录）。
- **仓库创建满 1 天**才能被收录——这是市场的规定，插件无法绕过。
  刚建的仓库提 PR 会被 CI 拒。
- **需要手动加 `dsh-plugin` topic**：仓库页面 → ⚙️ About → Topics。
  预检只能检查 `keywords` 里有没有这个词，无法替你操作 GitHub 页面。
- **fork 可能过期**：如果你之前 fork 过插件市场，它可能落后于上游。
  提交时若检测到脏工作树会拒绝，此时删除旧 fork 再重试。
- **不能发 npm**：本插件只做 GitHub 发布 + 市场收录。
  发布到 npm 是另一条独立的路（市场收录不依赖它）。

---

## 架构

| 文件 | 职责 |
|---|---|
| `lib/preflight.js` | 收录要求校验 + 生成投稿 YAML |
| `lib/github.js` | GitHub REST 调用（4 个端点） |
| `lib/git.js` | 通过 `ctx.subprocess` 跑 git |
| `lib/publish.js` | 编排整个流程 |
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
node tools/publisher-preflight.test.mjs   # 收录要求逐条校验（35 项）
node tools/publisher-publish.test.mjs     # 发布流程：顺序、失败、脱敏（45 项）
node tools/publisher-eval.test.mjs        # 两端模块求值 + 路由守门（38 项）
```

**118 项。** 覆盖的关键行为：

- 预检对**真实可发布插件**通过、对**故意做坏的包**报出每一条错误
- 发布流程的**顺序**（预检 → token → 本地提交 → 建仓 → push → 提 PR）
- **失败语义**：坏 token 不建仓库；预检失败不碰 GitHub；
  push 失败仍报告已建仓库；仅提 PR 失败时发布仍算成功
- **token 不泄漏**：不出现在结果里、不出现在步骤详情里、错误信息被脱敏
- **脏 fork 拒绝提交**
- 每条路由都拒绝非本机来源和非 POST 方法
