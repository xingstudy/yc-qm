# 外部目录双向身份关联与托管组织目录开发计划

**状态：** 已完成

**日期：** 2026-08-31

**目标：** 在现有外部目录身份来源实现上增加通用供应商契约、企业邮箱反向身份解析、邮箱与企业微信双向自动关联、受控即时创建，以及“仅登录与身份绑定”和“托管组织目录”两种模式。当前只实现企业微信，不实现钉钉、飞书或 Slack。

**关联 PRD：** [`external-directory-provisioning-and-managed-organization-prd.md`](../../external-directory-provisioning-and-managed-organization-prd.md)

## 1. 当前基线

现有工作区已经实现：

- 通用 provider registry 和企业微信 adapter；
- durable 来源、成员快照和同步运行；
- 企业微信稳定身份登录断言；
- 邮箱、工号和手机号候选匹配；
- 自动、手工绑定和纠正绑定；
- Admin 来源配置、同步、成员和匹配工作台；
- `auth_identities` 作为 canonical 人员身份绑定真相；
- 未知受管来源登录失败关闭。

本计划只增量修改上述实现，不复制第二套身份系统。

## 2. 全局约束

- Core 使用 `provider`、`externalTenantId`、`externalSubjectId` 和 `externalUnitId`；企业微信原始字段只存在于企业微信 adapter。
- provider adapter 不直接写组织人员、身份、节点或关系。
- 邮箱反查、对账状态、错误预算、熔断、组织单元快照、映射和来源所有权全部持久化。
- 一个组织最多启用一个 `managed_directory` 来源，但可有多个 `identity_only` 来源。
- 同一外部身份的唯一键是组织、provider、供应商租户和外部 subject，不因来源重建或凭据轮换改变。
- 邮箱登录、目录登录、后台对账和托管同步共用一个身份关联事务入口。
- 已绑定身份登录不依赖远端实时可用性；可能制造重复人员的新建路径失败关闭。
- 不以姓名、手机号、工号或推测邮箱自动合并人员。
- 外部字段缺失不清空 QM 资料。
- 来源不管理访问组、ACL、节点 manager、QM 管理员或业务资源。
- 不新增注释、docblock、TODO、lint/type suppression 或注释代码。
- 保留工作区所有现有改动，不回退无关文件。

## 3. 实施顺序

```text
通用契约与 schema
        ↓
企业邮箱反查与持久化对账
        ↓
双向身份关联与即时创建
        ↓
来源模式与 Admin 安全门槛
        ↓
组织单元快照与托管写入
        ↓
迁移、可观测性、live QA、审查
```

每一阶段先补受影响测试，再实现，再运行该阶段测试。认证、持久化和组织写入完成后统一运行 typecheck、lint 和 format check。

## 4. Task 1：冻结通用供应商契约

**主要文件：**

- 修改：`src/directory-sources/types.ts`
- 修改：`src/directory-sources/provider.ts`
- 修改：`src/directory-sources/provider-registry.ts`
- 修改：`src/directory-sources/providers/wecom.ts`
- 修改：`test/directory-sources.test.ts`

**工作：**

- [x] 增加来源模式 `identity_only | managed_directory`。
- [x] 用语义能力替代粗粒度平台假设：登录、成员快照、按主体读取、企业邮箱反查、可信企业邮箱、组织单元、成员组织关系、增量同步、离职状态。
- [x] 定义统一企业邮箱解析输入和结果分类。
- [x] 定义统一组织单元快照以及主、兼任关系。
- [x] registry 校验 adapter ID 唯一、能力与方法一致。
- [x] 企业微信 adapter 声明实际能力；未实现平台不进入 registry。
- [x] 增加假的契约 adapter 测试，证明 Core 不依赖企业微信字段。

**完成条件：** Core 目录模块中除 `providers/wecom.ts` 和企业微信环境兼容入口外，不根据企业微信字段或错误码决定业务规则。

## 5. Task 2：扩展 durable 数据模型

**主要文件：**

- 修改：`src/directory-sources/directory-source-store.ts`
- 修改：`src/directory-sources/postgres-directory-source-store.ts`
- 修改：`src/organization/organization-store.ts`
- 修改：`src/organization/postgres-organization-store.ts`
- 修改：`test/postgres-directory-source-store.test.ts`
- 修改：`test/postgres-organization-store.test.ts`

**新增持久化对象：**

- `directory_email_resolutions`
  - 邮箱主体引用、带密钥摘要、状态、外部 subject、来源版本、成员快照版本、检查与重试时间、失败次数和安全错误分类。
- `directory_source_units`
  - 外部组织单元稳定 ID、父 ID、名称、排序、状态、资料哈希和观察时间。
- `directory_unit_mappings`
  - 来源租户组织单元到 QM 节点的稳定映射和所有权。
- `directory_unit_member_ownership`
  - 来源拥有的人员部门关系和主部门标记。
- 来源对账与托管字段
  - 模式、JIT 开关、对账状态、完成版本、到期时间、熔断状态和错误预算窗口。

**约束：**

- [x] 外部身份唯一约束改为组织、provider、外部租户和外部 subject。
- [x] 保留 issuer + subject 唯一约束，用于普通邮箱/OIDC 身份。
- [x] 同一组织最多一个 active `managed_directory` 来源，由数据库约束兜底。
- [x] 组织单元映射按组织、provider、外部租户和外部单元唯一。
- [x] schema 使用 expand 迁移，现有来源、身份和成员快照无需重建。
- [x] memory store 与 PostgreSQL store 行为一致。
- [x] 新的 durable 状态在进程重启和多实例之间可见。

## 6. Task 3：企业微信企业邮箱反查

**主要文件：**

- 修改：`src/directory-sources/provider.ts`
- 修改：`src/directory-sources/providers/wecom.ts`
- 新建：`src/directory-sources/email-resolution-service.ts`
- 修改：`src/directory-sources/directory-sync-engine.ts`
- 修改：`test/directory-sources.test.ts`
- 修改：`test/postgres-directory-source-store.test.ts`

**工作：**

- [x] 企业微信 adapter 调用 `user/get_userid_by_email`，固定 `email_type=1`。
- [x] 只接收规范化且由调用方标记为已验证企业邮箱的输入。
- [x] 将成功、未找到、无权限、限流和临时错误转换为通用结果。
- [x] 确认返回 subject 存在于同一来源的有效成员快照。
- [x] 新邮箱或邮箱变化时才调用；有效成功缓存不重复查询。
- [x] 未找到采用负缓存，临时错误采用指数退避。
- [x] 每来源持久化错误预算和熔断状态。
- [x] 触发供应商错误比例风险前停止批量反查。
- [x] 指标和错误不包含邮箱或外部 subject。

**测试：**

- [x] 官方请求路径、POST body 和应用 token 使用正确。
- [x] 成功、未找到、错误码、超时、非 JSON、限流和恢复。
- [x] 缓存、退避、熔断和重启持续性。
- [x] 解析结果不在成员快照中时生成冲突，不绑定。

## 7. Task 4：双向身份关联与即时创建

**主要文件：**

- 修改：`src/directory-sources/identity-linking-service.ts`
- 修改：`src/directory-sources/identity-match.ts`
- 修改：`src/organization/organization-service.ts`
- 修改：`src/organization/organization-store.ts`
- 修改：`src/organization/postgres-organization-store.ts`
- 修改：`src/wiring.ts`
- 修改：`test/organization-service.test.ts`
- 修改：`test/directory-sources.test.ts`
- 修改：`test/postgres-organization-store.test.ts`
- 修改：`test/portal-identity.test.ts`

**邮箱先登录：**

- [x] 普通已验证邮箱登录在创建新人员前调用通用目录身份解析入口。
- [x] 反查 external subject 已绑定时，把邮箱 issuer + subject 绑定到同一人员。
- [x] external subject 未绑定但唯一邮箱人员存在时，把两类身份绑定到该人员。
- [x] 两类身份均未知且准入允许时，在一个事务内创建一个人员和两类身份。
- [x] 反查不可用时，现有邮箱人员继续登录；全新人员按防重复门槛暂缓创建。

**企业微信先登录：**

- [x] 已绑定 external subject 继续按稳定身份登录。
- [x] 有可信企业邮箱时优先复用唯一邮箱人员。
- [x] 无可信邮箱且 JIT 安全门槛就绪时创建 `email=null` 的人员并绑定 external subject。
- [x] 后续邮箱登录反查同一 external subject，追加邮箱身份并补全邮箱。
- [x] 既有两个人员冲突时不自动合并。

**并发：**

- [x] 远端解析在事务外完成，证据带来源和快照版本。
- [x] 事务内重读来源、成员、身份和人员状态。
- [x] 依靠数据库唯一约束和可重试事务处理邮箱与扫码并发首次登录。
- [x] `principal_id` 对无邮箱 JIT 人员使用内部生成的不可猜测稳定 ID，不使用邮箱或供应商显示名。

## 8. Task 5：对账基线与来源模式

**主要文件：**

- 修改：`src/directory-sources/directory-source-service.ts`
- 修改：`src/directory-sources/directory-sync-engine.ts`
- 修改：`src/api/routes/admin/directory-sources.ts`
- 修改：`plugins/admin/public/index.html`
- 修改：`plugins/admin/src/index.ts`
- 修改：`plugins/admin/test/org-users.test.ts`
- 修改：`test/directory-source-routes.test.ts`
- 修改：`test/directory-sources.test.ts`

**工作：**

- [x] 现有来源迁移为 `identity_only`，JIT 默认关闭。
- [x] 来源创建和编辑支持两种模式。
- [x] `managed_directory` 只在组织单元和成员关系能力可用时可选。
- [x] 同组织第二个托管来源返回冲突。
- [x] 生成全组织已验证企业邮箱对账基线。
- [x] 待处理、临时错误或冲突存在时 JIT 不可启用。
- [x] 配置、租户、凭据、能力、成员快照或模式变化使基线失效。
- [x] Admin 展示对账完成度、新鲜度、JIT 开关和阻塞原因。
- [x] 模式切换和 JIT 开关使用 revision CAS 并审计。

## 9. Task 6：组织单元快照与差异预览

**主要文件：**

- 修改：`src/directory-sources/provider.ts`
- 修改：`src/directory-sources/providers/wecom.ts`
- 修改：`src/directory-sources/directory-source-store.ts`
- 修改：`src/directory-sources/postgres-directory-source-store.ts`
- 修改：`src/directory-sources/directory-sync-engine.ts`
- 新建：`src/directory-sources/managed-directory-service.ts`
- 修改：`src/api/routes/admin/directory-sources.ts`
- 修改：`test/directory-sources.test.ts`
- 修改：`test/postgres-directory-source-store.test.ts`

**企业微信：**

- [x] 使用 `department/simplelist` 获取可见部门 ID、父 ID 和排序。
- [x] 使用 `department/get` 获取单部门详情和名称。
- [x] 无法取得真实名称时将能力标记为资料不完整，禁止无提示提交托管预览。
- [x] 只同步应用可见范围，不把不可见误判为离职或删除。

**预览：**

- [x] 计算组织节点新增、改名、移动、归档。
- [x] 计算人员新增、资料更新、暂停和恢复。
- [x] 计算主部门和兼任关系新增、更新、移除。
- [x] 列出同名手工节点、身份冲突和资料不完整项。
- [x] 预览持久化并绑定来源 revision 与快照 revision。
- [x] 预览只读，过期后不可提交。

## 10. Task 7：托管组织目录提交

**主要文件：**

- 修改：`src/directory-sources/managed-directory-service.ts`
- 修改：`src/organization/organization-store.ts`
- 修改：`src/organization/postgres-organization-store.ts`
- 修改：`src/organization/organization-service.ts`
- 修改：`src/api/routes/admin/directory-sources.ts`
- 修改：`test/organization-service.test.ts`
- 修改：`test/postgres-organization-store.test.ts`
- 修改：`test/directory-source-routes.test.ts`

**工作：**

- [x] 来源创建的节点记录稳定映射和所有权。
- [x] 同名手工节点必须显式映射，不自动复用。
- [x] 部门改名和移动复用已有节点。
- [x] 托管人员创建前复用 Task 4 的统一身份解析。
- [x] 来源只更新自己拥有的资料和组织关系。
- [x] 缺失字段保留现值。
- [x] 来源只删除自己拥有的部门关系，不移除 manager 关系。
- [x] 单次不完整同步不做暂停或归档。
- [x] 明确离职、临时不可见和删除分别处理。
- [x] 访问组、ACL、管理员角色和业务资源保持不变。
- [x] 切回 `identity_only` 后停止托管写入并保留现状。

## 11. Task 8：Admin 交互与演示

**主要文件：**

- 修改：`plugins/admin/public/index.html`
- 修改：`plugins/admin/src/index.ts`
- 修改：Admin 相关测试

**工作：**

- [x] 来源向导展示模式、能力和字段边界。
- [x] 来源详情展示对账、JIT、熔断和托管状态。
- [x] 托管预览按节点、人员、关系、冲突和不变数据分组。
- [x] 高风险提交要求最新预览和明确确认。
- [x] 失败提示区分能力不足、预览过期、身份冲突和供应商暂时不可用。
- [x] 使用真实感 mock 数据准备可交互 Admin 演示或截图。

## 12. Task 9：迁移、验证与交付

**迁移：**

- [x] 现有来源模式设为 `identity_only`，JIT 关闭。
- [x] 现有 source-backed 身份补齐 provider 租户唯一索引所需字段。
- [x] 现有手工绑定不被自动候选覆盖。
- [x] 已有 QM 节点和关系默认视为手工数据。

**本地验证：**

- [x] 运行目录来源、组织服务、Portal 身份和 PostgreSQL 受影响测试。
- [x] 运行 typecheck、lint 和 format check。
- [x] 使用 `dev-instance` 启动完整栈。
- [x] 在浏览器验证来源模式、对账状态、JIT 阻塞和托管预览。
- [x] 验证邮箱先登录、企业微信先登录和已绑定登录的关键路径；无法安全调用真实企业微信时使用开发适配器 fixture 验证 Core 和 Admin，明确记录 mock 边界。
- [x] 为 Admin 变化准备 live demo 或截图。

**独立审查：**

- [x] 身份唯一性、并发和 JIT 创建视角。
- [x] durable schema、迁移和多实例视角。
- [x] 托管目录字段所有权和数据损失视角。
- [x] 修复全部结论后重新运行对应测试。

## 12.1 执行结果

- 通用 provider 能力契约、企业微信企业邮箱反查、持久化对账、双向身份关联、JIT、两种来源模式、组织单元快照和托管提交均已落地；钉钉、飞书和 Slack 仍只保留适配器扩展边界。
- 身份自动关联要求已验证邮箱证据绑定到精确邮箱值，并要求服务端签名断言显式携带可信企业邮箱标记。
- 来源更新、暂停、删除和登录最终事务共用来源级互斥；并发暂停覆盖已有绑定和 JIT 首次创建，状态变更后的会话失效持久化且幂等。
- 托管预览绑定来源、快照、组织、身份、成员和映射指纹，支持完整分页、提交恢复、旧代预览隔离和来源所有权保护。
- 本地验证通过：Core 受影响测试 178 项、插件测试 80 项、PostgreSQL 目录来源测试 8 项，以及 typecheck、lint 和 Prettier format check。
- 使用 production-shaped dev instance 在 Admin Web 验证了“仅登录与身份绑定”“托管组织目录”、来源详情、对账/JIT 门槛和托管预览入口。
- 独立审查覆盖身份/JIT、托管目录、持久化、会话失效和并发竞态；发现项均已修复并补充回归测试。

## 13. 完成定义

- 两种登录顺序均最终产生一个 canonical 人员和多个身份。
- 企业微信邮箱反查受持久化缓存、错误预算、退避和熔断保护。
- 已绑定用户不因反查服务异常失去登录能力。
- 来源模式和 JIT 均显式配置，现有来源升级后行为不突变。
- 托管模式能稳定同步可见组织树、人员和主兼任关系。
- 所有破坏性目录变化都有最新预览、来源所有权和审计依据。
- Core 不包含企业微信专用业务分支，企业微信只通过 adapter 接入。
- 钉钉、飞书和 Slack 未实现，但以后接入不需要改变 canonical 人员和身份规则。
- 受影响测试、typecheck、lint、format、live QA 和独立审查全部通过。
