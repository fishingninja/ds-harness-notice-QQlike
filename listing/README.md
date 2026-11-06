# 上架到插件市场（awesome-dsh-plugin）

DSH 的「插件市场」由社区目录 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 驱动。
市场客户端只允许安装该目录里列出的插件 —— 这是它的安全模型，不是可选项。

所以「让其他人也能看到、下载、使用」的路径是：**向那个目录仓库提一个 PR**。

## 已提交的 PR

**[#12749](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12749)** —
只改一个文件，`mergeable: true`。

## 收录门槛

| 要求 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle`（不是只有 `dsh.client`） | ✅ `packages/dsh-desktop-alerts/package.json` |
| 旁边有 `cordis.patch.yml` | ✅ |
| 真实可用的代码，非占位仓库 | ✅ |
| 仓库带 `dsh-plugin` topic | ✅ 已设置 |
| 描述只讲功能、不夸大 | ✅ |
| 仓库创建满 **1 天** | ⏳ 仓库建于 2026-11-06 15:15 UTC，约 2026-11-07 15:15 UTC 达标 |

年龄这一项由 CI 自动检查。关键在于：**它只会让 PR 暂时变红，不会让 PR 被关掉**。
目录方的 workflow 每 6 小时自动重跑一次这条检查（`regate.yml`），达标后自己就变绿。
所以不需要重新提交、不需要空 commit、更不要关掉重开 —— 让 PR 开着就行。

## 提交方式

往 `awesome-dsh-plugin/awesome-dsh-plugin` 提一个 PR，**只加一个文件**：

```
data/plugins/fishingninja__ds-harness-notice-QQlike--packages-dsh-desktop-alerts.yml
```

内容就是本目录下的 `catalog-entry.yml`（提交时会去掉开头那几行注释）。
文件名由目录方的 `slugFor()` 从 `url` 推导，规则是
`<owner>__<repo>--<子包路径，斜杠换成连字符>`。

不要手工改那两个 README —— 它们由 `data/plugins/*.yml` 自动生成。

条目已用目录方自己的 `validateEntries()` 在本地跑过，0 问题；
CI 侧的 `Entry files live in data/plugins/`、`READMEs match data/plugins`、
`awesome-lint` 等步骤也已通过。

## 各字段的依据

- `url` 指向子目录。目录方明确支持 monorepo 子包，写法是
  `https://github.com/owner/repo/tree/main/packages/my-plugin`
- `name` 用 `owner/repo#subname`，`#` 后是子包名
- `category: notify` —— 目录里已有 317 个条目在这个分类，语义吻合
- `icon` 是 GitHub 托管的 192×192 PNG。目录要求位图，不接受 SVG
- 描述里写的每一句都能在代码里找到对应实现，没有数字或 API 名称需要额外核对

## 合并之后

条目合入后，目录会重新生成并发布到 `https://awesome-dsh-plugin.com/plugins.json`。
插件市场客户端下次拉取目录时就能看到它，用户可以直接搜索、安装、更新。

此时 `market/index.json` 这套自建索引源仍然有效，两者不冲突：
自建索引供人手动添加索引源，官方目录供市场内置搜索。
