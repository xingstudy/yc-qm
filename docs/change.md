# 生产版本变更记录

记录 `xingstudy/yc-qm` 各生产版本的主要变化，按版本倒序排列。发布状态以
[GitHub Releases](https://github.com/xingstudy/yc-qm/releases) 和对应生产发布工作流为准；
镜像 digest、部署文件及校验签名以各 Release 附件为准。

## prod-v1.2.0 — 2026-09-08

- 发布提交：`620f26e9fcfa6af63bbc039d1de3394f5794547d`。
- 支持从 Git 项目和压缩包导入技能，并保留图片等二进制资源。
- Claude、Codex 原生运行时支持自定义模型供应商，模型选择与供应商配置保持一致。
- 修复自定义模型与内置模型同名时的选择问题，统一 Anthropic 地址处理，并在密钥验证时拒绝网站 HTML 响应。
- 相比 `prod-v1.1.0`，生产 Compose、环境配置模板和部署脚本没有变化。
- 8 个生产镜像已完成构建、漏洞扫描、签名和版本发布，9 个 Release 附件已通过工作流校验。
- [Release](https://github.com/xingstudy/yc-qm/releases/tag/prod-v1.2.0) ·
  [发布工作流](https://github.com/xingstudy/yc-qm/actions/runs/34216805033) ·
  [代码差异](https://github.com/xingstudy/yc-qm/compare/prod-v1.1.0...prod-v1.2.0)

## 历史已发布版本

日期采用 GitHub Release 的 UTC 发布日期。变更摘要依据 Release 说明及相邻已发布 tag 的提交记录整理。

| 版本                                                                       | 发布日期   | 主要变化                                                                                                        | 完整差异                                                                                          |
| -------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [prod-v1.1.0](https://github.com/xingstudy/yc-qm/releases/tag/prod-v1.1.0) | 2026-09-07 | 修复失效 OpenCode 运行时替换；完善企业微信网页与跨浏览器登录；修复沙箱网络生命周期；精简开发指引。              | [prod-v1.0.0 → prod-v1.1.0](https://github.com/xingstudy/yc-qm/compare/prod-v1.0.0...prod-v1.1.0) |
| [prod-v1.0.0](https://github.com/xingstudy/yc-qm/releases/tag/prod-v1.0.0) | 2026-09-04 | 修复定时任务 Worklog 对话链接访问，并修复相关 CI、依赖与构建问题。                                              | [prod-v0.9.3 → prod-v1.0.0](https://github.com/xingstudy/yc-qm/compare/prod-v0.9.3...prod-v1.0.0) |
| [prod-v0.9.3](https://github.com/xingstudy/yc-qm/releases/tag/prod-v0.9.3) | 2026-09-03 | 对齐生产回调地址和密钥校验。                                                                                    | [prod-v0.9.2 → prod-v0.9.3](https://github.com/xingstudy/yc-qm/compare/prod-v0.9.2...prod-v0.9.3) |
| [prod-v0.9.2](https://github.com/xingstudy/yc-qm/releases/tag/prod-v0.9.2) | 2026-09-02 | 修复 Web UI IM 凭据密钥传递；新增企业微信扫码登录、租户信息与账号关联；完善组织成员管理；修复生产镜像扫描失败。 | [prod-v0.9.0 → prod-v0.9.2](https://github.com/xingstudy/yc-qm/compare/prod-v0.9.0...prod-v0.9.2) |
| [prod-v0.9.0](https://github.com/xingstudy/yc-qm/releases/tag/prod-v0.9.0) | 2026-08-25 | 新增企业微信机器人接入及 Web UI IM 绑定管理。                                                                   | [prod-v0.8.1 → prod-v0.9.0](https://github.com/xingstudy/yc-qm/compare/prod-v0.8.1...prod-v0.9.0) |
| [prod-v0.8.1](https://github.com/xingstudy/yc-qm/releases/tag/prod-v0.8.1) | 2026-08-25 | 修复 Docker 部署路由和沙箱基础镜像 tar 漏洞；限制 Agent 对 keychain 元数据的访问。                              | [prod-v0.8.0 → prod-v0.8.1](https://github.com/xingstudy/yc-qm/compare/prod-v0.8.0...prod-v0.8.1) |
| [prod-v0.8.0](https://github.com/xingstudy/yc-qm/releases/tag/prod-v0.8.0) | 2026-08-21 | 完善 Web UI、管理界面和运行时中文化；集成依赖更新，修补镜像中的 GitHub CLI 并调整 Nginx。                       | [prod-v0.7.4 → prod-v0.8.0](https://github.com/xingstudy/yc-qm/compare/prod-v0.7.4...prod-v0.8.0) |
| [prod-v0.7.4](https://github.com/xingstudy/yc-qm/releases/tag/prod-v0.7.4) | 2026-08-15 | 修复密钥校验时内置数据库连接地址的派生。                                                                        | [prod-v0.7.3 → prod-v0.7.4](https://github.com/xingstudy/yc-qm/compare/prod-v0.7.3...prod-v0.7.4) |
| [prod-v0.7.3](https://github.com/xingstudy/yc-qm/releases/tag/prod-v0.7.3) | 2026-08-15 | 支持灵活的生产数据库拓扑。                                                                                      | [prod-v0.7.2 → prod-v0.7.3](https://github.com/xingstudy/yc-qm/compare/prod-v0.7.2...prod-v0.7.3) |
| [prod-v0.7.2](https://github.com/xingstudy/yc-qm/releases/tag/prod-v0.7.2) | 2026-08-14 | 简化带签名校验的生产部署，补充校验和工具声明。                                                                  | [prod-v0.7.1 → prod-v0.7.2](https://github.com/xingstudy/yc-qm/compare/prod-v0.7.1...prod-v0.7.2) |
| [prod-v0.7.1](https://github.com/xingstudy/yc-qm/releases/tag/prod-v0.7.1) | 2026-08-14 | 修复不存在的生产 tag 检测、跨浏览器 magic-link 登录和镜像签名延迟；更新存在漏洞的生产镜像并恢复 Portal CI。     | [v0.6.0 → prod-v0.7.1](https://github.com/xingstudy/yc-qm/compare/v0.6.0...prod-v0.7.1)           |

## 仅存在 tag 的版本

截至 2026-09-08，仓库还存在 `prod-v0.9.1`、`prod-v1.0.1`，但没有对应的 GitHub Release。
仅有 Git tag 不能证明生产镜像和部署附件已完整发布，因此不列入上面的已发布版本。

## 维护方式

发布前新增版本条目，记录候选提交、相对上一已发布版本的变化和发布工作流链接。
工作流成功且 tag、镜像清单、部署附件校验完成后，填写发布日期与 Release 链接。
失败的发布保留实际状态；发布流程和恢复方式见 [Docker Compose 运维文档](./docker-compose.md)。
