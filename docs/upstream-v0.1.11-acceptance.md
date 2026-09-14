# v0.1.11 上游集成：二开验收清单

## 范围与状态

本清单定义 `xingstudy/yc-qm` 吸收上游 v0.1.11 时必须保留的下游行为，以及升级新接口所需的验证。当前阶段是验收设计与独立审查，不代表业务测试、数据库升级或生产发布已经通过。

| 基线     | 固定值                                                    |
| -------- | --------------------------------------------------------- |
| 下游来源 | `origin/main`，`bd1cb20411a69ff7badd95da4d482961b07d4b7b` |
| 上游目标 | `v0.1.11`，`51bf455ea414a58f70274284ce212142518e556a`     |
| 共同祖先 | `v0.1.5`，`d931fe963de3ac20b9a7526ea9a4873c0d8ed18e`      |
| 调研日期 | 2026-09-14                                                |
| 工作分支 | `codex/sync-upstream-v0.1.11`                             |
| 当前交付 | 二开契约、验收步骤、测试入口、缺口和分阶段门槛            |

基于固定提交，双方分别修改 573 / 1,190 个文件，共同修改 298 个文件；`git merge-tree --write-tree --name-only` 预演得到 169 个内容冲突文件。无文本冲突不代表无接口、数据或权限风险。这里使用 Git merge 保留历史，不 rebase 下游已发布历史；同步固定 tag，不自动追随上游 main。

本清单依据当前代码和测试整理。历史 PRD、计划与历史验证只用于发现需要复查的领域，不能作为当前已实现或已通过的证据。清单中的路径指向本次下游基线；上游重命名时更新映射，不删除相应验收要求。

## 状态、责任与证据规则

- `P0`：数据、凭据、权限、核心执行或生产回滚契约。失败或缺证据时不得批准受影响的上线范围。
- `P1`：已交付功能的兼容性和可见行为。首批启用该功能前必须通过；明确延期的上游新功能须保留关闭配置和独立启用门槛。
- `已有入口`：已找到相关测试文件，不承诺文件覆盖本行所有断言，更不表示本次运行成功。
- 每行初始执行状态均为 `待执行`。每行的每个独立输入/操作/断言必须拆为稳定子 ID（例如 `MOD-02a`），单独写结果；全部 required 子项通过后该行才通过，禁止以一个成功场景签署整行。执行时记录 `通过 / 失败 / 环境阻塞 / 不适用`，不得将跳过记为通过。`不适用` 必须写明未启用的后端或功能及证据，不能用于绕过仍在使用的二开能力。
- 每次结果绑定候选 SHA、用例 ID、环境、夹具版本、完整命令、实际执行数、失败/跳过数、日志或截图路径、执行人和审查人。测试存在、mock 通过、源码正则断言、真实模型调用分别记录。首批启用范围的 P0/P1 环境阻塞仍阻断上线；PG 必测用例须记录实际运行且 0 skip，缺少 DATABASE_URL 的自动 skip 不是通过。
- 实现者负责补覆盖与执行；独立审查者核对反例、调用者、迁移和证据；发布者核对镜像、配置、备份和回滚。没有填写的结果一律保持待执行。

结果记录模板：

| 用例 ID      | 候选 SHA | 环境/夹具 | 命令或页面操作 | 实际断言与计数 | 证据位置 | 执行状态 | 执行/审查人 |
| ------------ | -------- | --------- | -------------- | -------------- | -------- | -------- | ----------- |
| 示例：ORG-01 | 待填写   | 待填写    | 待填写         | 待填写         | 待填写   | 待执行   | 待填写      |

## 已确认的验收环境

用户于 2026-09-14 确认当前生产部署为 `prod-v1.3.0`，并确认企业微信测试租户、Bot/测试用户与模型供应商测试配置已具备。当前只记录资源可用，不表示已读取密钥、完成连接或验证业务；后续在受控环境使用这些资源，凭据不进入本清单。已从 origin 拉取并核对 tag，实际提交为 `bd1cb20411a69ff7badd95da4d482961b07d4b7b`，与本清单下游基线相同。[生产 Release](https://github.com/xingstudy/yc-qm/releases/tag/prod-v1.3.0) 发布于 2026-09-10，当前列出 9 个附件；附件存在不替代后续签名/内容校验。

## 共用验收夹具

1. 在共享 store 层测试组织 A/B 隔离，在应用层使用两个分别配置单组织的测试实例，不假定一个 runtime 自动服务多组织；A 中设置组织管理员、部门管理员、普通成员、受邀未激活成员、停用成员、离职成员和外部访客。组织 A 创建三级部门、兄弟部门、两个访问组，以及同时属于多个组的成员。
2. 每种身份建立个人会话、多人会话、共享环境和受限资源；准备有效、过期、旧 session version、伪造来源的凭证。记录原始 principal ID 和资源归属，防止升级通过新建账号掩盖身份丢失。
3. 主夹具由已核实 `prod-v1.3.0@bd1cb20` 旧二进制在专用测试库生成该版本实际存在的表、密文、组织树、目录映射、审计、技能授权、IM 绑定、待交付消息、cron fireLog 和存量 sandbox 元数据；辅助回归夹具来自 origin/main（本次恰为同 SHA），损坏闭包/缺投影/旧 secret/重复 JIT 等单独归为合成负例，不推断真实部署已损坏。停止旧进程并备份后，恢复到升级测试库。禁止指向生产 DB；不把生产明文密钥或身份数据写入仓库。
4. 准备两个自定义供应商，提供同名模型；其中一个模型与内置 ID 同名。分别设置 Chat Completions、Responses、Messages 协议夹具、缺失/失效凭据。真实验证使用独立测试供应商账号与测试会话，记录实际请求端点和模型 ID，隐藏密钥。
5. 准备有文本与二进制文件的 Git/ZIP/tar.gz 技能、路径穿越和越界链接样本、同名技能、已有授权及陈旧预览。准备带标记文件的 sandbox 工作卷、活动进程、休眠容器和已删除网络。
6. 准备独立 Docker 项目、卷和 egress 代理；允许域名、拒绝域名、可控私网服务、多地址 DNS、不可达代理。真实企业微信/IM/邮件测试仅使用专用测试身份和收件人；未配置时记录环境阻塞，不向真实业务联系人发送测试消息。

7. 同组织准备两个 Core/worker、两个 Auth/Portal、两个 Web UI，共用专用 PG；测试框架可控制 lease、进程 kill 点、provider 延迟及 DB 故障。另一组织使用独立应用配置，按 store 隔离测试目的决定是否共享测试 PG。数据库备份与 Docker 容器/网络/卷状态分别版本化，恢复 DB 不会自动重建原 network ID。

旧库来源必须绑定实际部署过的下游 SHA、schema 和可复现的合成/脱敏数据。v0.1.5 是共同祖先，不代表当前生产版本，也不包含后来新增的全部组织/目录表。主路径测试当前已部署版本 → 候选；若仍支持更老部署，再补相应版本 → 候选矩阵，不能凭版本名称构造不存在的旧数据格式。真实生产密文 canary 若有必要，只读且单独授权，在受控环境执行，不复制生产密钥到开发夹具。

## A. 组织身份、成员与治理

实现：[组织服务](../src/organization/organization-service.ts)、[Portal actor](../src/api/portal-actor.ts)、[目录可见性](../src/authorization/directory-visibility.ts)、[治理配置](../src/resolution/config-store.ts)。

| ID / 等级   | 前置数据与操作                                                                                            | 必须观察到的结果                                                                                                                                         | 已有入口 / 尚需证据                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ORG-01 / P0 | 邀请、首次登录、重复登录；分别提交已验证/未验证企业邮箱与未知 directory issuer                            | 允许的邀请/已验证域入驻绑定同一 canonical principal；未验证邮箱、未知来源拒绝；不凭相同邮箱合并已绑定冲突身份                                            | [组织服务](../test/organization-service.test.ts)、[组织路由](../test/organization-routes.test.ts)                                                                             |
| ORG-02 / P0 | 停用、离职、重新激活成员，用旧 cookie/capability/sessionVersion 访问并发起 turn                           | 停用/离职拒绝；重新激活不恢复旧 capability；Portal 与 Core 使用一致的新 version；登录竞争不把被停用用户恢复 active                                       | [organization gate](../test/organization-gate.test.ts)、[组织 PG](../test/postgres-organization-store.test.ts)；真实双实例下一轮验证                                          |
| ORG-03 / P0 | 部门管理员访问自身三级子树与兄弟部门；组管理员访问自己/其他组；非管理员直接调用治理 API                   | 子树/组权限边界保持；未授权 API 返回拒绝；前端隐藏控件不能替代服务端检查；伪造 Portal header 或 impersonation 不继承管理员 version                       | [组织路由](../test/organization-routes.test.ts)、[organization gate](../test/organization-gate.test.ts)                                                                       |
| ORG-04 / P0 | 创建、移动、归档部门，批量增删成员，更新访问组；制造 revision 竞争、成环和重复请求                        | 闭包关系一致；非法树结构拒绝；CAS 冲突不覆盖他人更新；重试幂等；归档不留下可访问的活动治理范围                                                           | [组织服务](../test/organization-service.test.ts)、[组织 PG](../test/postgres-organization-store.test.ts)、[成员批处理](../test/organization-member-batch.test.ts)             |
| ORG-05 / P0 | 两名管理员并发 suspend/deprovision 对方，或移除最后 active 管理员资格                                     | 保留至少一个有效管理员；变更和审计事务一致，不因两实例并发同时失去管理入口                                                                               | [组织路由](../test/organization-routes.test.ts)、[组织 PG](../test/postgres-organization-store.test.ts)；专用 PG 并发                                                         |
| ORG-06 / P0 | 配置组织、祖先部门、多访问组、个人目录可见范围；引用归档/不存在的根；再撤权                               | 个人目录策略覆盖继承；否则祖先部门/访问组 limited roots 合并，任一 all 或无策略时为 all；无有效根为 none；跨组织不可泄露，目录可见不自动授予资源执行权限 | [目录可见性](../test/directory-visibility.test.ts)、[组织路由](../test/organization-routes.test.ts)、[技能访问](../test/skill-access.test.ts)                                 |
| ORG-07 / P1 | 管理页从组织切换到一级/三级部门、访问组，编辑继承值、清除覆盖、刷新并在第二实例读取                       | 选择器切换真实 scope，显示 own/effective 值且修改正确对象；不是只改变标题；普通用户页面和实际 turn 采用同一有效配置                                      | [Admin governance](../plugins/admin/test/governance-scope.test.ts)、[governance runtime](../test/governance-runtime-api.test.ts)；需实际 Portal 页面与 turn                   |
| ORG-08 / P0 | 恢复来源部署真实格式的组织数据，另加载缺投影、坏闭包、旧 version、冲突邮箱/重复 JIT 的合成负例，再升级    | 保留原 ID/资源归属，version 不回退；异常映射有预检报告，禁止静默选择错误 principal；已存在投影/关系迁移幂等                                              | [组织 PG](../test/postgres-organization-store.test.ts)、[identity](../test/identity.test.ts)；新库 fixture 不等于旧部署演练                                                   |
| ORG-09 / P0 | CSV 预览/批量成员操作中含有效、重复、错误及无权限成员；中途重启 worker并重复提交                          | 预览/执行结果一致且无越权；逐项结果、审计、任务进度持久化；重复处理不产生重复成员/错误权限                                                               | [member CSV](../test/organization-member-csv.test.ts)、[member batch](../test/organization-member-batch.test.ts)、[member jobs PG](../test/postgres-member-job-store.test.ts) |
| GOV-01 / P0 | 祖先设 strict/禁止 deploy，个人设 dangerous/允许 deploy；两个访问组分别限制命令与审批持久授权             | 子级不放宽祖先；各组 allowlist 交集，禁止优先，需要审批不变成允许；session/always 授权选项分别取更严格值                                                 | [governance inheritance](../test/governance-inheritance.test.ts)；实际工具执行/审批拒绝路径                                                                                   |
| GOV-02 / P0 | 组织 browse steps=50、部门=20、个人=100；turn wall clock 600/120/个人0；设置并清除 Fast mode/browse model | steps=20、wall clock=120，0 不绕过继承上限；Fast mode/browse model 按最近有效覆盖；移组后恢复剩余限制                                                    | [governance inheritance](../test/governance-inheritance.test.ts)、[governance runtime API](../test/governance-runtime-api.test.ts)；候选实际 turn 限额                        |
| GOV-03 / P0 | 部门/访问组编写私有 instructions；分别个人会话和包含其他成员的多人会话执行，再撤销关系                    | 个人 turn 获得有权读取的指令，成员变更后移除；多人会话不泄露仅一人所属组的私有指令，安全限制仍生效；跨实例刷新                                           | [governance turn](../test/governance-turn.test.ts)、[governance inheritance](../test/governance-inheritance.test.ts)；真实 harness 输入脱敏核验                               |

## B. 企业微信、Portal 与目录

实现：[目录同步](../src/directory-sources/directory-sync-engine.ts)、[账号关联](../src/directory-sources/identity-linking-service.ts)、[托管目录](../src/directory-sources/managed-directory-service.ts)、[Auth](../plugins/auth/src/server.ts)、[Portal](../plugins/portal/src/index.ts)、[登录事务](../src/auth/portal-login-transactions.ts)。

| ID / 等级    | 前置数据与操作                                                                                                | 必须观察到的结果                                                                                                                                                                       | 已有入口 / 尚需证据                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DIR-01 / P0  | 新来源先 preview 再启用/同步，做后续全量与重复同步；手工修改部门/profile/admin 关系                           | preview 只读；托管同步不覆盖手工所有权；完整 snapshot、映射与幂等结果保持                                                                                                              | [directory sources](../test/directory-sources.test.ts)、[目录 PG](../test/postgres-directory-source-store.test.ts)                                                           |
| DIR-02 / P0  | 模拟分页循环、超 100,000 成员、异常响应/中途断网；同步期间轮换来源凭据或修改配置                              | 不用部分数据替换有效 snapshot；配置/revision 变化标记 stale；保留可诊断失败原因，旧快照使用遵守当前来源状态                                                                            | [directory sources](../test/directory-sources.test.ts)；大规模边界与真实失败需补证据                                                                                         |
| DIR-03 / P0  | 两 worker 同步同一来源，lease丢失后旧 worker完成；a：管理 API pause/delete 与登录并发；b：绕过 API 改来源状态 | 仅当前 owner提交；a 在来源锁/revision fence 下完成会话失效，API成功后旧 session拒绝；b 后台扫描最终收敛，默认30秒周期；受控健康测试≤两个周期+1秒处理余量，故障时不承诺该上限并记录恢复 | [目录 PG](../test/postgres-directory-source-store.test.ts)、[directory sources](../test/directory-sources.test.ts)；两个路径分开验证                                         |
| DIR-04 / P0  | 同一验证邮箱来自多个来源；同来源不同 subject；实时邮箱与 snapshot 不同、验证消失、多个 principal 证据冲突     | 合法证据关联 canonical 用户；不在当前快照、未验证/冲突证据拒绝，不因重新登录创建重复账号绕过冲突                                                                                       | [directory sources](../test/directory-sources.test.ts)、[directory routes](../test/directory-source-routes.test.ts)                                                          |
| DIR-05 / P0  | preview 后改组织 revision/成员指纹；pause 后使用同租户凭据恢复；尝试改变租户；恢复旧 `secret` 行              | 陈旧 reconcile 拒绝；恢复不自动启用写入，须重新 preview；租户不可静默替换；旧 application secret、source ID/tombstone/绑定保持                                                         | [directory sources](../test/directory-sources.test.ts)、[目录 PG](../test/postgres-directory-source-store.test.ts)；旧数据回放                                               |
| DIR-06 / P0  | 两实例分别持有 env/admin 来源配置；触发来源接管与自动恢复被来源停用的成员                                     | 不混用本实例 secret 和另实例 public config；仅在 source-owned suspension/version 仍匹配时恢复，保留管理员后续停用决定                                                                  | [directory sources](../test/directory-sources.test.ts)；蓝绿进程联测                                                                                                         |
| DIR-07 / P1  | 触发 failed/stale/circuit-open 同步和需要人工处理的关联冲突，在管理页查询                                     | 可见来源、run 状态、影响数量及脱敏错误；不会把异常报为同步成功；告警能力若不存在按缺口记录，不宣称已交付                                                                               | [directory routes](../test/directory-source-routes.test.ts)；需运行证据，告警新增属于独立范围                                                                                |
| AUTH-01 / P0 | 普通 Chrome、企业微信内置浏览器、Chrome 发起但回调落在企业微信三条路径分别登录                                | 返回原浏览器并完成其原 Portal transaction；Core 返回的 canonical principal/sessionVersion 建立 session；临时 cookie、bridge 前缀与 query 完整                                          | [Auth flow](../plugins/auth/test/flow.test.ts)、[Portal router](../plugins/portal/test/router.test.ts)；真实域名/代理/客户端必验                                             |
| AUTH-02 / P0 | 已绑定无邮箱用户登录；未绑定用户经 profile authorization 关联；用户拒绝授权                                   | 已绑定合法身份不强求新增 profile；未绑定只在所需证据齐备后关联；拒绝授权不建立 session或修改已有账号                                                                                   | [Auth flow](../plugins/auth/test/flow.test.ts)、[directory sources](../test/directory-sources.test.ts)                                                                       |
| AUTH-03 / P0 | 篡改 state、PKCE、nonce、ID token/userinfo、回调目标；关闭 Core；外部授权后 pause 来源再走 Core login         | 每一异常 fail closed，不写有效 session；Core 不可用不能以本地猜测身份放行；不泄露响应中的 token                                                                                        | [Auth flow](../plugins/auth/test/flow.test.ts)、[Portal OIDC](../plugins/portal/test/oidc.test.ts)、[Portal router](../plugins/portal/test/router.test.ts)                   |
| AUTH-04 / P0 | 两浏览器/实例争抢同一 handoff；已登录另一账号尝试消费；claim 后终止进程再重试                                 | 只一次消费；不同账号拒绝；已 claim 结果不可回放，崩溃后安全重新发起完整登录，不承诺自动恢复旧 claim                                                                                    | [登录事务](../test/portal-login-transactions.test.ts)、[登录 PG](../test/postgres-portal-login-transactions.test.ts)、[Portal router](../plugins/portal/test/router.test.ts) |
| AUTH-05 / P0 | 升级时保留已有 session、临时 cookie、未消费交易；并发触发速率限制；登出及撤销记住登录                         | 兼容或按明确到期策略重新登录；失效 session 不复活；共享交易/限流不因换实例绕过；新增 broker session与现有停用机制一致                                                                  | [Auth flow](../plugins/auth/test/flow.test.ts)、[登录 PG](../test/postgres-portal-login-transactions.test.ts)；新旧格式及上游 remembered-session 联测                        |

## C. 模型与运行时

实现：[自定义供应商](../src/model/custom-providers.ts)、[原生目标](../src/model/native-provider-target.ts)、[模型可用性](../src/model/pi-models.ts)、[配置继承](../src/resolution/config-store.ts)、[请求入口](../src/api/app-turn.ts)。

| ID / 等级   | 前置数据与操作                                                                                                            | 必须观察到的结果                                                                                                                                                                 | 已有入口 / 尚需证据                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MOD-01 / P0 | 两供应商配置同名模型，另配置与内置同名及 ID 含斜杠的模型，逐项选择并发送                                                  | picker 与持久化 runtime 保留 `provider/model`；内置裸 ID 不被劫持；真实请求使用供应商原始 model ID，不误删限定前缀中的有效部分                                                   | [custom providers](../test/custom-providers.test.ts)、[模型目录](../test/model-registry.test.ts)、[Web models](../plugins/web-ui/test/model-options.test.ts)；需真实请求抓取脱敏证据 |
| MOD-02 / P0 | 同名模型分别配置三种协议；按下方协议矩阵切换 harness，分别测支持/不支持组合                                               | 仅按精确协议与已实现 provider 目标决定可用性；兼容且启用组合做真实调用，不兼容组合做确定性拒绝测试                                                                               | [native provider](../test/native-provider.test.ts)、[provider endpoints](../test/provider-endpoints.test.ts)、[服务性](../test/base-model-serviceability.test.ts)                    |
| MOD-03 / P0 | 分别禁用 managed/native key 与删除 custom provider；检查 picker、显式 model 请求、stored scope runtime 三条路径           | managed key 禁用不回退环境 key；无有效模型时 picker/显式发送拒绝；stored scope runtime 删除后的行为按 MOD-08，不把三条路径混为一谈；mock 不出现在生产目录                        | [provider E2E](../test/custom-provider-e2e.test.ts)、[凭据路由](../test/model-credential-route.test.ts)、[Web Pi models](../plugins/web-ui/test/pi-models.test.ts)                   |
| MOD-04 / P0 | 轮换 key 后下一轮请求；并发执行空 key 编辑与轮换；尝试空 key 修改 endpoint/protocol；提交坏 key                           | 逐轮读取最新 key，空 key 不覆盖并发轮换且不能改变连接目标；失败轮换保留旧 key；同毫秒轮换也更新验证指纹                                                                          | [custom providers](../test/custom-providers.test.ts)、[凭据路由](../test/model-credential-route.test.ts)；缺 PG 两实例并发证据                                                       |
| MOD-05 / P0 | 恢复旧 provider 行（无 key、旧 `/v1` URL、一个损坏密文），同时保留健康 provider；重启实例                                 | 无 key 项不可调用；旧 URL 规范化保留有效 key；坏行不拖垮健康供应商，不记录明文；API 仅返回配置与凭据状态                                                                         | [boot wiring](../test/custom-provider-boot-wiring.test.ts)、[provider E2E](../test/custom-provider-e2e.test.ts)；旧库升级与重启联测                                                  |
| MOD-06 / P0 | 三级部门和多访问组配置 harness/model 限制；个人/current scope 设置 runtime；清除覆盖并变更成员关系                        | 限制取交集，空交集拒绝；默认按有效层级解析；清除后恢复继承；成员查询失败拒绝，不能降级成无限制；第二实例下一轮读取更新                                                           | [继承](../test/governance-inheritance.test.ts)、[runtime API](../test/governance-runtime-api.test.ts)、[governance turn](../test/governance-turn.test.ts)                            |
| MOD-07 / P1 | 只重排 allowlist，再单独更改 runtime；跨页、刷新、多面板比较管理员配置与用户 picker                                       | allowlist 顺序不冒充默认；有效 runtime 的 harness/model 与界面选中项一致；保留 provider 标签和限定 ID                                                                            | [Admin scope](../plugins/admin/test/governance-scope.test.ts)、[Web models](../plugins/web-ui/test/model-options.test.ts)；必须浏览器验收                                            |
| MOD-08 / P0 | 保存 runtime 后删除 custom provider；分别让部署 fallback 有效、无凭据、被 scope 禁止，再发起显式指定与未指定 model 的请求 | 保留当前 resolver 对失效 stored selection 使用 deployment fallback 的兼容语义；显式无效请求拒绝，实际 fallback 仍须通过凭据/范围检查；核对页面与实际目标一致，不宣称当前绝不回落 | [runtime selection](../test/runtime-selection.test.ts) 已断言回落；API/页面/无凭据及范围组合需补测                                                                                   |
| MOD-09 / P0 | a：每个启用且兼容的真实模型完成固定工具 schema 的一次调用；b：使用确定性 checkpoint 中断/重启并切换 runtime 续接          | a 记录真实 endpoint/model、工具事件及最终结果；b 独立证明持久化任务/权限/结果续接，不因 a 成功推断 handoff 成功                                                                  | fake upstream 仅证明协议；真实协议 smoke 与上游 durable handoff 分别签署                                                                                                             |

## D. IM 绑定、凭据与交付

实现：[Web IM 服务](../plugins/web-ui/server/index.ts)、[管理视图](../src/admin/im-bindings.ts)、[PG delivery](../src/delivery/postgres-delivery-store.ts)、[CLI 密钥配置](../cli/src/secrets.ts)。

| ID / 等级  | 前置数据与操作                                                                         | 必须观察到的结果                                                                                                                                                              | 已有入口 / 尚需证据                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IM-01 / P0 | 下游旧版本创建密文/绑定，升级、重启和蓝绿切换；以同一兼容 key 做逐条只读解密 canary    | 原绑定无需重新扫码/输入密钥，resource/owner/目标保持；成功率与失败 ID 脱敏记录，不把无法解密伪装成无绑定                                                                      | [IM routes](../plugins/web-ui/test/im-bindings-server-route.test.ts)、[IM config](../plugins/web-ui/test/im-credentials-config.test.ts)；现有 legacy fixture 不替代旧部署密文验证 |
| IM-02 / P0 | 缺失、过短、错误、错误复用根密钥配置；坏密文与健康绑定并存；对比用户和管理页面         | 预检按可检测条件拒绝；错误但格式合法 key 由解密 canary 检出；不启动坏绑定、不泄密；明确两视图差异，禁止上线时静默丢失绑定                                                     | [IM config](../plugins/web-ui/test/im-credentials-config.test.ts)、[production preflight](../test/production-preflight.test.ts)；管理视图不解密的缺口需验证                       |
| IM-03 / P0 | 两用户并发绑定同一微信资源，再单独测试相同企业微信 Bot ID；解绑与 target 更新并发      | 每个资源最多一个 owner；无孤立 owner/可复用旧权限；解绑后可合法重新绑定                                                                                                       | [IM routes](../plugins/web-ui/test/im-bindings-server-route.test.ts)；企业微信竞争与 PG 多实例需补覆盖                                                                            |
| IM-04 / P0 | 两实例同时接管 Bridge lease、终止持有者、重启；轮换 Bot secret 同时发送测试消息        | 只有有效持有者启动对应 runtime，接管后可恢复；不混用凭据版本，去重与持久化聊天目标保持                                                                                        | [IM routes](../plugins/web-ui/test/im-bindings-server-route.test.ts)；非微信 SDK runtime 仍需真实双实例证据                                                                       |
| IM-05 / P0 | 模拟微信 polling `ret=-14`、普通 send `ret=-2`、平台撤销授权/Bot 删除                  | `-14` 清理失效绑定；普通发送错误不当作断连或成功 ack；平台错误状态可诊断，不凭单个 send 错误删除绑定                                                                          | [IM routes](../plugins/web-ui/test/im-bindings-server-route.test.ts)；真实平台撤销路径待测                                                                                        |
| IM-06 / P0 | 重放入站、重复投递、locator 永久失败、发送成功但 ack 前崩溃、claim 到期后重试          | 检查实际幂等键/claim/ack，不丢弃未成功交付；locator 永久失败在成功持久化 ack 后不再重领，ack 前崩溃仍按租约重试；记录 ack 崩溃窗口的实际可保证程度，不宣称端到端 exactly-once | [IM routes](../plugins/web-ui/test/im-bindings-server-route.test.ts)、[delivery PG](../test/postgres-delivery-store.test.ts)；平台幂等能力和崩溃窗口需实测                        |
| IM-07 / P0 | 用户 suspended/deprovisioned/移出授权后，观察仍运行的轮询/SDK Bridge，并尝试接收及投递 | 必须核对 Bridge 生命周期与权限撤销是否联动；Core 拒绝 turn 不等于停止收信；待验证的基线疑点见 GAP-02，未解决不得把已启用 IM 的离职闭环标为通过                                | 目前未找到明确覆盖；需状态订阅/轮询/lease 的实现检查与回归                                                                                                                        |
| IM-08 / P1 | 普通发送持续失败超过数个 claim 周期，观察任务、绑定与管理日志                          | 记录当前普通失败可无限重试的边界；45 秒 claim 不是次数上限；只要求行为不退化及可诊断，新增次数上限/死信作为独立决策                                                           | [delivery PG](../test/postgres-delivery-store.test.ts)、[IM routes](../plugins/web-ui/test/im-bindings-server-route.test.ts)；不能把上游 run backoff 算作本项完成                 |

## E. 技能、MCP 与资源授权

实现：[上传解析](../src/skills/skill-upload.ts)、[导入接口](../src/api/app-skills.ts)、[物化](../src/skills/materialize.ts)、[共享导入](../plugins/chassis/src/skill-import.ts)、[MCP 工具服务](../src/mcp/mcp-tool-service.ts)。

| ID / 等级   | 前置数据与操作                                                                                                       | 必须观察到的结果                                                                                                                                           | 已有入口 / 尚需证据                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SKL-01 / P1 | 从 HTTPS Git、ZIP、tar.gz/tgz/tar、Markdown 导入；预览后只选择部分技能确认                                           | 预览无持久化写入；只导入选择项；源与选择项仍与 fingerprint 一致；重启后可用                                                                                | [skill upload](../test/skill-upload.test.ts)、[skills HTTP](../test/skills-http.test.ts)、[导入 UI](../plugins/web-ui/test/skill-import-form.test.ts)；需完整浏览器路径      |
| SKL-02 / P0 | PNG/文本/标记 executable 的脚本分别走 batch extract 与逐文件 fallback，stat 后实际执行                               | bytes/文本无损；manifest 执行位已保存，但基线物化未保留 mode，见 GAP-13；补齐后两路径均须在真实 sandbox 证明 mode 与执行结果                               | [文件编码](../test/skill-file-encoding.test.ts)、[物化](../test/skills-materialize.test.ts)、[bundle](../test/skill-bundle.test.ts)；现有 executable fixture 未断言落盘 mode |
| SKL-03 / P0 | 上传越界路径、绝对路径、重复路径、符号/硬链接、特殊文件、加密/损坏 ZIP、超大展开与非法 base64                        | 按当前大小/数量边界拒绝；不写出目标目录、不留下部分技能；错误不回显敏感源内容                                                                              | [archive](../test/skill-archive.test.ts)、[upload](../test/skill-upload.test.ts)；当前限制 8 MiB 上传、5,000 项、32 MiB 展开，合并时核对所有入口一致                         |
| SKL-04 / P0 | 陈旧 fingerprint、名称碰撞、第二项创建失败；首项创建后 kill；补偿 delete 失败；两个 PG 进程并发 confirm              | 常规异常补偿按已有契约；崩溃原子性基线未保证，GAP-14 定义 pending journal/隔离与恢复方案；并发确认只能一个发布，恢复后无可见半成品                         | [skills HTTP](../test/skills-http.test.ts) 仅部分覆盖；kill/delete-failure/PG 两进程需补测                                                                                   |
| SKL-05 / P0 | a：未授权用户/伪造 body actor/shared trigger 在入口发起导入；b：延迟 fetch 时撤销 shared scope 管理权                | a 在 HTTP 入口拒绝且 fetch count=0；b 已开始读取可以结束，锁内复核拒绝，skill/bundle/成功审计写入均为0；直接内部调用者也单列检查                           | [skills HTTP](../test/skills-http.test.ts) 已覆盖入口先授权；GAP-01 为撤权窗口覆盖缺口                                                                                       |
| SKL-06 / P0 | 分别创建 uploaded 固定快照 pack 与 tracked Git pack；多范围分发、取消选择、归档、sync/reconcile 和并发物化           | uploaded 保持固定内容；tracked Git 按既有 sync 更新 imported skills；某范围取消/归档不影响别处；PG 持久化，常规响应不泄露上传内容                          | [packs routes](../test/skill-packs-routes.test.ts)、[pack store](../test/skill-pack-store.test.ts)；按来源分别记录                                                           |
| SKL-07 / P0 | active/inactive 成员与撤权成员分别调用 list/detail/resolve/materialize/execute/import 六入口，并测试环境绑定         | 每入口独立记录授权结果；目录可见不等于技能授权；不可用成员/撤权用户不能借直链、环境或执行路径获得技能内容                                                  | [技能访问](../test/skill-access.test.ts)、[技能可见](../test/skills-visible.test.ts)、[autoload](../test/skill-grant-autoload.test.ts)                                       |
| MCP-01 / P0 | 正常 JSON/官方 stateful Streamable HTTP 发现与调用；更新/禁用 server 后复用旧 capability；健康与挂起 server 混合启动 | 健康调用成功；初次 hydration 有预算；注册更新/禁用后旧工具能力失效；HTTPS/SSRF、密文、错误脱敏及重试预算分别由 MCP-02/03/04 验收                           | [MCP connectors](../test/mcp-connectors.test.ts)、[依赖安全](../test/pi-dependency-security.test.ts)                                                                         |
| MCP-02 / P0 | 并发调用遇到 401/会话过期、短期 token、SSE 中断、迟到旧会话响应；随后禁用/关闭服务                                   | 初始化与 token 刷新 single-flight，重试有界；SSE 恢复不重复执行工具；旧响应不替换新会话；关闭中止请求并清理会话                                            | [MCP connectors](../test/mcp-connectors.test.ts) 中 concurrent callers、SSE resume、stale session、close 用例                                                                |
| MCP-03 / P0 | 带凭据的 HTTP 地址、重定向、私网/metadata 目标、超大或错误 JSON-RPC/SSE envelope、深层 schema                        | HTTPS/目的地与协议校验拒绝；时间/字节/schema/catalog 预算有界；远端错误内容不进入审计；read-only wake 仅暴露明确只读注解工具，普通 wake 不被错误限制为只读 | [MCP connectors](../test/mcp-connectors.test.ts) 中 HTTPS、redirect、byte limit、schema budget 和 read-only 用例                                                             |
| MCP-04 / P0 | 恢复旧 MCP 密文和一条无法解密记录，启动 registry hydration、删除坏记录，再更新健康 server                            | 旧记录兼容；坏项可隔离/删除，不阻止健康项；ready 等待初次 hydration 且有时限；更新/禁用关闭旧连接                                                          | [MCP connectors](../test/mcp-connectors.test.ts) 中 storage、readiness、server change 用例                                                                                   |

## F. 沙箱、出口策略与工作目录

实现：[local sandbox](../src/sandbox/local-sandbox.ts)、[egress](../src/sandbox/local-egress.ts)、[网络守卫](../src/sandbox/local-network-guard.ts)、[egress 授权](../src/egress-authz-main.ts)、[现有边界文档](./local-docker-egress.md)。

| ID / 等级   | 前置数据与操作                                                                                          | 必须观察到的结果                                                                                                                         | 已有入口 / 尚需证据                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| BOX-01 / P0 | 停止带标记文件的沙箱并删除网络，再复用；另测同名网络存在但 ID 已替换                                    | 修复网络连接后任务可执行，工作目录 bytes/卷身份保留；不误删其他范围容器；同名不同 ID 是独立反例                                          | [local sandbox](../test/local-sandbox.test.ts)；同名替换覆盖不足，需真实 Docker                                                            |
| BOX-02 / P0 | 两请求并发 provision/teardown；park/restart；deep idle 清理；注入 Docker 删除失败                       | 生命周期串行语义保持；清理仅 owned container/guard/network，保留 home；失败可见且可恢复，不伪报成功                                      | [local sandbox](../test/local-sandbox.test.ts)、[dev cleanup](../test/dev-sandbox-cleanup.test.ts)；真实卷校验                             |
| BOX-03 / P0 | 旧容器分别在活动/停止状态启用 egress；guard 启动失败或运行中丢失                                        | 活动容器要求先排空停止；网络切换保留 home；guard ready 前不启动无保护沙箱，guard 丢失拒绝执行，不降级直连                                | [local sandbox](../test/local-sandbox.test.ts)、[local egress](../test/local-egress.test.ts)                                               |
| NET-01 / P0 | 候选 Envoy/guard 访问允许/禁止域名，用无效/过期/跨范围 token 重试，然后停代理                           | 代理处理过的 allow/deny/token 决策审计落 PG；代理停机和守卫丢弃仍拒绝连接，但不要求产生不存在的域名审计                                  | [egress authz](../test/egress-authz.test.ts)、[审计 PG](../test/postgres-egress-audit-sink.test.ts)；需候选镜像联测                        |
| NET-02 / P0 | 在 enforcement 模式取消代理变量，尝试直连 IP、Docker/外部 DNS、UDP、IPv6、原生 IMAP socket              | 无旁路出站；仅代理兼容的 HTTP/HTTPS/CONNECT 属于当前保证，不能要求原生 IMAP/UDP 成功；守卫丢弃不伪造域名代理日志                         | [local egress](../test/local-egress.test.ts)、[边界文档](./local-docker-egress.md)；真实网络反例                                           |
| NET-03 / P0 | 配置域名、IPv4/IPv6、CIDR、首尾包含的 range；组合 allowlist/denylist 与多 DNS 私网地址                  | 私网例外仍受一般策略约束，deny 优先；loopback/link-local/metadata 永拒；所有私网答案都获准；失败解析/rebind 拒绝且使用已验证地址         | [egress authz](../test/egress-authz.test.ts)、[egress policy](../test/egress-policy.test.ts)、[admin egress](../test/admin-egress.test.ts) |
| NET-04 / P0 | 不同部门/访问组成员组成多人会话，变更成员关系与私网例外，分别新开下一轮和保留旧 CONNECT                 | 有效多人例外取共同权限；第二实例下一轮更新；明确旧 token/后台进程/已建 CONNECT 不即时撤销，需要立即切断时按操作流程停止相关沙箱          | [governance inheritance](../test/governance-inheritance.test.ts)、[governance turn](../test/governance-turn.test.ts)；真实连接生命周期验证 |
| NET-05 / P0 | 旧 allowedHosts 配置升级；填写 loopback、0.0.0.0、非 IPv4 与实际宿主网关；检查 listen/firewall/外部探测 | 自动预检拒绝前三种已知错误；实际部署确认绑定 Docker host gateway 且未公网暴露，不能声称字符串校验能拒绝所有公网 IP；无私网例外不放开私网 | [production preflight](../test/production-preflight.test.ts)、[local egress](../test/local-egress.test.ts)；网络暴露面实测                 |

## G. Cron、Web 界面与中文化

| ID / 等级    | 前置数据与操作                                                                                                                | 必须观察到的结果                                                                                                                                                    | 已有入口 / 尚需证据                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| WEB-01 / P1  | 中英文切换后刷新 Web/Admin，打开模型、技能、成员、治理、日期/数字展示                                                         | 语言选择持久保存，两侧一致；动态文本、身份、模型 ID、密钥、用户编写内容不被翻译或改写                                                                               | [Web i18n](../plugins/web-ui/test/i18n.test.ts)、[Admin i18n](../plugins/admin/test/i18n.test.ts)；需两语言页面截图                                  |
| WEB-02 / P1  | 在宽窄窗、多标签、多面板、流式回复期间切换会话、滚动、展开长提示、拖放文件                                                    | 无丢失正文/附件、重复发送、悬挂遮罩；输入锁在审批交接后正确释放，运行时默认提示跨面板一致                                                                           | 上游 UI 回归测试须与本地下游模型/技能/IM 页面联测；源码断言不能替代浏览器                                                                            |
| WEB-03 / P0  | 停用成员或移出资源授权后，通过搜索、直接链接、Files、分享链接重新访问资源                                                     | 每个入口按最新有效授权拒绝；搜索优化不能绕过组织、参与者和技能资源边界                                                                                              | [目录可见性](../test/directory-visibility.test.ts)、[会话元数据](../test/session-metadata-authz.test.ts)；需新增跨入口联测                           |
| WEB-04 / P1  | 有原有环境绑定与无绑定的范围分别打开会话，跳转环境后刷新                                                                      | 仅有环境绑定时显示“打开环境”；文件/工作记忆使用所绑定环境，当前范围治理和历史语义保持                                                                               | [范围目录](../test/admin-scopes-directory.test.ts)、[上下文模型](../plugins/web-ui/test/context-model-source.test.ts)；需实际可见性验证              |
| CRON-01 / P0 | 普通参与者会话；隐藏 cron Worklog 的 personal owner、scopeShared/scopeFloor 成员、scope/org 管理员、陌生人分别读整段/单 entry | 普通会话参与者路径保持；隐藏 cron 会话按实现的 viewer 规则单独测，非 participant 必须具备 cron ref、精确 retained sessionId、当前管理权限三项；不能推断任意成员有权 | [session authz](../test/session-metadata-authz.test.ts)；owner 外角色需补测                                                                          |
| CRON-02 / P0 | stable/legacy threadRef、伪造/空 sessionId、fireLog 裁剪、disabled/archived、旧行；owner 停用后经真实 HTTP/Portal 入口读      | 精确关联缺失拒绝；disabled/archived 不自动扩大权限；停用/旧 version 由身份入口拒绝，不能依赖仅做 samePerson 的 cron owner 判断；PG 两实例一致                       | [session authz](../test/session-metadata-authz.test.ts)、[cron store](../test/cron-store.test.ts)；若直接 viewer 可绕过 active gate 列基线缺陷并修复 |
| CRON-03 / P1 | 在 runs 页面打开 Worklog，返回、刷新、新标签重开，再检查 sidebar/普通搜索                                                     | 合法访问成功且会话保持隐藏；不通过把 cron runtime 会话放回普通历史来修复链接                                                                                        | [deep link](../plugins/web-ui/test/crons-deep-link.test.ts) 是源码断言；必须浏览器与搜索联测                                                         |

## H. PostgreSQL、持久化与升级

实现：[pg-pool](../src/persistence/pg-pool.ts)、[组织存储](../src/organization/postgres-organization-store.ts)、[目录存储](../src/directory-sources/postgres-directory-source-store.ts)、[登录事务](../src/auth/portal-login-transactions.ts)。

| ID / 等级  | 前置数据与操作                                                                                                        | 必须观察到的结果                                                                                                                                      | 已有入口 / 尚需证据                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB-01 / P0 | 扫描 createPgPool/schema/pool/new pg.Pool/锁/通知调用与所有下游 store；检查全局 migrateRegisteredPgSchemas 前注册顺序 | 无旧签名调用；迁移 ID 唯一稳定、checksum 不篡改；无 qm_schema_migrations 的旧库能幂等收敛并记录；所有 store 注册完成后才迁移/接流量                   | [持久化重试](../test/persistence-init-retry.test.ts)；需二开调用者、注册顺序与 adoption 回归                                                                                                        |
| DB-02 / P0 | 分别用空库及共用夹具的旧库启动候选；重启两次；比较关键表 ID、数量、归属和密文可读性                                   | 新库可建表；旧库无重建/丢失；来源版本实际存在的组织、目录、登录、绑定、授权、审计、会话和待处理任务保持；幂等执行无重复副作用                         | [组织 PG](../test/postgres-organization-store.test.ts)、[目录 PG](../test/postgres-directory-source-store.test.ts)、[登录 PG](../test/postgres-portal-login-transactions.test.ts)；缺少组合升级演练 |
| DB-03 / P0 | 两实例迁移、中断、持锁超时；恢复 DB 再启动；分别让 unlock/release 失败                                                | 不标记部分成功；保留当前有限 schema 等待意图，上游阻塞 pg_advisory_lock 无 timeout，须按 GAP-15 补适配；超时后销毁不安全 client，可重试，失败不接业务 | 现有重试/锁测试不足以证明新迁移锁行为；需真实 PG timeout/fault 注入                                                                                                                                 |
| DB-04 / P0 | 直连与事务池模式分别测试普通查询、单 client 显式事务、会话锁、LISTEN/NOTIFY/leader                                    | 普通 query 用 pool；事务必须固定 client，pg_advisory_xact_lock 随该事务；跨事务的会话锁/通知用 sessionPool；unlock失败销毁 client；DB身份/CA保持      | [数据库预检](../test/production-database-preflight.test.ts)、[PG URL](../test/postgres-url.test.ts)；不能把 transaction pooling 与每个查询换连接混淆                                                |
| DB-05 / P0 | a：目录/成员 job；b：cron run；c：IM delivery，各用两进程并发 claim，在外部接受后ack前杀持有者                        | 无并发重复 claim、租约后可恢复；承认外部副作用 at-least-once 崩溃窗口，支持目的地使用稳定幂等键/去重，其余记录重复风险；不承诺仅靠 PG exactly-once    | [成员任务 PG](../test/postgres-member-job-store.test.ts)、[delivery PG](../test/postgres-delivery-store.test.ts)、[cron queue](../test/cron-queue.test.ts)；各自结果分开                            |
| DB-06 / P0 | 记录写冻结点、备份点和切换期间 delta；分别在未/已启用沙箱资源的升级副本回滚，计时                                     | 旧读者×新 schema 矩阵明确；兼容回滚保留新写入，不兼容时按批准的冻结/备份恢复处理 delta；核对丢失窗口与恢复时间，禁止只换镜像宣称成功                  | 需版本化 SQL fixture 与独立 Docker 状态 fixture，备份恢复日志和容量计时                                                                                                                             |

## I. 生产 Compose、密钥和镜像发布

实现：[生产 Compose](../compose.production.yaml)、[生产预检](../scripts/production-preflight.ts)、[部署脚本](../scripts/deploy-production-release.sh)、[镜像工作流](../.github/workflows/release-production-images.yml)、[生产运维](./docker-compose.md)。

| ID / 等级   | 前置数据与操作                                                                                             | 必须观察到的结果                                                                                                                                                                                         | 已有入口 / 尚需证据                                                                                                                                                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEP-01 / P0 | 用生成的测试配置渲染生产 Compose；分别使用内置 PG、外置 PG、TLS/CA、同机/远程反向代理                      | 原有项目名与显式卷名稳定；生产仅拉 digest 镜像；外置 DB 不启动内置 PG；入口端口与内部服务隔离保持                                                                                                        | [Compose](../test/production-compose.test.ts)、[预检](../test/production-preflight.test.ts)、[数据库预检](../test/production-database-preflight.test.ts)                                                                                                                                                                                           |
| DEP-02 / P0 | 升级配置保留现有 connector、IM 派生密钥、Portal 会话密钥、Auth JWK 与 token secret；留空编辑已有供应商密钥 | 旧密文和会话继续兼容；Web 仅获得其 IM 解密范围，不接收 connector 根密钥；日志/API 不暴露密钥；缺钥明确失败                                                                                               | [IM 配置](../plugins/web-ui/test/im-credentials-config.test.ts)、[IM 派生部署](../test/production-deploy-script.test.ts)、[connector 旧密钥迁移](../test/secret-key-migration.test.ts)、[能力隔离](../test/capability-secret-isolation.test.ts)；secret-key-migration 仅验证 connector fallback，不证明 IM scoped key；需 IM-01 旧密文真实解密路径 |
| DEP-03 / P0 | 已有多个 profiles 时运行部署脚本的受控测试，分别设置/清空代理 URL                                          | 保留原 profiles；需要时追加 egress，不替换已有项；明确当前生产 Auth 为默认服务，不能把历史 `auth` profile 假设当现状                                                                                     | [部署脚本](../test/production-deploy-script.test.ts)、[Compose](../test/production-compose.test.ts)；执行前按源码重新确认 profile 声明                                                                                                                                                                                                             |
| DEP-04 / P0 | 缺少/篡改签名、checksum、镜像清单、重复 tag、部分镜像晋升失败时运行发布/部署故障路径                       | 验证失败在部署前停止；不绕过 npm audit、漏洞扫描或签名；同 digest 可幂等恢复，不把另一提交冒充既有发布                                                                                                   | [release workflows](../test/release-workflows.test.ts)、[部署脚本](../test/production-deploy-script.test.ts)；真实发布仍需远端完成证据                                                                                                                                                                                                             |
| DEP-05 / P1 | 构建两个仅业务代码不同、依赖相同的 core 候选，比较推送镜像的 RootFS 层与 pull                              | 使用签名且 digest 固定的 core-base；依赖层 digest 复用；不把本地 BuildKit cache hit 当客户端下载优化证据                                                                                                 | [release workflows](../test/release-workflows.test.ts)；需已推送镜像的层摘要与拉取记录                                                                                                                                                                                                                                                             |
| DEP-06 / P0 | 保留当前独立 Web/Admin/Portal/Auth 拓扑启动候选，验证路由、签名身份、回调和流式响应                        | 入口与新代码兼容；不意外双启 Auth、转发到错误 `/admin` 或丢失企业微信环境变量；首批不自动缩减旧工作负载                                                                                                  | [生产 Compose](../test/production-compose.test.ts)、[Portal router](../plugins/portal/test/router.test.ts)；需生产形态 dev QA                                                                                                                                                                                                                      |
| DEP-07 / P0 | 对所有生产镜像与 release 附件核对候选 SHA、digest、签名身份、扫描和清单完整性                              | 八个运行时 manifest 引用完整；core-base 与 sandbox-base 是另行签名的构建中间镜像，单独核对其证据，不能混为八个全部构建产物；流程改变必须显式更新契约及测试，不静默减少发布覆盖；发布成功不等于生产已部署 | [release workflows](../test/release-workflows.test.ts)、[sandbox 镜像](../test/sandbox-base-image.test.ts)；需实际远端工作流及资产核对                                                                                                                                                                                                             |
| DEP-08 / P0 | 测试发布升级失败后的回滚：记录前后镜像、配置、密钥版本、卷和数据库快照                                     | 旧资源可恢复，无 `down -v`、无删除工作卷、无根密钥轮换；路由、登录、已有会话、IM 与待处理任务复核通过                                                                                                    | 尚需专用环境的完整升级/回滚演练，禁止在生产试验                                                                                                                                                                                                                                                                                                    |

## J. 上游特性启用与边界

| ID / 等级   | 操作                                                                                        | 接受条件                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| NEW-01 / P0 | 先部署兼容读者并排空旧 core/worker，再启用 `SANDBOX_RESOURCES_ENABLED`，中断并重试回填      | feature 默认关闭；回填保留原 backing identity、默认选择和显式 null；激活标记最后写入；关闭开关不被当作撤销迁移 |
| NEW-02 / P0 | 评估上游 web/admin、portal/auth 合并，另行验证路由、资源预算与密钥合集                      | 首批保留独立部署；合并服务须单独审查、QA 和回滚。未执行不影响兼容代码评估，但禁止声称新拓扑已验证              |
| NEW-03 / P1 | 开启个人订阅凭据、外部邀请、开放分享、其他云 sandbox 或记忆服务前执行相关权限与真实服务测试 | 默认不扩大现有成员权限、凭据来源或数据可见范围；只为已配置并验收的集成启用；mock wiring 不等于真实能力         |
| NEW-04 / P0 | 合并失败回合退避，同时检查 IM 交付重试                                                      | 分别记录 run 重试、消息发送重试、租约与最大尝试次数；不得把 run 退避当成 IM 最大重试次数修复                   |

## 关键用例的执行细分

下表是必须固定的子项，其他复合行也按同样规则在结果表展开。自动化使用当前页面实际稳定 selector/API 路径；执行前记录 selector，不能只按翻译后的按钮名字定位或臆造控件。

| 子项    | 固定步骤和通过条件                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOD-02a | Pi 对已注册模型执行接线检查；每种首批启用协议真实调用，脱敏记录 endpoint、wire model、返回与工具事件。注册成功不能替代请求成功。                                                         |
| MOD-02b | OpenCode 在模型注册层允许已解析 custom，但协议/端点真实支持另测；不兼容或无实际请求的组合标失败/延期，不继承 Pi 结果。                                                                   |
| MOD-02c | Claude 只接受 Messages 兼容目标；核对原生/custom anthropic 及代码明确支持的 OpenRouter/DeepSeek 端点。对普通 Completions/Responses-only provider 确定性拒绝。                            |
| MOD-02d | Codex 只接受 Responses 兼容目标，包括代码明确支持的 OpenRouter 路由；对 Chat Completions-only/Messages-only provider 确定性拒绝。                                                        |
| MOD-02e | mock 仅用于测试接线，无论是否注册模型均不得进入生产 picker；绝不计入真实模型证据。                                                                                                       |
| MOD-04a | 两个独立进程连接专用 PG，一边延迟无 key 编辑，一边轮换 key；核对密文版本、fingerprint及随后真实请求只采用完整最新版本。                                                                  |
| SKL-04a | 首项创建后终止进程：pending journal 持久化；重启后未完成批次不可 list/detail/resolve/execute；恢复后完整发布或清理本批资源，不删除同名已有资源。此为 GAP-14 设计目标，尚未实现。         |
| SKL-04b | 第二项创建失败且第一项补偿 delete 失败：journal 保留可重试状态；再次恢复得到零半成品，原有资源/授权不变；失败不能记录成功审计。                                                          |
| SKL-04c | 两 PG 进程确认同 fingerprint：记录 claim/事务结果、发布计数和幂等记录；不能只测试共享内存锁。                                                                                            |
| BOX-02a | 分别让 container、network、guard 删除失败；记录 owned 对象 ID、卷 ID与文件 hash，解除故障重试后仅清理预定对象，home 保持。                                                               |
| NET-03a | 私网规则加入非法 CIDR、反向 range、跨 IPv4/IPv6 family range；确定性拒绝保存；合法首尾地址均按包含边界匹配，canonical IPv6 等价写法结果一致。                                            |
| WEB-02a | 流式回答期间切换会话/面板再返回：核对会话 ID、正文连续性、发送请求次数和无重复 turn，保存截图。                                                                                          |
| WEB-02b | 触发审批，重复点击/提交后运行交接：审批 ID 不串线、只触发预期 continuation、输入锁释放；记录请求与 run ID。                                                                              |
| WEB-02c | 流式 DOM 重绘期间拖入/拖出/放下文件：overlay 无残留；上传与发送次数符合操作；附件最终可见且下载 hash 正确。                                                                              |
| WEB-02d | 窄窗展开模型菜单/长提示，调整窗宽并切面板：控件不裁切、不遮挡必要操作；以稳定 selector 和中英文截图记录。                                                                                |
| WEB-02e | 分别测试用户向上滚动、跟随底部、markdown 渲染完成、切标签恢复：不抢用户滚动位置，跟随状态下可见最后内容。                                                                                |
| WEB-03a | search/direct transcript/Files/share/skills 各自请求已撤权资源；断言 body、标题、摘要、附件元数据不泄露；按当前 API 的拒绝状态契约检查，不无依据要求所有接口使用同一状态码。             |
| WEB-04a | 无绑定范围的 `.environment-notice.hidden` 实际不可见；有 environmentAttachment 时链接准确指向绑定环境；点击前后核对 file/memory 目标和当前 scope/history，不靠文案推断。                 |
| DB-03a  | 进程 A 持有新迁移锁，B 等待至 configured deadline，B 不接流量且超时退出/可重试；释放 A 后 B 启动成功；分别在 unlock 失败时验证 client 被销毁。                                           |
| DB-05a  | 目录与成员 job：成功提交事务前后 kill，任务状态/审计/成员关系幂等，旧 lease owner 不能覆盖新结果。                                                                                       |
| DB-05b  | cron run：调度去重与 run claim 分开计数，旧 worker fencing 保持；外部工具副作用不因此获得 exactly-once 保证。                                                                            |
| DB-05c  | IM delivery：外部接受但 ack 前 kill，验证相同幂等 key；平台无去重保证时记录可能重复的窗口和可诊断状态，禁止签“绝不双发”。                                                                |
| NEW-01a | 全部兼容 reader 已部署，旧 core/worker与在途任务排空后启用；未完成迁移不接新流量，回填中断重试不重复或丢 backing identity。                                                              |
| NEW-01b | 回填无 provider 调用/磁盘复制，推断 inventory 为 unverified，保留 explicit default/null，marker 最后写；新 scope 无 default 时不隐式建机。                                               |
| NEW-01c | 兼容 legacy provisioning 在 activation 后结束，只补 missing default；不能覆盖新选择/null；activation 后 legacy migration 拒绝。                                                          |
| NEW-01d | 改默认后旧进程继续使用保存 target；仍为 default或有 job 的 resource不能 retire；cleanup 失败隔离执行且可重试。                                                                           |
| NEW-02a | 现有独立入口 `plugins/web-ui/server/index.ts`、`plugins/admin/src/index.ts`、`plugins/portal/src/index.ts`、`plugins/auth/src/index.ts` 与四镜像分别启动验收；合并后的路径变化更新映射。 |
| NEW-02b | 后续 combined 拓扑：union env/secret 冲突拒绝；embedded auth 只监听 loopback；不自动删除旧 admin/auth；回滚先恢复旧工作负载，再切回 portal/web 镜像与路由。                              |
| NEW-04a | run retry_after 写入 PG，重启后保留；尝试次数按 run.maxAttempts 上限；不可重试错误不重新排队；lease reclaim 与 errorAttempts 分开验证。                                                  |
| NEW-04b | 固定随机源验证退避从15秒基数指数增加，抖动至多20%，最终不超过60秒；同时验证 inline drive等待、session串行和后续消息不会越过退避。                                                        |

新增可选能力不共用一个“通过”：个人订阅凭据、外部邀请、开放分享、每个新增云 sandbox、每个记忆 provider 分别记录当前值/控制入口/默认值/首批是否启用/数据边界/回滚。S2 必须从固定上游代码提取真实控制项，不能发明统一 feature flag。存在明确配置时例如 `SANDBOX_RESOURCES_ENABLED=false`、保留 `SANDBOX_BACKEND=local`；`HARNESS_SHARING_POSTURE` 与 `MEMORY_PROVIDER_CONFIG` 必须核对部署值及有效配置。没有可证明关闭手段的新增入口须禁用路由/权限或纳入首批完整验收，不能仅“不填凭据”就一概视为安全关闭。

## 已发现的缺口与集成决策

以下区分当前基线疑点、验证缺口和确定的上游接口差异。基线疑点先补可复现用例，再决定共享层修复；不把尚未实现的加强项描述成旧功能，也不借此添加无关产品功能。

| 编号   | 类型 / 关联用例                | 当前证据与下一步                                                                                                                                                                                                                                                                                             | 阻断范围                                           |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| GAP-01 | 覆盖缺口 / SKL-05              | HTTP surface 已在来源读取前校验范围；补未授权入口 fetch=0 与延迟 fetch 中撤权后锁内拒绝、零写入，核对非 HTTP 调用者                                                                                                                                                                                          | 技能授权与撤权窗口                                 |
| GAP-02 | 基线疑点 / IM-07               | Web IM 枚举持久化用户状态并启动 Bridge，未找到明确 active 组织成员检查。验证停用后轮询/SDK/投递实际行为，不能仅以 Core 拒绝 turn 结案；如确认则补生命周期撤销                                                                                                                                                | 已启用 IM 的成员停用/离职闭环                      |
| GAP-03 | 确定接口差异 / DB-01           | 上游迁移接口不再接受旧 SQL 数组。扫描所有下游存储，包含无文本冲突的组织、目录、成员 job、登录 transaction；分配稳定迁移 ID；仅旧 schema_migrations 确有 legacy ID 才 adopt；下游已有表但无新账本必须验证幂等收敛 DDL+记录 checksum，非幂等 DDL 另设显式 migration/maintenance；专用 session 锁调用者同步适配 | 候选启动与升级                                     |
| GAP-04 | 确定语义冲突 / MOD-01          | 上游新增保留模型 ID/跨供应商重名拒绝；下游已有 qualified ID。以限定 ID 保留合法重名，吸收验证/元数据能力，不全盘替换校验                                                                                                                                                                                     | 模型配置与真实调用                                 |
| GAP-05 | 验证缺口 / MOD-08/09           | 真实供应商与续接尚未验收；MOD-08 明确保留 stored selection 失效后的 deployment fallback，再验凭据/范围门槛；不将“绝不回落”新增为默认契约                                                                                                                                                                     | 启用的模型/harness 组合                            |
| GAP-06 | 验证缺口 / BOX-01、NET-01/02   | fake Docker 未明确覆盖同名新 network ID；缺候选 Envoy/guard 镜像的完整实测。补真实 Docker 卷/连接/拒绝路径                                                                                                                                                                                                   | 本地 sandbox 与 egress                             |
| GAP-07 | 验证缺口 / AUTH-01、DIR-03     | Auth harness 不能证明实际代理可信域、跨浏览器 Cookie 和 pause-vs-login 的组合；使用测试租户及回调域名实测                                                                                                                                                                                                    | 企业微信登录/目录                                  |
| GAP-08 | 验证缺口 / DB-02/06、IM-01     | 新建 schema 和派生 key fixture 无法证明旧部署兼容。准备实际支持版本的旧库副本、旧密文与回滚矩阵                                                                                                                                                                                                              | 数据升级和生产发布                                 |
| GAP-09 | 验证缺口 / CRON-01/02/03       | 现有授权测试偏 owner，深链接测试是源码断言。补管理员、fireLog 裁剪、旧行、跨实例与真实浏览器                                                                                                                                                                                                                 | Cron Worklog                                       |
| GAP-10 | 已知边界 / NET-02/04、IM-08    | 原生非代理协议、已建隧道即时撤销、IM 有限次数重试不属于当前实现保证。记录配置选择；协议扩展、死信/告警另立范围                                                                                                                                                                                               | 不因范围外目标阻断代码集成，但不得虚报该能力已提供 |
| GAP-11 | 验证缺口 / SKL-04、IM-03/04/06 | 内存并发测试不足以证明 PG 多进程确认、企业微信资源 ownership、SDK lease 接管和 ack 崩溃窗口                                                                                                                                                                                                                  | 对应并发路径                                       |
| GAP-12 | 部署适配 / DEP-06、NEW-01/02   | 上游服务合并、沙箱永久激活改变升级路径。首批保留拓扑并关闭新开关，仍要证明新代码兼容旧入口；新架构另设启用门槛                                                                                                                                                                                               | 首批部署及后续特性启用                             |
| GAP-13 | 基线缺陷 / SKL-02              | executable 进入 manifest/hash，但 layFiles 未传 mode/执行 chmod；补 batch 与 fallback 的 mode 传递、真实 stat/执行回归，处理已有物化缓存重写                                                                                                                                                                 | 启用 executable 技能资产的物化路径                 |
| GAP-14 | 新增恢复要求 / SKL-04          | 现有逐项 publish/delete 只保证普通异常补偿。方案：持久化 import journal 标识每批拥有的资源，完成前隔离半成品；恢复/重复确认按 journal 幂等完成或仅清理本批资源。先完成共享存储/读者设计审查，未实现不称崩溃原子                                                                                              | 多技能导入的崩溃恢复验收；不是已有基线保证         |
| GAP-15 | 上游适配要求 / DB-03           | 上游迁移 session advisory lock 默认阻塞无时限。保留本分支 schema 初始化等待最多5分钟的边界，采用 try-lock+deadline 或等效 session timeout；故障销毁client并测试重启                                                                                                                                          | 候选迁移与并发启动                                 |

## 执行批次和门槛

| 阶段         | 工作与交付物                                                                         | 进入下一阶段的条件                                                                  | 当前状态                           |
| ------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------- |
| S1 验收设计  | 固定基线；清单、测试映射、已知边界；两位独立审查者核对                               | 审查发现已处理；清单无未定义的关键预期；缺少环境与补测项明确                        | 已完成设计与独立审查，非业务验收   |
| S2 集成准备  | 保存基线证据；从 origin 创建 worktree；按固定 tag 合并；记录冲突与无冲突调用者       | 逐模块设计决策完整，迁移/凭据/部署保留方案具体                                      | 数据库前置兼容完成；尚未实际 merge |
| S3 模块集成  | 数据库公共接口 → 身份权限 → 模型运行时 → 沙箱/交付 → 页面 → 部署                     | 相应行为与消费者测试、lint、项目 typecheck 通过；失败路径有覆盖                     | 待执行                             |
| S4 真实 QA   | 专用旧库升级；`dev-instance --no-slack` 页面、真实供应商及配置启用路径；生产形态回滚 | 所有首批启用 P0/P1 的 required 子项通过且 PG 0 skip；环境阻塞继续阻断；保存页面截图 | 待执行                             |
| S5 审查与 CI | 独立代码审查；向 origin 提交 PR；等替换 CI 完成                                      | 无未解决阻断发现；CI 完成而非仅排队；产品证据与最终 SHA 一致                        | 待执行                             |
| S6 发布      | 签名镜像/附件、升级及回滚检查；单独启用新架构                                        | 发布与部署分别记录；新开关/新拓扑不得绕过其门槛                                     | 待执行                             |

S1 文档审查通过只允许进入代码集成，不能替代 S3/S4。GAP-13/14 的执行位修复和崩溃恢复是显式新增/修复要求，不声称基线已具备；在 S2 先审设计并限制受影响入口，不能顺便扩大为通用存储重构。部署前仍须获得本次部署的明确授权；本清单不触发发布、发信或生产变更。

## 验证命令约定

使用项目要求的 Linux Node/npm。WSL 先执行 `type -a node npm`；本机可用 Node 路径为 `/root/.nvm/versions/node/v24.18.0/bin`，执行时设置 PATH，不调用 Windows npm。

根目录的选定文件执行形式如下；具体文件按上面批次选取，保留所属脚本参数。示例是后续执行入口，本次没有因此运行这些业务用例。

```bash
node --experimental-test-module-mocks --test test/custom-providers.test.ts test/base-model-serviceability.test.ts
node --test --test-concurrency=1 test/postgres-organization-store.test.ts test/postgres-directory-source-store.test.ts
npm run typecheck
npm --prefix plugins/web-ui run typecheck
```

PG 命令运行前按测试夹具实际读取的环境变量配置专用测试数据库并检查目标。插件从各自目录运行所属脚本筛出的文件，不把文件名附加到含通配符的 `npm test`。合并后重新核对脚本与重命名测试，确认筛选实际执行了目标用例。需要安装时仅安装涉及的插件依赖。

业务代码集成要 lint 改动代码、typecheck 所属 TS 项目并覆盖消费者；文档单独提交只需格式、相对链接、ID/状态完整性检查及实际消费本文的测试。本阶段不跑全量业务套件，完整 CI 是后续代码门槛。

## 审查记录

2026-09-14 完成三轮只读审查（源码/测试盘点、草稿审查、修订复审）。主作者负责文档编写；以下两位独立审查代理未编辑文档或业务代码。审查仅批准验收设计进入 S2，不批准任何业务用例、候选部署或生产发布。

| 审查者                      | 范围                                                                       | 复审结论与处理                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `review_identity_contracts` | A/B/D/H/I：组织身份、目录、企业微信/Portal、IM、旧库与发布契约             | 无结构性阻断；最后要求将 IM-07 改为“待验证的基线疑点”、DB-01 改为“幂等收敛并记录”，主作者已逐项修正。允许进入 S2。     |
| `review_runtime_contracts`  | C/E/F/G/H/J 与共用门槛：模型、技能/MCP、沙箱/egress、Cron/UI、PG与启用路径 | 内容阻断已消除；85 主用例、30 重点子项、15 GAP、相对链接和格式检查一致。批准进入 S2；阶段状态和 Git 收尾由主作者完成。 |

重点修订记录：

| 审查发现                                   | 最终决策                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 将模型失效后的行为误写为绝不回落           | MOD-08 保留基线 deployment fallback，分开验证显式请求、凭据和 scope 限制。                        |
| 将技能执行位/崩溃原子性当作已有保证        | GAP-13 记录实际 mode 丢失；GAP-14 明确 journal/隔离/恢复是新增设计要求，未实现不称通过。          |
| 将来源读取后再次授权误判为入口无授权       | GAP-01 改为入口 fetch=0 与读取中撤权后的零写入两个窗口。                                          |
| 用 lease 推断无重复外发                    | IM-06、DB-05 承认 ack 前崩溃窗口，限定局部幂等及 at-least-once 保证。                             |
| 将 v0.1.5 当生产升级来源                   | 用户确认且远端核实 prod-v1.3.0=bd1cb20；真实格式、辅助回归、合成损坏样本分开。                    |
| 新迁移账本与锁语义不明确                   | GAP-03 区分 legacy adopt 与已有表无账本；GAP-15 保留有限等待，专用 session 锁及注册时序单独验证。 |
| 混淆语法预检与公网暴露、即时撤权与扫描收敛 | NET-05 加运行网络证据；DIR-03 分管理 API 路径与后台扫描；旧 CONNECT/token 边界明确。              |
| 镜像计数、密钥测试和治理表格不准确         | 八运行时引用与两个基础构建镜像分开；connector fallback不代替 IM canary；GOV 纳入完整表格。        |
| 复合用例和跳过容易被误签                   | 每断言子 ID、全部 required 子项通过、首批环境阻塞继续阻断、PG 0 skip；新增30个固定子项。          |

本阶段实际检查：用 Linux Node 24.18.0 运行主工作区已安装 Prettier 对本文检查通过；85 个主用例（74 P0 / 11 P1）、30 个子项、15 个 GAP 的唯一性和引用关系检查通过；相对文件链接与 Markdown 表格结构检查通过；未发现已有测试读取本文路径，因此没有文档消费测试需要运行。没有执行应用构建、typecheck、PG、浏览器、真实模型、IM 外发或任何部署。上述业务用例执行状态仍全部为待执行。

## S2 数据库前置进展（2026-09-14）

已完成四个下游存储的首批命名迁移兼容准备及独立复审，详细实现决策、固定 `prod-v1.3.0` fixture、独立审查结果与证据边界见 [PostgreSQL 前置报告](./upstream-v0.1.11-pg-preparation.md)。此次先验证前置兼容提交，尚未执行上游 merge；SQL 数组过渡接口、全局注册迁移、事务池和整栈启动仍待后续适配。S2 总状态保持进行中，DB-01～DB-06 和 GAP-03/08/15 均未整体签收；其余业务用例状态不变。
