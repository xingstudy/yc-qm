# 外部目录身份匹配与登录绑定 PRD

## 文档状态

- 状态：Implemented
- 版本：1.1
- 日期：2026-08-29
- 关联 PRD：[`organization-member-management-prd.md`](./organization-member-management-prd.md)
- 关联设计：[`organization-skill-authorization-design.md`](./organization-skill-authorization-design.md)
- 开发计划：[`2026-08-28-external-directory-identity-linking.md`](./superpowers/plans/2026-08-28-external-directory-identity-linking.md)

本文档定义外部平台目录同步、外部身份匹配、登录绑定和管理员操作闭环。第一版以企业微信扫码登录为首个落地场景，但产品模型和接口必须允许后续接入 Slack、飞书、钉钉、通用 OIDC 和其他企业身份平台。

文中的“必须”表示产品、安全或数据一致性要求；“建议”表示实现可以调整，但调整后仍需满足验收标准。

## 1. 背景

QM 已经拥有持久化的组织成员、组织架构、访问组和授权数据。用户通过企业微信扫码登录时，身份代理可以获得企业成员的 `UserID`、姓名和邮箱，但当前登录链路主要使用邮箱作为 principal。只要企业微信返回的邮箱与现有组织成员邮箱不一致、为空或类型不同，登录准入就可能按域名自动创建新的组织用户。

由此产生的问题包括：

- 同一个自然人在 QM 中出现两个 `principalId`。
- 新账号没有原账号的部门、访问组、管理员授权和历史资源。
- 企业微信 `UserID` 没有成为长期身份绑定依据，邮箱变化后仍可能再次失配。
- 管理员无法查看外部平台成员与 QM 组织成员的对应关系，也无法处理冲突。
- Slack 现有目录同步是 surface 驱动的成员和频道快照，不是可供多个平台复用的组织身份同步产品。
- 若为每个平台分别增加 `.env` 开关和专用匹配逻辑，飞书、钉钉等平台接入时会重复实现配置、同步、匹配、审计和冲突处理。

外部平台身份必须先归一化为稳定的“平台租户 + 平台成员 ID”，再绑定到现有 QM 组织成员。邮箱只能作为首次匹配证据，不能作为永久外部身份主键。

## 2. 产品目标

### 2.1 第一阶段目标

- 在 Admin 中提供组织级“身份来源”页面，不依赖修改 `.env` 完成日常配置和启停。
- 支持创建、测试、启用、暂停和删除企业微信身份来源。
- 定期同步用于身份匹配的企业成员快照，并支持管理员手动立即同步。
- 使用企业微信 `CorpID + UserID` 作为稳定外部身份，将扫码登录映射到已有 QM 组织成员。
- 对唯一、可信的企业邮箱匹配执行安全的首次自动绑定。
- 对员工编号、手机号、姓名或冲突邮箱只生成候选，交由管理员确认。
- 提供未匹配、待确认、冲突和已绑定成员的管理工作台。
- 已启用身份来源的登录匹配失败时拒绝登录，不再静默创建重复组织用户。
- 允许同一 QM 组织成员同时绑定来自不同平台的多个登录身份。
- 同步状态、游标、任务、绑定和审计全部持久化，适应多实例和进程重启。

### 2.2 通用化目标

- 平台适配器只负责认证、拉取和标准化外部成员，不各自实现账号匹配规则。
- 通用服务负责配置、调度、差异、匹配、绑定、冲突、登录解析和审计。
- 平台能力通过 capability 描述，Admin 页面按能力展示配置，不硬编码企业微信专属流程。
- 支持一个组织配置多个身份来源，也支持一个用户绑定多个来源。
- 外部成员快照按来源隔离，不能让企业微信、Slack 或其他平台互相覆盖。

### 2.3 成功标准

- 已绑定成员再次扫码时 100% 按稳定外部身份进入原 QM 账号，不依赖当前邮箱。
- 唯一可信企业邮箱能够在首次扫码时命中并绑定已有未冲突成员。
- 已启用受管身份来源的未知成员登录不会创建新 `organization_users`。
- 管理员能在一个页面解释每个外部成员为什么已绑定、待确认、冲突或未匹配。
- 新增第二个平台时无需新增平台专属匹配表、匹配 API 或调度器。

## 3. 非目标

第一阶段明确不包含：

- 使用外部目录自动创建 QM 组织成员。
- 使用外部目录自动创建、移动或归档 QM 组织节点。
- 用外部平台资料覆盖管理员维护的姓名、企业邮箱、职位、手机或员工编号。
- 因外部成员删除而自动将 QM 组织成员设为 `deprovisioned`。
- 合并两个 QM 用户的历史会话、文件、项目、Skill、Cron 或其他资源。
- 把姓名、部门或手机号作为无需确认的自动绑定依据。
- 同时交付企业微信、Slack、飞书和钉钉全部适配器；第一阶段只要求企业微信可用。
- 取代现有 Slack 频道、群组和消息 surface 同步。
- 将现有面向用户的 OAuth “连接器”页面改造成组织身份来源页面。
- SCIM 用户生命周期管理、即时事件回调和自动离职；这些能力可以后续建立在本模型之上。

## 4. 产品原则

### 4.1 内部成员与外部身份分离

`organization_users` 是 QM 组织成员主数据。外部目录成员是匹配证据，不是另一个组织成员表，也不能直接参与 QM 授权计算。

### 4.2 稳定 ID 负责绑定，资料字段负责发现

永久绑定键为：

```text
org_id + provider + external_tenant_id + external_subject_id
```

平台示例：

| 平台     | `external_tenant_id` | `external_subject_id`          |
| -------- | -------------------- | ------------------------------ |
| 企业微信 | `CorpID`             | 企业内 `UserID`                |
| Slack    | `TeamID`             | Workspace 内 `UserID`          |
| 飞书     | `TenantKey`          | 适配器选定的稳定 `user_id`     |
| 钉钉     | `CorpID`             | 企业内 `UserID`                |
| OIDC     | `issuer`             | IdP 返回且校验通过的 `subject` |

邮箱、员工编号、手机号、姓名和部门只用于首次发现候选或人工核对。绑定成功后，这些字段变化不能改变绑定目标。

### 4.3 匹配失败必须显式

对已启用受管身份来源，匹配失败、歧义或冲突必须拒绝登录并进入管理员待处理列表，不得回退到域名自动加入或创建新成员。

### 4.4 多来源不争抢主数据

第一阶段同步只更新来源专属外部成员快照和匹配状态，不调用现有全局目录 `replace()`，也不写组织成员资料、组织关系、访问组或授权。

### 4.5 自动化必须可解释

每次自动绑定必须能展示使用的规则、证据、发生时间、来源同步批次和目标组织成员。只保存必要的规范化证据，不在普通日志中输出完整个人资料。

## 5. 术语

### 5.1 身份来源

一个组织配置的外部平台租户实例。例如“示例公司企业微信”是一个身份来源，包含 provider、外部租户 ID、功能开关、同步策略和加密凭据。

### 5.2 外部成员

从身份来源同步得到的平台成员快照。外部成员未必已经绑定 QM 组织成员，也不能因为出现在外部目录中就获得 QM 权限。

### 5.3 外部身份

由 provider、外部租户 ID 和外部成员 ID 组成的稳定身份。外部身份只能绑定一个 QM 组织成员。

### 5.4 身份绑定

外部身份到 `organization_users.principal_id` 的持久化映射。一个 QM 组织成员可以拥有多个不同来源的绑定；第一阶段同一来源最多绑定一个外部成员。

### 5.5 登录断言

登录代理经平台服务端验证后提交给 Core 的身份事实，包括来源、外部租户 ID、外部成员 ID 和可选的可信资料。浏览器不能自行提交或覆盖这些字段。

### 5.6 匹配状态

外部成员必须呈现以下状态之一：

| 状态        | 含义                                                       |
| ----------- | ---------------------------------------------------------- |
| `bound`     | 已持久绑定一个 QM 组织成员                                 |
| `suggested` | 有一个候选，但证据不足以自动绑定                           |
| `unmatched` | 没有候选                                                   |
| `conflict`  | 多个候选、强证据互相矛盾或唯一约束冲突                     |
| `ignored`   | 管理员明确暂不处理；后续强证据变化时必须重新进入待处理状态 |
| `inactive`  | 外部平台成员已禁用、离开或不再出现在完整同步结果中         |

## 6. 用户角色与权限

### 6.1 组织管理员

组织管理员可以：

- 查看身份来源及非敏感配置。
- 创建、测试、启用、暂停和删除身份来源。
- 写入或轮换平台凭据，但不能读取已保存 secret。
- 配置登录和目录同步开关、同步周期及自动匹配策略。
- 查看同步运行、错误摘要和外部成员匹配状态。
- 手动绑定、忽略、取消忽略和纠正错误绑定。
- 触发立即同步和目标成员刷新。
- 查看身份来源、同步和绑定审计。

### 6.2 其他角色

组织节点 manager、访问组 manager、普通成员和 agent capability 不能读取外部成员快照、匹配候选、平台凭据或身份来源管理 API，也不能创建或修改绑定。

## 7. 平台能力抽象

每个 provider 适配器必须声明能力，Admin 和同步服务只使用通用能力，不根据 provider 名称推断行为。

```text
login
full_member_sync
delta_member_sync
targeted_member_lookup
event_webhook
corporate_email
employee_number
mobile
departments
external_member_status
```

第一阶段企业微信适配器至少支持：

- `login`
- `full_member_sync`
- `targeted_member_lookup`
- `corporate_email`
- `mobile`
- `departments`
- `external_member_status`

适配器输出统一成员模型：

```text
externalTenantId
externalSubjectId
displayName
emails[] { value, kind: corporate | personal | unknown, verified }
employeeNumber?
mobile?
departmentRefs[]
status: active | inactive | deleted | unknown
observedAt
providerRevision?
```

适配器不得返回平台 access token、secret 或未经筛选的原始响应供普通业务代码持久化。

## 8. 身份来源配置

### 8.1 配置位置

Admin 新增“组织管理 → 身份来源”。该页面与现有用户 OAuth “连接器”分开，因为身份来源是组织级认证和目录基础设施，不是个人授权应用。

### 8.2 通用配置

每个身份来源至少包含：

- 显示名称。
- provider。
- 外部租户 ID，连接测试后确认，启用后不可静默更换。
- 总状态：`enabled | paused`。
- 登录能力开关。
- 成员同步开关。
- 同步周期。
- 自动匹配策略：`verified_corporate_email | manual_only`。
- 同步范围摘要。
- 配置 revision。
- 创建人、更新人和时间。

登录开关和同步开关必须分开：管理员可以暂停新登录但继续同步，也可以临时停止同步但保留已绑定身份登录。

### 8.3 凭据配置

企业微信首期需要：

- `CorpID`
- `AgentID`
- 自建应用 Secret，用于登录、应用校验和按 UserID 读取成员
- 通讯录同步 Secret，可选；配置后才能枚举成员并启用完整同步
- 登录回调地址，只读展示并支持复制

两个 Secret 属于不同的企业微信授权主体，不能混用。自建应用的可见范围必须覆盖允许登录和同步的成员；企业微信对手机号等敏感字段的返回还受租户和用户授权限制。Secret 由 Admin 写入后使用部署级 `CONNECTOR_SECRET_KEY` 派生的用途隔离密钥加密保存，只返回各字段是否已配置和更新时间，不回显明文。

`.env` 只承担以下职责：

- 数据库和 `CONNECTOR_SECRET_KEY` 等部署根配置。
- 现有安装的兼容启动配置。
- 无数据库管理入口时的首次引导或应急 fallback。

若来源使用 `.env` 凭据，Admin 必须标记为“部署管理”，隐藏明文并说明需要通过部署流程轮换。数据库配置和 `.env` 同时存在时，Admin 配置优先；无效的 `.env` fallback 不能阻塞 Admin 页面或接管流程。环境来源不能把连接测试当作同步预览：即使部署请求启用同步，也必须先完成真实预览。Core 只持久化不可逆的带密钥配置指纹；配置不变时跨重启沿用预览确认，任一凭据、连接、匹配策略或能力变化都会停用同步并要求重新预览。该优先级和预览门槛必须在所有实例中一致。

### 8.4 连接测试与启用

创建来源的流程为：

1. 选择 provider。
2. 填写公开配置和凭据。
3. 服务端测试凭据并读取外部租户身份。
4. 管理员确认发现的租户与预期一致。
5. 若配置了通讯录同步 Secret，执行初始同步预览。
6. 展示已绑定、可自动匹配、待确认、未匹配和冲突数量。
7. 连接成功后可以启用登录；预览确认后可以启用同步。

连接测试成功不等于来源已启用。任何凭据修改都必须重新测试。

## 9. 同步需求

### 9.1 触发方式

第一阶段支持：

- 启用前初始同步预览。
- 启用后的立即同步。
- 按配置周期自动同步，默认每 6 小时。
- 未绑定用户扫码时，在能力允许的情况下执行一次受限的目标成员刷新。

同步周期允许 15 分钟至 24 小时。将来支持事件回调时，仍必须保留周期性完整校准，防止漏事件。

### 9.2 同步语义

- 完整同步按 `source_id` 替换该来源的外部成员有效快照，不影响其他来源。
- 增量同步按 provider cursor 或 revision 更新同一来源记录。
- 只有成功完成的完整同步才能把本批次未出现的旧外部成员标记为 `inactive`。
- 分页中途失败不能把未读取页面中的成员标记为离开。
- 相同 provider revision 或内容哈希的重放必须幂等。
- 同一来源最多一个同步任务运行；多实例通过数据库租约或队列唯一键协调。
- 游标、租约、运行结果和错误摘要必须持久化，不能只放进程内存。

### 9.3 同步字段归属

第一阶段同步可以更新：

- 外部成员稳定 ID。
- 外部显示名。
- 企业邮箱、个人邮箱及其类型和可信状态。
- 员工编号、手机号和外部部门引用。
- 外部成员状态。
- 观察时间、provider revision 和规范化内容哈希。

第一阶段同步不能更新：

- `organization_users` 的任何资料字段。
- QM 主部门、其他组织节点或访问组关系。
- 组织管理员、manager、Skill 或 ACL 权限。
- QM 成员状态和 `sessionVersion`。

后续若需要把某个平台设为组织主数据权威来源，必须通过独立 PRD 定义字段所有权、离职策略和组织树对账，不能通过增加一个隐藏开关改变本期语义。

## 10. 匹配与绑定规则

### 10.1 匹配顺序

所有 provider 共用以下顺序：

1. 精确查找已有稳定外部身份绑定。
2. 对未绑定外部成员，查找同组织唯一、规范化相等的可信企业邮箱。
3. 查找唯一员工编号并生成建议候选。
4. 查找唯一手机号并生成建议候选。
5. 使用姓名、部门和职位辅助管理员核对，不单独产生可自动绑定候选。

任一步发现互相矛盾的强证据、多个候选或唯一约束冲突时，结果为 `conflict`，不得继续用更弱规则自动决定。

### 10.2 自动绑定

第一阶段只有以下情况允许自动绑定：

- 已有稳定外部身份绑定。
- 来源策略为 `verified_corporate_email`，且外部成员存在唯一可信企业邮箱；该邮箱在同组织唯一命中一个 `active` 或 `invited` QM 成员；目标成员在该来源中尚无其他绑定；没有员工编号等强证据指向其他成员。

企业微信适配器必须区分 `biz_mail` 与个人 `email`。默认只有 `biz_mail` 作为企业邮箱自动匹配；个人邮箱可以用于管理员核对，但不能静默绑定。

自动绑定必须在一个事务中重新检查所有唯一约束，不能相信同步预览或浏览器传入的候选。

### 10.3 多身份规则

- 一个外部身份只能绑定一个 QM 组织成员。
- 一个 QM 组织成员可以绑定企业微信、Slack、飞书、钉钉或其他不同来源的身份。
- 第一阶段一个 QM 组织成员在同一 `source_id` 中最多绑定一个外部身份。
- 已有其他来源身份不能阻止新的可信来源绑定。
- 目标成员为 `suspended` 时可以保留已有绑定，但不能通过登录恢复为 active。
- `deprovisioned` 成员不能成为新的自动或人工绑定目标。

### 10.4 手动绑定

管理员可以从 `suggested`、`unmatched` 或 `conflict` 外部成员选择一个现有 QM 组织成员。确认页必须展示：

- 外部平台、租户、成员 ID 和状态。
- 外部资料与目标组织成员资料的并排差异。
- 使用了哪些匹配证据。
- 目标成员现有身份绑定。
- 将失效的旧登录会话影响。

服务端必须重新验证来源、外部成员、目标成员、唯一约束和配置 revision。成功后写入绑定、更新匹配状态并记录审计。

### 10.5 忽略与重新出现

管理员可以将不需要登录 QM 的外部成员标记为 `ignored` 并填写可选原因。以下变化必须自动取消忽略并重新进入待处理：

- 稳定外部成员 ID 以外的强身份字段发生变化。
- 出现唯一可信企业邮箱候选。
- 该成员发起登录。

### 10.6 纠正错误绑定

普通登录路径不能修改已有绑定目标。组织管理员可以执行显式“纠正绑定”：

1. 预览当前目标、新目标和相关会话影响。
2. 验证新目标不是 `deprovisioned`，且不存在同来源绑定冲突。
3. 在一个事务中移动绑定并写高风险审计。
4. 递增原目标和新目标的 `sessionVersion`，使相关旧会话失效。

纠正绑定只改变外部登录身份映射，不合并、移动或删除两个 QM 用户的历史资源。若系统中已经存在误创建的重复用户，管理员应先把外部身份绑定到保留的组织成员，再单独检查并暂停重复用户。

## 11. 登录流程

### 11.1 登录代理输出

平台登录代理必须输出经服务端验证并签名的标准化登录断言：

```text
provider
externalTenantId
externalSubjectId
sourceId?
displayName?
emails[]?
employeeNumber?
assertedAt
```

OIDC `issuer + subject` 仍用于协议级 token 校验，但内部账号解析必须使用标准化稳定外部身份。登录代理不能在匹配前把邮箱决定为 QM `principalId`。

企业微信扫码必须用 `CorpID + UserID` 生成稳定 subject；邮箱变化不能生成新的 subject。

### 11.2 Core 登录解析

Core 按以下流程处理：

1. 校验登录断言签名、时效、issuer、audience 和来源租户。
2. 根据 provider 和外部租户解析唯一启用的身份来源。
3. 检查该来源的登录开关。
4. 精确查找已有绑定。
5. 已绑定时检查外部成员和 QM 组织成员状态。
6. 未绑定时读取同步快照；快照缺失或过旧时可执行一次受限目标刷新。
7. 按第 10 节规则自动绑定或生成待处理记录。
8. 成功后只使用绑定返回的 canonical `principalId` 创建 Portal 会话。

### 11.3 登录结果

| 场景                                    | 结果                                              |
| --------------------------------------- | ------------------------------------------------- |
| 已绑定，外部成员 active，QM 成员 active | 登录原 QM 账号                                    |
| 唯一可信企业邮箱匹配且允许自动绑定      | 原子绑定后登录原 QM 账号                          |
| 有建议候选但不足以自动绑定              | 拒绝并提示联系管理员，生成待确认记录              |
| 多候选或证据冲突                        | 拒绝并生成冲突记录                                |
| 外部成员不存在、inactive 或离开来源     | 拒绝该来源登录                                    |
| QM 成员 suspended                       | 按现有暂停原因拒绝                                |
| QM 成员 deprovisioned                   | 按现有离职原因拒绝                                |
| 来源暂停或登录开关关闭                  | 拒绝并提示该登录方式暂不可用                      |
| provider 或租户没有配置受管来源         | 保持现有非受管 OIDC 准入策略                      |
| 已配置受管来源但成员未匹配              | 拒绝，不回退到 `domain_auto_join`，不创建组织用户 |

外部成员在来源中失效只阻止该来源的新登录。第一阶段不因此停用 QM 成员，也不影响该成员使用其他仍有效的登录身份。

### 11.4 用户提示

登录失败页面不能泄露组织中是否存在某个邮箱或候选成员。页面只显示通用原因和管理员联系指引。管理员工作台显示具体匹配证据和冲突。

## 12. Admin 页面需求

### 12.1 导航与概览

Admin 的组织管理区域新增“身份来源”。概览页展示：

- 来源名称和 provider。
- 外部租户摘要。
- enabled 或 paused。
- 登录和同步开关。
- 上次成功同步、下次计划同步和数据新鲜度。
- 已绑定、待确认、冲突、未匹配和 inactive 数量。
- 最近错误和“立即同步”操作。

### 12.2 新增来源向导

向导包含：

1. 平台选择。
2. 平台能力和所需权限说明。
3. 凭据与回调地址。
4. 连接测试和租户确认。
5. 同步范围与周期。
6. 自动匹配策略。
7. 初始同步预览。
8. 启用确认。

页面必须明确说明第一阶段同步只用于身份匹配，不会创建成员、覆盖组织资料或修改部门权限。

### 12.3 来源详情

来源详情包含：

- 基本配置。
- 凭据状态和轮换入口。
- provider capability。
- 同步状态、游标摘要和最近运行。
- 登录状态。
- 匹配统计。
- 审计记录。
- 暂停、重新启用和删除操作。

修改使用 `expectedRevision`。并发冲突返回 `409` 并要求重新加载。

### 12.4 匹配工作台

匹配工作台支持按以下条件筛选：

- `bound | suggested | unmatched | conflict | ignored | inactive`
- 姓名、企业邮箱、员工编号、手机号后四位或外部成员 ID。
- 来源和外部成员状态。
- 最近发起过登录。

列表至少展示：

- 外部姓名和成员 ID 摘要。
- 企业邮箱。
- 外部状态。
- 当前匹配状态。
- 候选 QM 组织成员。
- 匹配依据。
- 最后同步和最后登录尝试时间。

详情抽屉提供资料对比、绑定、忽略、取消忽略和纠正绑定。手机号默认掩码展示，只有进入详情且具备组织管理员权限时才按需返回。

### 12.5 组织成员详情集成

现有“组织成员”详情中的只读身份绑定区域必须增加：

- 平台和来源名称。
- 外部成员 ID 摘要。
- 绑定方式：自动邮箱、管理员手动、迁移或已有精确绑定。
- 绑定时间和最近成功登录。
- 外部成员状态。
- 跳转到来源匹配详情。

## 13. 数据与持久化要求

建议使用以下通用实体；具体表名可以在技术设计中调整，但约束和职责不能丢失。

### 13.1 `directory_sources`

保存组织级来源配置：

```text
org_id
source_id
provider
display_name
external_tenant_id
status
login_enabled
sync_enabled
sync_interval_ms
match_policy
capabilities
config_revision
last_tested_at
created_at / created_by
updated_at / updated_by
```

约束：

- `source_id` 在组织内唯一。
- 启用来源的 `(org_id, provider, external_tenant_id)` 唯一。
- 外部租户 ID 启用后不可直接修改；切换租户必须创建新来源或执行显式迁移。

### 13.2 `directory_source_secrets`

保存用途隔离加密后的平台 secret。公开查询不能返回密文或明文。轮换必须保留时间和操作者审计，但不能把 secret 写入审计正文。

### 13.3 `directory_source_members`

保存来源专属规范化成员快照：

```text
org_id
source_id
external_subject_id
display_name
corporate_email
personal_email
employee_number
mobile
department_refs
external_status
provider_revision
profile_hash
observed_at
inactive_at
match_state
last_login_attempt_at
```

主键为 `(org_id, source_id, external_subject_id)`。敏感字段必须按现有数据保护标准存放和返回；不持久化无业务用途的完整 provider 原始响应。

### 13.4 `external_identity_bindings`

保存稳定外部身份到组织成员的绑定：

```text
org_id
source_id
external_subject_id
principal_id
matched_by
evidence_summary
created_at / created_by
updated_at / updated_by
```

约束：

- `(org_id, source_id, external_subject_id)` 唯一。
- 第一阶段 `(org_id, source_id, principal_id)` 唯一。
- `(org_id, principal_id)` 外键指向 `organization_users`。
- 普通登录只能创建未存在绑定，不能改写已有 `principal_id`。
- 管理员纠正绑定必须走专用事务和审计路径。

现有 `auth_identities` 可以在技术设计中演进为该通用绑定表或作为 OIDC 协议投影，但系统只能有一个决定 canonical `principalId` 的权威绑定服务，不能让两个表分别决定登录账号。

### 13.5 `directory_sync_runs`

保存同步任务和结果：

```text
org_id
source_id
run_id
kind: preview | scheduled | manual | targeted
status: queued | running | succeeded | failed | expired
cursor
lease_owner / lease_expires_at
started_at / completed_at
counts
error_code / sanitized_error
idempotency_key
```

任务刷新页面、进程重启和蓝绿切换后仍可读取。原始 provider 响应和 access token 不进入任务记录。

## 14. API 要求

建议提供以下 Core 管理 API：

```text
GET    /v1/admin/org/directory-sources
POST   /v1/admin/org/directory-sources
GET    /v1/admin/org/directory-sources/:sourceId
PATCH  /v1/admin/org/directory-sources/:sourceId
DELETE /v1/admin/org/directory-sources/:sourceId

POST   /v1/admin/org/directory-sources/:sourceId/test
POST   /v1/admin/org/directory-sources/:sourceId/sync-preview
POST   /v1/admin/org/directory-sources/:sourceId/sync
GET    /v1/admin/org/directory-sources/:sourceId/runs
GET    /v1/admin/org/directory-sources/:sourceId/runs/:runId

GET    /v1/admin/org/directory-sources/:sourceId/members
GET    /v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId
POST   /v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/bind
POST   /v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/ignore
DELETE /v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/ignore
POST   /v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/rebind
```

登录内部 API 必须接受标准化外部身份断言，不再要求登录代理提前决定 canonical `principalId`。Admin 插件只转发上述精确路径，不能增加通配代理。

所有写接口要求 Portal 组织管理员身份、CSRF/来源校验、请求体限制、配置 revision 或幂等键。跨组织 ID、未知来源、禁用来源和 provider/tenant 不一致统一拒绝。

## 15. 安全与隐私

- 登录断言必须由可信登录代理签名；浏览器传入的 provider、租户、成员 ID、邮箱可信标记一律不能直接使用。
- provider access token 和 secret 只在服务端解密，使用后不写日志、审计、任务或 API 响应。
- 外部租户 ID 必须与来源配置精确匹配，不能只按 provider 选择来源。
- 外部身份和绑定查询始终携带 `org_id`。
- 企业邮箱规范化比较大小写，但原始展示值只能来自受信同步快照。
- 个人邮箱不能默认作为企业账号自动匹配依据。
- 手机号、员工编号和匹配证据只对组织管理员可见，列表尽量掩码。
- 登录失败页面不暴露候选用户、邮箱是否存在或成员状态。
- 自动绑定、手工绑定、纠正绑定、忽略、来源启停、凭据轮换和同步必须审计。
- 纠正绑定和来源删除必须使相关缓存失效，并按影响递增会话版本。
- 来源或数据库不可用时 fail closed，不回退为内存映射或客户端决定。

## 16. 审计与可观测性

### 16.1 审计事件

至少记录：

- 来源创建、测试、启用、暂停、配置修改和删除。
- 凭据新增和轮换，只记录存在性和版本。
- 同步开始、成功、失败及计数摘要。
- 自动绑定及匹配规则。
- 手工绑定、忽略、取消忽略和纠正绑定。
- 因冲突、跨组织、非 active 成员或唯一约束拒绝的高风险操作。
- 受管来源登录匹配失败，不记录完整邮箱或手机号。

### 16.2 指标

至少记录：

- 每来源同步成功率、耗时、读取成员数和数据新鲜度。
- `bound`、`suggested`、`unmatched`、`conflict` 和 `inactive` 数量。
- 首次登录自动绑定成功率。
- 已绑定登录成功率和解析延迟。
- 因未匹配、冲突、外部 inactive、QM suspended 或来源暂停导致的登录拒绝数。
- 手工待处理数量和最长等待时间。
- 阻止的重复账号自动创建次数。

指标标签不得包含姓名、邮箱、手机号、员工编号、外部成员 ID 或 `principalId`。

## 17. 失败与边界场景

### 17.1 同步失败

- 保留上一次成功快照并标记数据过旧。
- 不使用失败或不完整批次推断成员离开。
- 已有稳定绑定可以继续登录，除非管理员关闭登录或外部成员已在成功快照中明确 inactive。
- 未绑定登录的目标刷新失败时拒绝并提示稍后重试或联系管理员。

### 17.2 邮箱变化

已有绑定保持不变，只更新外部快照和绑定审计中的最近观察信息。新邮箱命中另一个 QM 成员时标记冲突，不自动移动绑定。

### 17.3 外部成员 ID 变化

系统把新 ID 视为新外部身份，除非 provider 提供可验证的 ID 迁移事件。管理员可以通过纠正绑定处理，不能仅凭姓名和邮箱自动替换旧稳定 ID。

### 17.4 多来源证据冲突

不同来源可以绑定同一 QM 成员。若两个来源的资料不同，只在各自来源中展示差异，不覆盖组织主数据，也不自动拆分或迁移绑定。

### 17.5 来源删除

删除前必须展示外部成员数、绑定数和登录影响。默认采用可恢复停用或软删除；绑定和审计保留。物理清理需要独立保留策略，不在普通 UI 操作中提供。

## 18. 上线与迁移

### 18.1 阶段 A：通用底座和只读预览

- 建立通用来源、外部成员、绑定和同步任务持久化。
- 建立 provider capability 和适配器接口。
- 上线 Admin 来源配置、连接测试、同步预览和匹配工作台。
- 企业微信先以 dry-run 方式同步，不改变现有登录结果。

### 18.2 阶段 B：企业微信稳定身份登录

- 企业微信登录断言改为携带 `CorpID + UserID`。
- 对预览确认后的来源启用稳定身份解析。
- 首次自动绑定仅开放可信企业邮箱规则。
- 受管来源未匹配时阻止 `domain_auto_join`。
- 保留快速关闭登录能力的管理员开关。

### 18.3 阶段 C：现有数据对账

- 扫描现有 `auth_identities` 和组织用户，生成迁移预览。
- 能由稳定外部身份或唯一企业邮箱确定的记录生成候选，不直接改写。
- 已存在疑似重复账号时标记冲突，管理员选择保留的组织成员。
- 绑定修正后由管理员单独暂停重复账号；不自动合并历史资源。

### 18.4 阶段 D：增加其他平台

- 先验证 provider 能提供稳定租户 ID 和成员 ID。
- 实现标准适配器和 capability。
- 复用同一 Admin 页面、同步任务、匹配服务、绑定表和登录解析。
- 平台专属字段只能进入适配器映射，不能扩散到通用匹配服务。

## 19. 验收标准

### 19.1 管理配置

- [ ] 组织管理员可以在 Admin 创建、测试、启用、暂停和软删除企业微信身份来源。
- [ ] 登录和同步使用独立开关，修改后跨实例立即采用一致配置。
- [ ] Secret 加密持久化、只写不回显，API 和日志不泄露明文。
- [ ] `.env` 来源在 Admin 中明确标记配置来源和优先级。
- [ ] 非组织管理员不能读取来源成员、匹配证据或修改配置。

### 19.2 同步

- [ ] 启用前可以完成初始同步预览，预览不修改绑定和组织成员。
- [ ] 支持默认每 6 小时自动同步和管理员立即同步。
- [ ] 同步任务、游标、租约和结果在进程重启、多实例切换后仍可读取。
- [ ] 分页中途失败不会错误标记未读取成员为 inactive。
- [ ] 企业微信和 Slack 快照按来源隔离，不互相覆盖。
- [ ] 同步不会修改组织成员资料、部门、访问组、授权或 QM 成员状态。

### 19.3 匹配与绑定

- [ ] 企业微信使用 `CorpID + UserID` 作为稳定外部身份，邮箱变化后仍进入同一 QM 账号。
- [ ] 唯一可信 `biz_mail` 可以按配置自动绑定已有 active 或 invited 成员。
- [ ] 个人邮箱、员工编号、手机号、姓名或部门不能单独触发静默自动绑定。
- [ ] 多候选、证据矛盾和同来源唯一约束冲突进入 `conflict`。
- [ ] 一个 QM 成员可以绑定不同来源的多个身份。
- [ ] 同一来源的一个外部身份不能绑定多个 QM 成员。
- [ ] 管理员能查看匹配依据并完成手工绑定、忽略和纠正绑定。
- [ ] 纠正绑定使相关旧会话失效，但不移动或合并用户历史资源。

### 19.4 登录

- [ ] 已绑定企业微信成员扫码后返回绑定的 canonical `principalId`。
- [ ] 登录代理不再使用邮箱提前决定 QM `principalId`。
- [ ] 受管来源的未匹配、冲突、inactive 或禁用成员登录被明确拒绝。
- [ ] 受管来源匹配失败不会回退到 `domain_auto_join`，不会新增 `organization_users`。
- [ ] suspended 和 deprovisioned 的现有状态约束继续生效。
- [ ] 外部成员 inactive 只阻止该来源登录，不自动停用 QM 成员或其他来源身份。
- [ ] 登录失败页面不泄露候选账号和组织成员资料。

### 19.5 通用化

- [ ] 匹配服务不包含 `wecom`、`slack`、`feishu` 或 `dingtalk` 专属分支。
- [ ] provider 专属字段只存在于适配器和平台配置 schema。
- [ ] 第二个平台可以复用来源、同步、匹配、绑定、Admin 和审计能力。
- [ ] 系统只有一个权威服务决定外部身份对应的 canonical `principalId`。

## 20. 后续议题

以下能力不阻塞第一阶段，但需要独立设计后再开放：

1. 将某个身份来源提升为组织资料和组织架构的 authoritative source。
2. 外部成员离职自动触发 QM suspended 或 deprovisioned 的策略和恢复规则。
3. 企业微信、飞书或钉钉事件回调驱动的近实时增量同步。
4. 员工编号在满足来源权威、唯一和稳定条件时是否允许自动绑定。
5. 多租户、多子公司或一个 QM 组织对应多个同平台租户的管理体验。
6. 已误创建 QM 用户的资源级合并工具。
7. 外部成员快照和 inactive 历史的保留期限。
