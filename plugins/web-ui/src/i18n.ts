import { html as litHtml, type TemplateResult } from "lit";

export type AppLocale = "en" | "zh-CN";

export const LOCALE_KEY = "qm:locale";

const ZH: Record<string, string> = {
  "What should I change?": "需要我修改什么？",
  "Summarize this email": "总结这封邮件",
  "What should I follow up on?": "有哪些事项需要跟进？",
  "Make it shorter": "写得更简短",
  "Make it more friendly": "语气更亲切",
  "Remove the salutations": "去掉问候语",
  "Send it": "发送",
  "Sending…": "正在发送…",
  "Undoing…": "正在撤销…",
  "Checking…": "正在检查…",
  "attached image": "附加图片",
  "Generate a Slack app configuration token and copy its access token": "生成 Slack 应用配置令牌并复制其访问令牌",
  "Company access": "公司账户访问",
  "Your organization requires a personal account.": "你的组织要求使用个人账户。",
  "Use the access provided by your organization.": "使用组织提供的访问权限。",
  "Connected with your API key": "已通过你的 API 密钥连接",
  "Account disconnected.": "账户已断开连接。",
  "Account disconnected. Reconnect it or choose company access to continue chatting.":
    "账户已断开连接。请重新连接，或选择公司账户访问以继续对话。",
  "New chats will use company access.": "新对话将使用公司账户访问。",
  "Connect your AI account": "连接你的 AI 账户",
  "AI accounts": "AI 账户",
  "New chats will be billed to this API key.": "新对话将通过此 API 密钥计费。",
  "Choose who provides access for your chats on the web and in Slack. Background tasks continue using company access.":
    "选择网页和 Slack 对话的账户来源。后台任务继续使用公司账户访问。",
  "App created. No more token copying needed.": "应用已创建，无需再复制令牌。",
  "Approval denied": "审批已拒绝",
  "Approved once": "已批准一次",
  "Approved for this session": "已批准本会话",
  "Approved always": "已始终批准",
  Approved: "已批准",
  deleted: "已删除",
  edited: "已编辑",
  "Send reply": "发送回复",
  "Nothing is waiting on you. Clear water ahead.": "目前没有待你处理的事项。",
  "No items yet. Set up sync and the agent will surface everything waiting on a reply, drafted and ready.":
    "暂无事项。设置同步后，智能体会整理待回复内容并准备草稿。",
  "Copied ✓": "已复制 ✓",
  "Click to copy": "点击复制",
  "Use my subscription instead": "改用我的订阅",
  "Use an API key instead": "改用 API 密钥",
  "In use": "使用中",
  "Use account": "使用此账户",
  "Using a personal account. Choose a connected provider below.": "正在使用个人账户。请在下方选择已连接的提供商。",
  "Or use your own account. Connect a provider, then choose Use account.":
    "也可以使用自己的账户。连接提供商后选择“使用此账户”。",
  "Saving changes…": "正在保存更改…",
  "Account connected. Choose Use account to use it for your chats.": "账户已连接。选择“使用此账户”即可用于对话。",
  "Loading sent mail…": "正在加载已发送邮件…",
  "No sent emails in this account.": "此账户暂无已发送邮件。",
  "Anyone in your organization": "组织内的任何人",
  "Connection problem": "连接问题",
  "Couldn't load conversation": "无法加载对话",
  "Conversation not found": "未找到对话",
  "Something went wrong loading this conversation. Please try again.": "加载对话时出错，请重试。",
  "This conversation may have been deleted, or you may be signed into an account that doesn’t have access.":
    "此对话可能已被删除，或你当前登录的账户没有访问权限。",
  "Slack setup status is unavailable.": "暂时无法获取 Slack 设置状态。",
  "Checking Slack setup…": "正在检查 Slack 设置…",
  "Review the workspace and choose Allow.": "检查工作区后选择“允许”。",
  "Submit the token first, then choose Allow in Slack.": "先提交令牌，再在 Slack 中选择“允许”。",
  "Refreshing…": "正在刷新…",
  "Generic HMAC-SHA256": "通用 HMAC-SHA256",
  "Send the digest in X-Signature as hex or sha256=<hex>.": "在 X-Signature 中以十六进制或 sha256=<hex> 格式发送摘要。",
  "Use this URL as the payload URL and the signing secret as GitHub's webhook secret.":
    "将此 URL 用作负载 URL，并将签名密钥设为 GitHub 的 Webhook 密钥。",
  "Use the Slack app signing secret. Requests older than five minutes are rejected.":
    "使用 Slack 应用签名密钥。超过五分钟的请求会被拒绝。",
  "Use the endpoint signing secret shown by Stripe for this destination.": "使用 Stripe 为此目标显示的端点签名密钥。",
  "Use the webhook signing secret shown by Linear. Payloads older than one minute are rejected.":
    "使用 Linear 显示的 Webhook 签名密钥。超过一分钟的负载会被拒绝。",
  "Invalid filters.": "筛选条件无效。",
  "create failed": "创建失败",
  "Extra high": "极高",
  Ultracode: "超强编码",
  "Sync paused": "同步已暂停",
  "First sync pending": "等待首次同步",
  "Set up sync": "设置同步",
  "Setting up…": "正在设置…",
  Sync: "同步",
  "Syncing…": "正在同步…",
  "Refreshing will replace this draft with the latest memory. Copy anything you want to keep before continuing.":
    "刷新会用最新记忆替换此草稿。继续前请复制需要保留的内容。",
  "The selected notebook will become current. The version you have now remains available in history.":
    "所选记忆本将成为当前版本。现有版本仍可在历史记录中查看。",
  Home: "首页",
  Search: "搜索",
  "Create New Chat": "新建对话",
  "Import preserves instructions, scripts, references and binary assets inside each skill directory.":
    "导入会保留每个技能目录中的指令、脚本、参考文件和图片等二进制资源。",
  "No skills available to import": "没有可导入的技能",
  "All skills are unavailable. Check the reasons below, choose another file or source, then preview again.":
    "当前技能均不可导入。请查看下方原因，重新选择文件或来源后再次预览。",
  "Select at least one available skill.": "请至少勾选一个可导入的技能。",
  "This skill has unreadable files or unsafe paths.": "此技能包含无法读取的文件或不安全路径。",
  "Preview again": "重新预览",

  "Skill source": "技能来源",
  "Project URL": "项目 URL",
  "Upload file or archive": "上传文件或压缩包",
  "Write manually": "手动编写",
  "Skill file or archive": "技能文件或压缩包",
  "Import reusable skills from a project or upload.": "从项目或上传文件导入可复用的技能。",
  "Use an HTTPS Git repository containing one or more SKILL.md files.":
    "填写包含一个或多个 SKILL.md 文件的 HTTPS Git 仓库地址。",
  "Branch, tag or commit (optional)": "分支、标签或提交（可选）",
  "ZIP, tar.gz, tgz, tar or Markdown · maximum 8 MiB": "ZIP、tar.gz、tgz、tar 或 Markdown，最大 8 MiB",
  "Import preserves instructions, text scripts and reference files inside each skill directory. Binary assets are not supported.":
    "导入会保留每个技能目录中的指令、文本脚本和参考文件，暂不支持二进制资源。",
  "Review skills before importing": "导入前审阅技能",
  "Selected skills will be published to the context above. Review the instructions and files before confirming.":
    "选中的技能将发布到上方所选上下文。请在确认前审阅指令和文件。",
  "No SKILL.md files found.": "未找到 SKILL.md 文件。",
  "Instructions and files": "指令和文件",
  "Confirm import": "确认导入",
  "Preview skills": "预览技能",
  "Choose a file of at most 8 MiB.": "请选择不超过 8 MiB 的文件。",
  "Failed to import skills.": "导入技能失败。",
  "A skill with this name already exists in this context.": "此上下文已存在同名技能。",
  "Multiple skills in this source use the same name.": "此来源中有多个技能使用相同名称。",
  "This skill contains unsupported binary files or unsafe paths.": "此技能包含暂不支持的二进制文件或不安全路径。",
  "Invalid skill name or empty instructions.": "技能名称无效或指令为空。",
  "Private skills cannot be imported into a shared context.": "私有技能不能导入共享上下文。",
  "This skill declares a personal scope.": "此技能声明为个人范围。",
  "Choose a skill file or archive.": "请选择技能文件或压缩包。",
  "ZIP, tar.gz, tgz, tar or Markdown · maximum 8 MiB. Browse and select skills after uploading. Binary assets are not supported.":
    "支持 ZIP、tar.gz、tgz、tar 或 Markdown，最大 8 MiB。上传后浏览并选择要导入的技能，暂不支持二进制资源。",

  "Access group": "访问组",
  "Access mode": "访问模式",
  "all active organization users": "组织内所有活跃用户",
  at: "时间",
  "Authorized subjects": "授权主体",
  "Change preview": "变更预览",
  "Changes are recorded in Audit.": "变更会记录到审计日志中。",
  "current members of the home context": "所属上下文的当前成员",
  "Effective active users": "实际可用的活跃用户",
  "Entire organization": "整个组织",
  "Enter at least two characters to search for a person.": "请至少输入两个字符来搜索人员。",
  "Failed to update Skill Access.": "无法更新技能访问权限。",
  "Find a person": "查找人员",
  "Home context": "所属上下文",
  "Last updated by": "最后更新人",
  "No active user will be able to use this Skill.": "没有任何活跃用户能够使用此技能。",
  "No visible directory subjects.": "没有可见的组织目录主体。",
  "Couldn't search for people.": "无法搜索人员。",
  "Organization unit": "组织单元",
  Person: "人员",
  Revision: "修订版",
  "Reload the page before retrying.": "重试前请重新加载页面。",
  "Save access": "保存访问权限",
  "Saving access…": "正在保存访问权限…",
  "Search people": "搜索人员",
  "Selected people and groups": "指定人员和组",
  "Skill Access": "技能访问权限",
  "The current policy was reloaded.": "已重新加载当前策略。",
  "Unavailable for this home context": "此所属上下文暂无法统计",
  "Use permission is separate from this Skill's home context and management permission.":
    "使用权限独立于技能的所属上下文和管理权限。",
  "will be evaluated at use time.": "会在使用时实时计算。",
  Admin: "管理",
  agent: "智能体",
  "another conversation": "另一个对话",
  "Ask QM to find it:": "让 QM 帮你查找：",
  "ask QM in a new chat": "在新对话中询问 QM",
  "A small pinned message in the Slack channel naming the model in use.":
    "在 Slack 频道中置顶一条简短消息，显示当前使用的模型。",
  "Couldn't load the pinned header setting.": "无法加载置顶消息设置。",
  "Couldn't update the pinned header setting.": "无法更新置顶消息设置。",
  Failed: "失败",
  "Focus over the grid": "聚焦显示",
  fork: "分支",
  "Forked from": "分支来源",
  "Back to this chat": "返回此对话",
  "Header pinned in the channel.": "已在频道中置顶消息。",
  "Inherit future defaults": "继承未来的默认设置",
  "Keep mine": "保留我的设置",
  "Loading runtime settings…": "正在加载运行时设置…",
  "No messages match": "没有匹配的消息",
  navigate: "导航",
  "Nothing running can take this — it will go out as its own turn": "当前没有可接收此消息的任务——它将作为独立轮次发送",
  "Open project": "打开项目",
  "open chat": "打开对话",
  open: "打开",
  "open the original": "打开原始对话",
  "Preparing files...": "正在准备文件…",
  "Pinned header": "置顶消息",
  "Pinned header removed.": "已移除置顶消息。",
  "Pinned Slack header for this channel": "此频道的 Slack 置顶消息",
  "Private channel": "私有频道",
  "Preparing QR code…": "正在准备二维码…",
  "Preparing chat channel setup…": "正在准备聊天频道接入…",
  "Queue a message for after this turn…": "输入要在本轮结束后发送的消息…",
  "Queue for after this turn": "在本轮结束后发送",
  Queued: "已排队",
  "Queued messages": "已排队消息",
  "Refresh conversations": "刷新对话",
  "Remove queued message": "移除已排队消息",
  "Restore to grid (Esc)": "恢复网格（Esc）",
  Retry: "重试",
  "Search every chat you can see — messages, not just titles.": "搜索你可见的所有对话——不只搜索标题，也搜索消息。",
  "Search failed — check the connection and try again.": "搜索失败——请检查连接后重试。",
  "Search your chats": "搜索对话",
  "Search your chats…": "搜索对话…",
  "Setup guide": "接入文档",
  "WeChat QR setup": "微信扫码连接",
  "Scan to create or bind a bot": "扫码创建或绑定机器人",
  "Manual fallback": "手动兜底配置",
  "Manual credential setup": "手动凭证配置",
  "Required credentials": "需要准备",
  "Bind an existing Bot": "绑定已有机器人",
  "Verify and bind": "验证并绑定",
  "Platform credentials could not be verified.": "平台凭据验证失败。",
  "Open provider console": "打开平台控制台",
  "No QR code is used for this channel.": "这个频道不使用网页二维码。",
  "Quick scan setup is temporarily unavailable.": "快捷扫码当前不可用，请重试或手动绑定已有 Bot。",
  "Provisioning QR code": "创建机器人二维码",
  "Waiting for bot authorization": "等待机器人绑定并完成授权",
  "Create a new WeCom Bot": "创建新的企业微信机器人",
  "Retry connection": "重试连接",
  "Follow the setup guide for this channel.": "请按该频道的接入文档完成配置。",
  Sessions: "会话",
  "Show full command": "显示完整命令",
  Steer: "调整任务",
  "Steer the running task with this instead of waiting": "用这条消息调整正在运行的任务，而不是等待",
  "starts a new chat where QM hunts down the matching session and links it": "新建对话，让 QM 查找匹配的会话并提供链接",
  Stop: "停止",
  "The org now recommends": "组织现在推荐",
  "Use the matching app to scan this QR code.": "请用对应 App 扫描二维码。",
  "Turning it on posts and pins the header; turning it off unpins and removes it. Default follows the org-wide setting. Model changes edit the pinned message in place.":
    "开启后会发布并置顶消息；关闭后会取消置顶并删除消息。默认值跟随组织设置，模型变化时会直接更新置顶消息。",
  Tools: "工具",
  "Triggered by": "触发规则",
  Upgrade: "升级",
  "Untitled chat": "未命名对话",
  Why: "原因",
  Worked: "已工作",
  "(default timezone)": "（默认时区）",
  "(no action)": "（无操作）",
  "(no output yet)": "（暂无输出）",
  "(untitled cron)": "（未命名定时任务）",
  "Access revoked ✓": "已撤销访问权限 ✓",
  "Act immediately": "立即执行",
  "Active only": "仅显示使用中",
  "Active access": "有效访问",
  Active: "使用中",
  All: "全部",
  "All contexts": "所有上下文",
  "All files": "所有文件",
  "All types": "所有类型",
  "Upload to": "上传到",
  "Allow always": "始终允许",
  "Allow for session": "本会话允许",
  "Allow once": "允许一次",
  "Already open in a pane": "已在窗格中打开",
  "Another keychain change is still in progress.": "另一项密钥链更改仍在进行中。",
  "Could not refresh MCP tools.": "无法刷新 MCP 工具。",
  "Approval needed": "需要审批",
  "Approve or deny to continue": "请批准或拒绝后继续",
  "Archive skill": "归档技能",
  "Archiving…": "正在归档…",
  "Archiving deployment…": "正在归档部署…",
  "Ask anything": "输入任何问题",
  "Ask the agent to set it up": "让智能体帮我设置",
  "Accounts and credentials your agent may use on your behalf.": "智能体可代表你使用的账户和凭据。",
  "Automated posters": "自动发布者",
  "Ambient behavior": "环境行为",
  Apps: "应用",
  Archive: "归档",
  Archived: "已归档",
  Auto: "自动",
  "Back to admin": "返回管理端",
  "Back to skills": "返回技能",
  "Background activity": "后台活动",
  "Batch updates": "批量更新",
  "Binding complete": "绑定完成",
  "Find Bot in IM": "在 IM 中找到 Bot",
  "Locator message queued. Open the IM app to find your Bot.": "定位消息已提交，请打开 IM 查看你的 Bot。",
  "Open this Bot once in the IM app to enable locator messages.":
    "平台未返回扫码人的会话 ID，请先在 IM 中打开该 Bot 建立一次会话。",
  "Binding QR code": "绑定二维码",
  "Waiting for platform authorization": "等待平台授权",
  "Bot name": "机器人名称",
  Bound: "已绑定",
  Enterprise: "企业",
  Browse: "浏览",
  "Can manage": "可管理",
  "Can view": "可查看",
  Cancel: "取消",
  Loading: "加载中",
  "Agent is working": "智能体正在工作",
  Channel: "频道",
  "Channels & messages": "频道和消息",
  "Chat channels": "聊天频道",
  Chats: "对话",
  Close: "关闭",
  "Close pane": "关闭窗格",
  "Close sidebar": "关闭侧边栏",
  "Clone or push a new version with this short-lived authenticated URL.": "使用此短期有效的认证 URL 克隆或推送新版本。",
  "Clone source with this short-lived read-only authenticated URL.": "使用此短期有效的只读认证 URL 克隆源码。",
  "Color scheme: light / dark / system": "颜色模式：浅色 / 深色 / 跟随系统",
  "Color row": "设置行颜色",
  "Clear color": "清除颜色",
  "Connect account": "连接账户",
  "Connected accounts": "已连接账户",
  Conversations: "对话",
  Connectors: "连接器",
  Continue: "继续",
  context: "上下文",
  Conversation: "对话",
  "Conversation options": "对话选项",
  Copied: "已复制",
  "Connect chat channel": "接入聊天频道",
  "Connected chat channels": "已接入",
  "Setup in progress": "接入中",
  "Available chat platforms": "可接入",
  "No connected chat channels.": "暂无已接入平台。",
  "Continue setup": "继续接入",
  "Start setup": "开始接入",
  "Rebind existing Bot": "重新绑定已有 Bot",
  "Bind a new Bot": "换绑新的 Bot",
  Unbind: "解绑",
  "Unbind this chat channel? The existing platform Bot will be kept for reuse.":
    "确认解绑这个聊天频道？平台中已创建的 Bot 会保留，之后可以直接重新绑定。",
  "WeChat verification code": "微信验证码",
  Verify: "校验",
  "Generate a new QR code": "重新生成二维码",
  Contexts: "上下文",
  "Context settings": "上下文设置",
  "Core returned an invalid project": "核心服务返回了无效项目",
  "Couldn't link that channel — you must be a member of it.": "无法关联该频道——你必须是该频道的成员。",
  "Couldn't unlink the channel.": "无法取消关联该频道。",
  "Could not attach that file.": "无法附加该文件。",
  "Could not create the binding QR code.": "无法创建绑定二维码。",
  "Could not start chat channel setup.": "无法开始聊天频道接入。",
  "Could not authorize WeCom bot.": "无法创建或绑定企业微信智能机器人。",
  "Could not send the Bot locator message.": "无法发送 Bot 定位消息。",
  "WeCom authorization window was blocked.": "企业微信授权窗口被浏览器拦截，请允许弹窗后重试。",
  "Discard the saved Bot credentials and create a new Bot?": "放弃已保存的机器人凭据并重新创建机器人？",
  "Could not discard the saved Bot.": "无法放弃旧机器人。",
  "Discard old Bot and create again": "放弃旧机器人并重新创建",
  "Could not create the one-time page.": "无法创建一次性页面。",
  "Could not delete the key.": "无法删除密钥。",
  "Could not disconnect.": "无法断开连接。",
  "Could not load chat channel bindings.": "无法加载聊天频道绑定。",
  "Could not unbind chat channel.": "无法解绑聊天频道。",
  "Could not verify WeChat code.": "无法校验微信验证码。",
  "Could not revoke access.": "无法撤销访问权限。",
  "Could not start the connector.": "无法启动连接器。",
  "Could not deliver the message — the running task ended mid-send. It is back in the composer.":
    "无法送达消息——正在运行的任务在发送途中结束。消息已返回编辑器。",
  "Could not deliver the message — the running task never settled. It is back in the composer.":
    "无法送达消息——正在运行的任务始终未完成。消息已返回编辑器。",
  "No available models": "暂无可用模型",
  "No compatible model is configured. Ask an administrator to configure a model provider.":
    "尚未配置兼容模型，请联系管理员配置模型供应商。",
  "Could not load runtime settings.": "无法加载运行时设置。",
  "Could not send message.": "无法发送消息。",
  "Could not start the conversation.": "无法开始对话。",
  Capabilities: "能力",
  "Custom color (RGB picker)": "自定义颜色（RGB 选择器）",
  "Custom row color": "自定义行颜色",
  "Couldn't change the model — try again.": "无法更改模型——请重试。",
  "Couldn't load this project's model.": "无法加载此项目的模型。",
  "Couldn't create that project.": "无法创建该项目。",
  "Couldn't load this conversation. Check your connection and click it again.":
    "无法加载此对话。请检查网络连接后重新点击。",
  "Couldn't save — try again.": "无法保存——请重试。",
  "Create project": "创建项目",
  "Cron updated.": "定时任务已更新。",
  "Copy link": "复制链接",
  "Create skill": "创建技能",
  "Creating…": "正在创建…",
  "Created here": "在此创建",
  Created: "已创建",
  Current: "当前",
  Crons: "定时任务",
  "Default model for this project": "此项目的默认模型",
  "Default (on when standing orders are set)": "默认（设置长期指令时启用）",
  "Delete this cron? This can't be undone.": "删除此定时任务？此操作无法撤销。",
  "Delete this skill? This can't be undone.": "删除此技能？此操作无法撤销。",
  "Delete credential": "删除凭据",
  Delete: "删除",
  Deployments: "部署",
  "Deploy with Agent": "使用智能体部署",
  "Deployment time unavailable": "无法获取部署时间",
  "Direct message": "私信",
  Disable: "禁用",
  Documents: "文档",
  "Discard and refresh": "放弃并刷新",
  "Discard unsaved memory changes?": "放弃未保存的记忆更改？",
  "Disconnect account": "断开账户连接",
  "Display name": "显示名称",
  "Drag to resize · double-click to reset": "拖动调整大小 · 双击重置",
  DingTalk: "钉钉",
  "Drop files": "拖入文件",
  "Drop files here or choose files": "将文件拖到此处或选择文件",
  "Batch into one message": "合并为一条消息",
  "Enter a project name.": "请输入项目名称。",
  "Enter at least two characters.": "请至少输入两个字符。",
  "Edit notebook": "编辑笔记本",
  Edit: "编辑",
  "Edit /": "编辑 /",
  Editing: "编辑中",
  "Encrypted at rest": "已加密存储",
  Expired: "已过期",
  Enable: "启用",
  Enter: "确定",
  Effort: "思考强度",
  WeCom: "企业微信",
  "Facts view": "事实视图",
  "Facts the agent carries into your conversations.": "智能体会带入对话的事实。",
  Fast: "快速",
  "Fast mode": "快速模式",
  "Fast mode active": "快速模式已启用",
  "Fast mode is only available on Opus models": "快速模式仅适用于 Opus 模型",
  Files: "文件",
  "Files created, uploaded, or shared with you": "由你创建、上传或与你共享的文件",
  "Files & folders": "文件和文件夹",
  Feishu: "飞书",
  "Attach files": "添加附件",
  "Following the org default — it changes when the org's does.": "跟随组织默认值——组织设置更改时会同步更改。",
  "Filter skills by scope": "按范围筛选技能",
  "Filter skills by source": "按来源筛选技能",
  "Finished step": "已完成步骤",
  "Focus this pane over the grid": "聚焦此窗格",
  Group: "群组",
  Harness: "调度器",
  High: "高",
  Ignore: "忽略",
  Images: "图片",
  "Gmail, Calendar, Drive, Sheets": "Gmail、日历、云端硬盘、表格",
  "Google Workspace": "Google Workspace",
  "Group DM": "群组私信",
  "Hi — I'm your AI teammate 👋": "你好——我是你的 AI 队友 👋",
  "I run tasks on a computer of my own and work across your connected tools — Slack, Google Workspace, GitHub, Linear, and the open web — and I remember what we work on together.":
    "我会在自己的计算机上执行任务，并使用你已连接的工具——Slack、Google Workspace、GitHub、Linear 和开放网络；我也会记住我们共同完成的工作。",
  "Want to get set up? Tell me your name and what you're working on, and I'll take it from there — or just ask me anything to dive straight in.":
    "想先完成设置？告诉我你的名字和正在处理的工作，我会接着协助你；也可以直接提问，马上开始。",
  "Instructions unavailable.": "指令不可用。",
  "Just you — your web chats and DMs with the agent live here.": "仅你可见——你与智能体的 Web 对话和私信保存在此。",
  "Hide background activity": "隐藏后台活动",
  "Hide disabled": "隐藏已禁用项",
  Hide: "隐藏",
  "Hide non-web conversations": "隐藏非 Web 对话",
  "Hide output": "隐藏输出",
  "Hide sidebar": "隐藏侧边栏",
  "Interrupted — resuming…": "已中断——正在恢复…",
  "Issues & projects": "问题和项目",
  Keychain: "密钥链",
  "Load more": "加载更多",
  "Loading apps…": "正在加载应用…",
  "Loading conversations…": "正在加载对话…",
  "Loading conversations...": "正在加载对话…",
  "Loading crons…": "正在加载定时任务…",
  "Loading earlier messages…": "正在加载更早的消息…",
  "Loading files…": "正在加载文件…",
  "Failed to load all matching files.": "无法加载所有匹配的文件。",
  "Failed to load background activity.": "无法加载后台活动。",
  "Failed to load connectors.": "无法加载连接器。",
  "Failed to load files.": "无法加载文件。",
  "Failed to load more files.": "无法加载更多文件。",
  "Failed to load stored keys.": "无法加载已存储的密钥。",
  "Loading instructions…": "正在加载指令…",
  "Loading output…": "正在加载输出…",
  "Loading projects…": "正在加载项目…",
  Link: "关联",
  "Link a channel": "关联频道",
  "Loading runtime…": "正在加载运行时…",
  "Loading skill instructions…": "正在加载技能指令…",
  "Loading skills…": "正在加载技能…",
  "Loading your keychain…": "正在加载密钥链…",
  "It will immediately revoke": "将立即撤销",
  "It will also stop": "还将停止",
  "Managed process": "已管理进程",
  "Managing process": "正在管理进程",
  Memory: "记忆",
  "Memory changed in another conversation. Your draft is still here; copy it if needed, then refresh to merge with the latest version.":
    "记忆已在另一个对话中发生变化。你的草稿仍保留在此；如有需要请先复制，然后刷新以合并最新版本。",
  Low: "低",
  Max: "最高",
  Medium: "中",
  Message: "消息",
  Model: "模型",
  Name: "名称",
  "Needs your approval": "需要你批准",
  Never: "从未",
  "Never fired": "从未触发",
  "New chat": "新建对话",
  "New cron": "新建定时任务",
  "New project": "新建项目",
  New: "新建",
  "New session": "新建会话",
  "New skill": "新建技能",
  "No audited use yet": "暂无已审计使用记录",
  "No active crons.": "暂无启用的定时任务。",
  "No authorization URL was returned.": "未返回授权 URL。",
  "Service and purpose are required.": "服务名称和用途为必填项。",
  "No apps in this context.": "此上下文中暂无应用。",
  "No apps match your search.": "没有匹配搜索条件的应用。",
  "No apps of your own yet.": "你还没有自己的应用。",
  "No apps shared with you.": "暂无共享给你的应用。",
  "No conversations match.": "没有匹配的对话。",
  "No conversations yet — start a new chat.": "暂无对话——请开始新对话。",
  "No conversations yet.": "暂无对话。",
  "No crons in this context.": "此上下文中暂无定时任务。",
  "No crons shared with you.": "暂无共享给你的定时任务。",
  "No crons yet.": "暂无定时任务。",
  "No files match these filters.": "没有匹配筛选条件的文件。",
  "No files yet. Upload one here or ask the agent to create one.": "暂无文件。可在此上传，或让智能体创建。",
  "No bots added. All bot posts are treated as activity.": "尚未添加机器人。所有机器人发布的消息都会视为活动。",
  Navigation: "导航",
  "No accounts available": "暂无可用账户",
  "No projects match your search.": "没有匹配搜索条件的项目。",
  "No projects yet.": "暂无项目。",
  "No remembered facts match this search.": "没有匹配搜索条件的记忆事实。",
  "No skills available yet.": "暂无可用技能。",
  "No recorded access": "暂无访问记录",
  "None required": "无需操作",
  "Pending requests": "待处理请求",
  Newest: "最新",
  Older: "较旧",
  Oldest: "最旧",
  "Open full screen": "全屏打开",
  "Open here": "在此打开",
  "Open IM channel settings": "打开 IM 频道设置",
  "Open in Slack": "在 Slack 中打开",
  Organization: "组织",
  "Org default": "组织默认值",
  "Inherited default": "继承的默认值",
  "Following organization unit and access group defaults.": "跟随组织架构组和访问组的默认值。",
  Other: "其他",
  Ownership: "所有权",
  "Pages & databases": "页面和数据库",
  "Personal — only you": "个人——仅你可见",
  Personal: "个人",
  Pin: "置顶",
  Pinned: "已置顶",
  Project: "项目",
  Projects: "项目",
  People: "成员",
  Published: "已发布",
  Publishing: "正在发布",
  "Pick a conversation, or start a new chat.": "选择一个对话，或开始新对话。",
  "Posts & profile": "帖子和个人资料",
  "Previous 30 days": "过去 30 天",
  "Previous 7 days": "过去 7 天",
  "Preparing…": "正在准备…",
  "Refreshing MCP tools…": "正在刷新 MCP 工具…",
  "Project settings": "项目设置",
  "Project options": "项目选项",
  QQ: "QQ",
  "Pinned for this project. Anyone in a chat can still pick a different model for that conversation.":
    "已为此项目固定。对话中的任何人仍可为该对话选择其他模型。",
  "Publish change": "发布更改",
  "Publish skill": "发布技能",
  "Ran command": "已运行命令",
  "Read file": "已读取文件",
  "Reading file": "正在读取文件",
  "Refresh title": "刷新标题",
  "Refreshing title": "正在刷新标题",
  Rename: "重命名",
  "Rename conversation": "重命名对话",
  "Rename project": "重命名项目",
  "Repos, issues & PRs": "仓库、问题和 PR",
  Reconnect: "重新连接",
  "Resize sidebar": "调整侧边栏大小",
  "Restore revision": "恢复修订版",
  "Restoring deployment…": "正在恢复部署…",
  "Revision restored ✓": "已恢复修订版 ✓",
  "Revision restored ✓ History could not refresh.": "已恢复修订版 ✓，但历史记录未能刷新。",
  "Review again": "重新审查",
  "Run started. Refresh recent runs after it completes.": "运行已开始。完成后请刷新最近运行记录。",
  "Revoke access": "撤销访问权限",
  "Revoke access for": "撤销以下范围的访问权限：",
  Restore: "恢复",
  "Running command": "正在运行命令",
  "Save changes": "保存更改",
  "Saving…": "正在保存…",
  Save: "保存",
  "Saved ✓": "已保存 ✓",
  "Saved ✓ History could not refresh.": "已保存 ✓，但历史记录未能刷新。",
  "Scope variant": "范围变体",
  Details: "详情",
  "Search apps": "搜索应用",
  "Search by name or handle": "按姓名或账号搜索",
  "Search chats…": "搜索对话…",
  "Search crons": "搜索定时任务",
  "Search file names and types…": "搜索文件名和类型…",
  "Search files": "搜索文件",
  "Search projects": "搜索项目",
  "Search projects…": "搜索项目…",
  "Search skills…": "搜索技能…",
  "Describe the cron you want.": "请描述你想创建的定时任务。",
  Send: "发送",
  "Searched history": "已搜索历史记录",
  "Searched memory": "已搜索记忆",
  "Searching history": "正在搜索历史记录",
  "Searching memory": "正在搜索记忆",
  "Thinking…": "正在思考…",
  "Shared channel": "共享频道",
  "Shared context": "共享上下文",
  Shared: "已共享",
  "Shared personal space": "共享个人空间",
  "Show disabled": "显示已禁用项",
  Show: "显示",
  "Show earlier messages": "显示更早的消息",
  "Show less": "收起",
  "Show live output": "显示实时输出",
  "Show more": "显示更多",
  "Show sidebar": "显示侧边栏",
  "Showing web chats only": "仅显示 Web 对话",
  "Sign-in failed.": "登录失败。",
  "Sign out": "退出登录",
  "Signing in…": "正在登录…",
  Skills: "技能",
  Scope: "范围",
  Source: "来源",
  scope: "范围",
  source: "来源",
  "Sort apps": "应用排序",
  Sort: "排序",
  "Split down": "向下拆分",
  "Split left": "向左拆分",
  "Split right": "向右拆分",
  "Split this pane with a new session": "拆分此窗格并新建会话",
  "Split up": "向上拆分",
  "Start the chat first, then open it full screen": "请先开始对话，再全屏打开",
  "Steer the running task": "调整正在运行的任务",
  "Steer the running task (attachments stay for your next message)": "调整正在运行的任务（附件保留至下条消息）",
  "Steer the running task…": "调整正在运行的任务…",
  standing: "长期",
  This: "此项",
  "Still syncing this conversation — try again in a moment": "正在同步此对话——请稍后重试",
  "That conversation wasn't found, or you don't have access to it.": "未找到该对话，或你无权访问。",
  "That cron wasn't found, or you don't have access to it.": "未找到该定时任务，或你无权访问。",
  "The agent hasn’t noted any facts yet.": "智能体尚未记录任何事实。",
  "The model every conversation here starts on.": "此处的每个对话都会以该模型开始。",
  "This conversation is read-only here.": "此对话在这里为只读状态。",
  "This conversation lives in Slack. Replies happen there.": "此对话位于 Slack 中，请在那里回复。",
  "This chat runs in the": "此对话运行于",
  "context — the agent works with that context's files and memory, separate from your personal context.":
    "上下文中——智能体使用该上下文的文件和记忆，并与个人上下文隔离。",
  "This app is shared with a context you can access. You can open and clone it, but not change it.":
    "此应用已共享到你可访问的上下文。你可以打开和克隆，但不能修改。",
  "Read-only": "只读",
  "Timed out waiting for the agent to respond.": "等待智能体响应超时。",
  "Title and task are required.": "标题和任务为必填项。",
  "Title is required.": "标题为必填项。",
  "Switch to Chinese": "切换到中文",
  "Switch to English": "切换到英文",
  "Treat like a person": "像对待真人一样",
  Unavailable: "不可用",
  Task: "任务",
  Thinking: "正在思考",
  Today: "今天",
  Type: "类型",
  "Tried command": "已尝试命令",
  "Tried managing process": "已尝试管理进程",
  "Tried publishing": "已尝试发布",
  "Tried reading file": "已尝试读取文件",
  "Tried searching history": "已尝试搜索历史记录",
  "Tried searching memory": "已尝试搜索记忆",
  "Tried step": "已尝试步骤",
  "Tried using memory": "已尝试使用记忆",
  "Tried writing file": "已尝试写入文件",
  "URL slug": "URL 标识",
  "Unknown owner": "未知所有者",
  Unknown: "未知",
  Unarchive: "取消归档",
  Unpin: "取消置顶",
  "Unsaved changes": "有未保存的更改",
  "Used memory": "已使用记忆",
  "Using URL slug": "正在使用 URL 标识",
  "Using memory": "正在使用记忆",
  Uploaded: "已上传",
  WeChat: "微信",
  "a group DM": "群组私信",
  "a personal DM": "个人私信",
  "a Slack channel": "Slack 频道",
  "a team": "团队",
  "Version unknown": "版本未知",
  "Upload failed.": "上传失败。",
  Upload: "上传",
  "Slack conversations hidden.": "Slack 对话已隐藏。",
  "Revision history": "修订历史",
  "Revision history is unavailable for this memory store.": "此记忆存储无法提供修订历史。",
  Revoke: "撤销",
  Disconnect: "断开连接",
  "Add credential": "添加凭据",
  "Stored credentials": "已存储凭据",
  "Linked accounts": "已连接账户",
  enabled: "已启用",
  disabled: "已禁用",
  archived: "已归档",
  "Web chat": "Web 对话",
  "Web only": "仅 Web",
  "Work continuing on the agent's computer — click to inspect": "智能体正在电脑上继续工作——点击查看",
  Waiting: "等待中",
  Working: "工作中",
  "Writing file": "正在写入文件",
  "Wrote file": "已写入文件",
  "Your personal context": "你的个人上下文",
  "You no longer have access to the original conversation.": "你已无权访问原对话。",
  "You own this app or have permission to manage it.": "你拥有此应用，或具备管理权限。",
  "Your one-time page is ready.": "你的一次性页面已准备完成。",
  "Automations using it may stop working. The credential cannot be recovered.":
    "使用此凭据的自动化可能停止工作。该凭据无法恢复。",
  "access ends immediately. Automations using it may stop working.": "访问权限将立即终止。使用它的自动化可能停止工作。",
  "for this account.": "针对该账户。",
  "Automations using this account may stop working.": "使用该账户的自动化可能停止工作。",
  Yesterday: "昨天",
  You: "你",
  Yours: "我的",
  "agent is working": "智能体正在工作",
  "approval denied": "审批已拒绝",
  "automatic capture": "自动捕获",
  "first run": "首次运行",
  "just now": "刚刚",
  "never fired": "从未触发",
  "no live URL for this app": "此应用没有可用的实时 URL",
  "only you": "仅你",
  pinned: "已置顶",
  "read-only": "只读",
  "run failed": "运行失败",
  "the whole org": "整个组织",
  "this context": "此上下文",
  "this project": "此项目",
  "waiting for your reply": "等待你的回复",
  "your account": "你的账户",
  Added: "添加于",
  changed: "已更改",
  "created by": "创建者",
  Deployed: "已部署",
  Deploying: "部署中",
  Description: "描述",
  Disabled: "已禁用",
  due: "到期",
  Enabled: "已启用",
  "Everyone in this context can invoke and edit these instructions.": "此上下文中的所有人都可以调用和编辑这些指令。",
  "Everyone in this context can invoke the updated instructions.": "此上下文中的所有人都可以调用更新后的指令。",
  exit: "退出码",
  Expires: "到期时间",
  "Filter by:": "筛选：",
  first: "首次",
  group: "群组",
  hide: "隐藏",
  In: "位于",
  in: "位于",
  instructions: "指令",
  last: "上次",
  "Last used": "上次使用",
  live: "在线",
  "Loading…": "正在加载…",
  manage: "管理",
  next: "下次",
  "None of your own crons yet.": "你还没有自己的定时任务。",
  "Nothing archived.": "暂无归档内容。",
  "one-time": "一次性",
  org: "组织",
  "org-wide": "组织范围",
  owned: "拥有",
  Pack: "技能包",
  pending: "待发布",
  private: "私有",
  Publish: "发布",
  "Publish this change to": "将此更改发布到",
  read: "只读",
  run: "运行",
  Running: "运行中",
  shared: "共享",
  "Shared with everyone in this channel.": "与此频道中的所有人共享。",
  "Shared with everyone in this group conversation.": "与此群组对话中的所有人共享。",
  show: "显示",
  stopped: "已停止",
  Stopped: "已停止",
  Team: "团队",
  "The channel description in Slack names this model.": "Slack 中的频道描述会注明此模型。",
  "This edit link is missing a valid app name.": "此编辑链接缺少有效的应用名称。",
  "timed out": "已超时",
  to: "到",
  "To change the message, schedule, timezone, destination, or run mode, use the agent so it can validate the resulting behavior and permissions.":
    "要更改消息、计划、时区、目标或运行模式，请使用智能体，以便验证最终行为和权限。",
  "To change the schedule, timezone, destination, or run mode, use the agent so it can validate the resulting behavior and permissions.":
    "要更改计划、时区、目标或运行模式，请使用智能体，以便验证最终行为和权限。",
  unchanged: "未更改",
  "Working…": "处理中…",
  "any new output": "任何新输出",
  armed: "已就绪",
  "connected.": "已连接。",
  "connection failed.": "连接失败。",
  exited: "已退出",
  expiring: "即将到期",
  for: "持续",
  "interrupted — resuming…": "已中断——正在恢复…",
  "last fired": "上次触发",
  "Nothing running here anymore.": "此处已无运行中的任务。",
  "output matching": "匹配输出",
  Remove: "移除",
  started: "开始于",
  Uploading: "正在上传",
  "Uploading…": "正在上传…",
  used: "已使用",
  "Watch — wakes on": "监视——唤醒条件",
  "Add people": "添加人员",
  "Search account, email, name, or profile details": "搜索账户、邮箱、姓名或其他目录资料",
  "Agent behavior": "智能体行为",
  "Choose what this project should notice and act on.": "选择此项目中智能体应关注并采取行动的内容。",
  "Give this project a home channel on Slack — the agent will post updates there, and everyone in the channel joins the project.":
    "为此项目指定一个 Slack 主频道——智能体会在那里发布更新，频道中的所有人都会加入该项目。",
  "When off, the agent never acts on overheard messages here — it only responds to direct @mentions. Default: on only when standing orders (or an action-mode bot) are set below — otherwise mention-only.":
    "关闭后，智能体不会对这里偶然听到的消息采取行动，只响应直接 @提及。默认仅在下方设置长期指令（或行动模式机器人）时启用；否则仅响应提及。",
  "Standing orders": "长期指令",
  "Plain-language guidance for proactive work. Leave empty to respond only when addressed.":
    "用自然语言说明主动工作的指引。留空时仅在被直接提及时响应。",
  "Control how messages from bots and integrations wake the agent.": "控制机器人和集成消息如何唤醒智能体。",
  "For example: Flag anything that could delay the launch.": "例如：标记任何可能延误发布的事项。",
  On: "开启",
  Off: "关闭",
  Default: "默认",
  "Add a credential": "添加凭据",
  "Keychain summary": "密钥链摘要",
  "Provider APIs the agent can use as you.": "智能体可代表你使用的提供商 API。",
  "Your workspace has not configured any account providers yet.": "你的工作区尚未配置任何账户提供商。",
  "No stored credentials": "暂无已存储凭据",
  "Secrets stay encrypted and every use or shared grant is audited.":
    "密钥始终加密存储，每次使用或共享授权都会被审计。",
  "Active grants": "有效授权",
  "Need attention": "需要处理",
  "API keys, tokens, and files you added through the one-time page.": "你通过一次性页面添加的 API 密钥、令牌和文件。",
  "Add one without pasting a secret into chat.": "无需在对话中粘贴密钥即可添加。",
  "Create a reusable procedure for yourself or a shared context.": "为自己或共享上下文创建可复用的流程。",
  "Everyone in a shared context can invoke and edit this skill.": "共享上下文中的所有人都可以调用和编辑此技能。",
  Instructions: "指令",
  "Available to": "可用于",
  "All scopes": "所有范围",
  "All sources": "所有来源",
  "Skill packs": "技能包",
  Overrides: "覆盖项",
  "Project / group": "项目 / 群组",
  "channel name": "频道名称",
  "Slack channel to link": "要关联的 Slack 频道",
  "Slack channel": "Slack 频道",
  "Joined via the linked Slack channel": "通过已关联的 Slack 频道加入",
  "Filter by skill status": "按技能状态筛选",
  "Narrower scope takes precedence where both apply": "当多个范围同时适用时，较窄的范围优先",
  "Everyone matching is already in this project.": "所有匹配的人员已在此项目中。",
  "No longer offered": "不再提供",
  "no longer offered": "不再提供",
  "Describe what you want scheduled — what to do, how often, and where the result should go. The agent sets it up and confirms in chat; it will ask if anything is unclear. It should give the cron a short, distinctive title naming what it is for, like Gmail unread digest or GitLab CI watch.":
    "描述你希望安排的任务：做什么、多久执行一次，以及将结果发送到哪里。智能体会进行设置并在对话中确认；如有不清楚之处会询问你。它会为定时任务设置简短且易识别的标题来说明用途，例如 Gmail 未读摘要或 GitLab CI 监控。",
  "Describe what you want scheduled — what to do, how often, and where the result should go. The agent sets it up and confirms in chat; it will ask if anything is unclear. It should give the cron a short, distinctive title naming what it is for, like":
    "描述你希望安排的任务：做什么、多久执行一次，以及将结果发送到哪里。智能体会进行设置并在对话中确认；如有不清楚之处会询问你。它会为定时任务设置简短且易识别的标题来说明用途，例如",
  "Gmail unread digest": "Gmail 未读摘要",
  "GitLab CI watch": "GitLab CI 监控",
  ".": "。",
  or: "或",
  "Every weekday at 9am, summarize my unread email and DM me the highlights.":
    "每个工作日上午 9 点，汇总我的未读邮件，并通过私信发送重点内容。",
  History: "历史记录",
  "Edit the notebook directly. Switch to Facts view to search or remove individual facts. Saves are protected if the agent remembers something new while this page is open.":
    "直接编辑笔记本。切换到事实视图可搜索或删除单条事实。如果该页面打开期间智能体记住了新内容，保存操作会受到保护。",
  Captured: "记录于",
  "Search remembered facts": "搜索已记住的事实",
  "Forget this fact": "忘记这条事实",
  "Refresh projects": "刷新项目",
  Web: "网页",
  Slack: "Slack",
  Everything: "全部",
  "launch cohort": "发布批次",
  Owner: "所有者",
  "Add bot": "添加机器人",
  "Not connected": "未连接",
  "Reconnect needed": "需要重新连接",
  Refresh: "刷新",
  "Refresh keychain": "刷新密钥链",
  "MCP tools refreshed.": "MCP 工具已刷新。",
  "No MCP tools were found. Reconnect the account if this is unexpected.":
    "未发现 MCP 工具。如非预期，请重新连接该账户。",
  "Refresh memory": "刷新记忆",
  "Refresh failed:": "刷新失败：",
  expires: "到期时间",
  requested: "请求了",
  access: "访问权限",
  every: "每",
  h: "小时",
  once: "一次",
  you: "你",
  "everyone in": "以下范围内的所有人",
  "This version will stop being available to": "此版本将不再向以下对象提供：",
  "If it overrides a broader version of": "如果它覆盖了更广范围的版本：",
  "that version becomes effective. Its history and assets are kept, and you can restore it later.":
    "该版本将生效。其历史记录和资源会被保留，你可以稍后恢复。",
  "This project is ready for work": "此项目已准备好开始工作",
  "Start a conversation with New chat. Files, automations, and other work created there will stay scoped to this project.":
    "使用新建对话开始交流。在其中创建的文件、自动化和其他工作都会保留在此项目范围内。",
  "The agent's files and memory here are separate from your other contexts.":
    "这里的智能体文件和记忆与你的其他上下文相互隔离。",
  "View all": "查看全部",
  Open: "打开",
  "Close new project": "关闭新建项目窗口",
  "No matches for": "没有匹配项：",
  "Searching…": "正在搜索…",
  "Lets the agent read and act in your Gmail, Calendar, and Sheets on your behalf, and read your Drive (it can save new files there, but not edit your existing ones).":
    "允许智能体代表你读取和操作 Gmail、日历与表格，并读取云端硬盘（可在其中保存新文件，但不能编辑你现有的文件）。",
  "Lets the agent act in Slack as you — read your channels and post messages on your behalf. (To chat with the agent in Slack, just DM it — you don't need this.)":
    "允许智能体在 Slack 中代表你行动——读取你的频道并代你发布消息。（要在 Slack 中与智能体对话，只需向它发送私信，无需连接此账户。）",
  "Lets the agent read the Notion pages and databases you share with it (and edit them if you grant that access).":
    "允许智能体读取你与其共享的 Notion 页面和数据库（若你授予权限，也可编辑它们）。",
  "Lets the agent read and update your Linear issues on your behalf.": "允许智能体代表你读取和更新 Linear 问题。",
  "Lets the agent read and update your GitHub repos, issues, and PRs on your behalf.":
    "允许智能体代表你读取和更新 GitHub 仓库、问题和拉取请求。",
  "Lets the agent browse, download, and upload files in your Dropbox on your behalf, and manage shared links.":
    "允许智能体代表你浏览、下载和上传 Dropbox 文件，并管理共享链接。",
  "Lets the agent read X and post, like, and follow as you — used when an action should come from your account rather than the org's.":
    "允许智能体读取 X，并代表你发布、点赞和关注——适用于操作应来自你的账户而非组织的场景。",
  Destinations: "目的地",
  Calendar: "日历",
  "Coming soon.": "即将推出。",
  "Connect your apps": "连接你的应用",
  "Search apps…": "搜索应用…",
  Connected: "已连接",
  "Ready to use in chat": "可在对话中使用",
  "Opens in a new tab": "在新标签页打开",
  "Authorize access · New tab": "授权访问 · 新标签页",
  "App permissions": "应用权限",
  "People with access": "有权限的人员",
  "Cancel selection": "取消选择",
  "Add people by name or handle": "按姓名或账号添加人员",
  "No additional people found.": "未找到其他人员。",
  "Dismissed from inbox": "已从收件箱移除",
  Ask: "询问",
  Dismiss: "忽略",
  "Draft reply": "回复草稿",
  "See how the agent arrived at this draft": "查看智能体如何生成此草稿",
  "Open agent session": "打开智能体会话",
  "Open in": "打开位置",
  To: "收件人",
  Subject: "主题",
  Cc: "抄送",
  "A reply is drafted and ready": "回复草稿已就绪",
  Reopen: "重新打开",
  "Reply sent": "回复已发送",
  "You replied in": "你已回复于",
  Dismissed: "已忽略",
  "Inbox views": "收件箱视图",
  "Reading your inbox…": "正在读取收件箱…",
  "Couldn't load the inbox:": "无法加载收件箱：",
  "Probably resolved · no reply likely needed": "可能已解决 · 通常无需回复",
  "Reply sent.": "回复已发送。",
  "Write another reply": "再写一条回复",
  "Work ledger": "工作记录",
  "Fire now": "立即执行",
  "Ready to ship": "可以交付",
  "Needs confirmation": "需要确认",
  Playbook: "行动手册",
  "success condition": "成功条件",
  "Done when:": "完成条件：",
  Pause: "暂停",
  Autopilot: "自动执行",
  "Nothing waiting on you.": "没有等待你处理的事项。",
  "Nothing needs confirmation.": "没有待确认事项。",
  "Save playbook": "保存行动手册",
  "No items yet. Fire the loop.": "暂无事项。执行循环以开始。",
  Decided: "已决定",
  "last fire": "上次执行",
  "Continue to Claude ↗": "前往 Claude ↗",
  "Authorization code": "授权码",
  "Paste the code from Claude": "粘贴来自 Claude 的授权码",
  "Copy code to clipboard": "复制授权码",
  "Open chatgpt.com and paste it ↗": "打开 chatgpt.com 并粘贴 ↗",
  "Waiting for your approval…": "等待你批准…",
  "Connecting…": "正在连接…",
  "Sign in with": "登录方式：",
  Connect: "连接",
  "Start chatting": "开始对话",
  "Connected to Slack": "已连接到 Slack",
  "Check again": "重新检查",
  "Approve connection": "批准连接",
  "Simulate provider error": "模拟提供方错误",
  "Callback URL": "回调 URL",
  "Connection preview · No accounts are linked": "连接预览 · 尚未关联账户",
  Reset: "重置",
  "More ideas": "更多想法",
  "The easiest way to get up and running:": "最快的开始方式：",
  "Loading your available apps…": "正在加载可用应用…",
  "Ask about this email": "询问这封邮件",
  "Loading chat…": "正在加载对话…",
  "To:": "收件人：",
  "· Cc:": "· 抄送：",
  "Attachments:": "附件：",
  Sent: "已发送",
  "Open in Gmail": "在 Gmail 中打开",
  "Loading email…": "正在加载邮件…",
  "Share conversation": "分享对话",
  "Who can view": "谁可以查看",
  "Subsequent messages will not be visible unless you re-share.": "后续消息不会显示，除非你再次分享。",
  "⚠️ External. Double-check what you're sharing.": "⚠️ 外部分享。请确认分享内容。",
  "Share link": "分享链接",
  Preview: "预览",
  "Shared conversation": "已分享的对话",
  "This link is unavailable": "此链接不可用",
  "The conversation is unavailable or you may not have access.": "对话不可用，或你没有访问权限。",
  "Sidebar conversations": "侧边栏对话",
  "Web only hides the Slack channels and DMs the agent also works in.":
    "仅显示网页对话时，会隐藏智能体参与的 Slack 频道和私信。",
  "AI access": "AI 访问",
  "Use company access or your own subscription.": "使用公司提供的访问权限或你自己的订阅。",
  "Connection settings": "连接设置",
  "Org settings, people, and policy.": "组织设置、人员和策略。",
  "Open admin": "打开管理后台",
  "This conversation's workspace": "此对话的工作区",
  "Session tools": "会话工具",
  "Close session tools": "关闭会话工具",
  "New webhook": "新建 Webhook",
  Webhook: "Webhook",
  Action: "操作",
  Verification: "验证",
  "Inbound URL": "接收 URL",
  "Configure your sender (GitHub / Stripe / Slack / …) to POST events here.":
    "配置发送方（GitHub / Stripe / Slack / …），将事件 POST 到此处。",
  Filters: "筛选条件",
  "Last delivery ID": "上次投递 ID",
  "Last error": "上次错误",
  "Re-enable": "重新启用",
  "Message history": "消息历史",
  "Loading messages…": "正在加载消息…",
  "Latest 50 accepted events. Payloads show what was passed to the agent, capped at 16,000 characters. Earlier events are not backfilled.":
    "显示最近 50 条已接收事件。载荷展示发送给智能体的内容，最多 16,000 个字符；不会补录更早的事件。",
  "Open session": "打开会话",
  "No session available.": "没有可用会话。",
  "No messages recorded yet.": "尚无消息记录。",
  "Verification scheme": "验证方式",
  "Signing secret": "签名密钥",
  Generate: "生成",
  "Create webhook": "创建 Webhook",
  "Webhook created ✓": "Webhook 已创建 ✓",
  "Copy the secret now. It won't be shown again.": "请立即复制密钥，此后不会再次显示。",
  "Point your sender at this URL.": "让发送方请求此 URL。",
  "No readable messages in this conversation.": "此对话中没有可读取的消息。",
  "Copy message": "复制消息",
  "Fork conversation from here": "从这里分叉对话",
  "Drop files or folders to attach": "拖入文件或文件夹以添加附件",
  "You stopped": "你已停止",
  "Show full output": "显示完整输出",
  "Dismiss preview": "关闭预览",
  "Archive session": "归档会话",
  "Drop to make a top-level session": "拖放以设为顶层会话",
  "Clear selection": "清除选择",
  "Conversation status": "对话状态",
  "Waiting for your reply": "等待你的回复",
  "View project": "查看项目",
  "Row color": "行颜色",
  "Clear row color": "清除行颜色",
  "Color selected conversations": "为选中的对话设置颜色",
  "Clear color on selected conversations": "清除选中对话的颜色",
  "No apps match “": "没有匹配“",
  "”. Try another name.": "”的应用。请尝试其他名称。",
  "Handled (": "已处理（",
  Return: "返回",
  parked: "已暂停",
  "API key · from": "API 密钥 · 来自",
  "is ready in your workspace.": "已在你的工作区中就绪。",
  "Work with": "与",
  "where your team already talks.": "一起在团队日常交流的地方工作。",
  "Provider simulation · No account access": "提供方模拟 · 无账户访问权限",
  "This stands in for the provider’s consent page. Choose an outcome to return to":
    "此页面模拟提供方的授权页面。请选择结果并返回",
  "through the callback URL.": "的回调 URL。",
  "Back to": "返回",
  "Welcome to": "欢迎使用",
  "And welcome to": "欢迎使用",
  ", the agent harness we use to run YC.": "，我们用于运营 YC 的智能体平台。",
  "Use it to research customers and investors, fundraise, and automate the everyday work of running":
    "你可以用它研究客户和投资人、筹款，并自动处理日常运营工作：",
  "Think of it as your YC partner in a box. The more you use": "把它看作随时可用的 YC 伙伴。你使用",
  ", the more context we have, the more we can help.": "越多，我们掌握的背景就越充分，也越能帮到你。",
  ", your agent harness. Use it to research customers, build tools, and automate the everyday work of running":
    "，你的智能体平台。用它研究客户、构建工具，并自动处理日常运营工作：",
  Theme: "主题",
  Account: "账户",
  "Only an administrator of": "只有以下工作区的管理员可以设置 Slack 机器人：",
  "can set up the Slack bot.": "。",
  "The bot is installed. You can return to onboarding.": "机器人已安装。你可以返回引导页面。",
  "to Slack": "添加到 Slack",
  "Create token": "创建令牌",
  "Under App Configuration Tokens, choose Generate Token, select your workspace, and copy the access token (not the refresh token).":
    "在应用配置令牌中选择生成令牌，选择工作区，并复制访问令牌（不是刷新令牌）。",
  "Show me how": "查看操作步骤",
  "Submit token securely": "安全提交令牌",
  "Add to Slack": "添加到 Slack",
  "This token can manage other apps you own in the selected workspace. Your company owns the app":
    "此令牌可以管理你在所选工作区拥有的其他应用。你的公司拥有应用",
  "creates.": "创建的内容。",
  "Check progress": "查看进度",
  "You can retry the existing links.": "你可以重试现有链接。",
  "(what the agent should do for each event)": "（智能体应如何处理每个事件）",
  "(leave blank to auto-generate)": "（留空以自动生成）",
  "(optional; one per line as": "（可选；每行一项，格式为",
  "The event runs in your personal context. After creation, ask the agent to route notable results to a teammate or channel by name.":
    "事件将在你的个人上下文中运行。创建后，可以要求智能体按名称将重要结果发送给同事或频道。",
  "Configure your sender to sign requests with this secret (scheme:": "请配置发送方使用此密钥签署请求（方式：",
  "No signing secret for scheme": "此验证方式没有签名密钥：",
  "Playground actions": "体验环境操作",
  "Cron:": "定时任务：",
  "Show full": "显示全部",
  "Replacement model": "替代模型",
  "Refresh models": "刷新模型",
  "Select a model…": "选择模型…",
  "Remove attachment": "移除附件",
  "View pasted text": "查看粘贴的文字",
  "Pasted text": "粘贴的文字",
  "Insert into message": "插入消息",
  "Edit queued message": "编辑排队中的消息",
  "Command approval": "命令批准",
  Deny: "拒绝",
  "my default": "我的默认值",
  "My default": "我的默认值",
  "Search models…": "搜索模型…",
  "Search models": "搜索模型",
  "No models found": "未找到模型",
  "Run with": "使用以下配置运行",
  "Model settings": "模型设置",
  Presets: "预设",
  "Add models": "添加模型",
  "Use org default": "使用组织默认值",
  "Default effort": "默认思考强度",
  "Cron view": "定时任务视图",
  "Enable cron": "启用定时任务",
  "Unarchive cron": "取消归档定时任务",
  "Disable cron": "停用定时任务",
  "Cron actions": "定时任务操作",
  "Edit cron": "编辑定时任务",
  "Archive cron": "归档定时任务",
  "Run now": "立即运行",
  Schedule: "计划",
  Status: "状态",
  "Next run": "下次运行",
  "Last fired": "上次触发",
  Destination: "目的地",
  "Shared from": "分享来源",
  "Recent runs": "最近运行",
  "No runs yet.": "尚无运行记录。",
  Worklog: "工作日志",
  "This permanently removes the schedule and its retained run history. Archive it instead if you may need it later.":
    "这将永久删除计划及保留的运行历史。如果将来可能需要，请改为归档。",
  "Delete permanently": "永久删除",
  "Edit behavior with agent": "与智能体一起编辑行为",
  "App view": "应用视图",
  "App status and actions": "应用状态与操作",
  Manage: "管理",
  Overview: "概览",
  "Live version": "线上版本",
  "Latest version": "最新版本",
  "Last deployed": "上次部署",
  "Last opened": "上次打开",
  "Ownership and access": "所有权与访问权限",
  "Created in": "创建于",
  "Version history": "版本历史",
  "Open app": "打开应用",
  "Copy URL": "复制 URL",
  "Loading authoritative app details…": "正在加载应用详情…",
  Permissions: "权限",
  "Created by": "创建者",
  "Git remote": "Git 远程地址",
  "Copy Git remote": "复制 Git 远程地址",
  "Shown in the app bar and app list.": "显示在应用栏和应用列表中。",
  "App URL": "应用 URL",
  "Changes the app URL. Existing links do not redirect.": "更改应用 URL 后，旧链接不会自动跳转。",
  "Restore deployment": "恢复部署",
  "Archive deployment": "归档部署",
  Live: "线上",
  Latest: "最新",
  "No version history available.": "没有可用的版本历史。",
  "Show older versions": "显示旧版本",
  "This takes the app offline immediately, so its current URL will stop working. Its source and version history are kept, and you can restore it later.":
    "这会立即使应用下线，当前 URL 将停止工作。源代码和版本历史会保留，之后可以恢复。",
  "Archive and take offline": "归档并下线",
  "Dismiss notification": "关闭通知",
  "Search memory": "搜索记忆",
  "Search resources": "搜索资源",
  "Loading resources…": "正在加载资源…",
  "Could not search:": "无法搜索：",
  ". Try searching again.": "。请重试搜索。",
  "Refine your search to see more resource matches.": "缩小搜索范围以查看更多匹配的资源。",
  "Loading this context's files, webhooks, crons, apps and skills…":
    "正在加载此上下文的文件、Webhook、定时任务、应用和技能…",
  "No skills match these filters.": "没有技能符合这些筛选条件。",
  "Clear filters": "清除筛选条件",
  "Back to chats": "返回对话",
  "Viewing the assistant as": "正在以以下身份查看助手：",
  "Exit impersonation": "退出模拟身份",
  "Dev mode": "开发模式",
  "Sign in through the portal": "通过门户登录",
  "This surface is reached through the portal, and signing in there didn't produce a session for it. Open the portal address directly rather than this one.":
    "此页面需要通过门户访问，但门户登录后没有为它建立会话。请直接打开门户地址。",
  "If you opened this surface's own address, that's the cause — it can't authenticate anyone on its own.":
    "如果你直接打开了此页面的地址，这就是原因：它无法独立验证身份。",
  "Your session ended": "会话已结束",
  "You've been signed out. Sign in again and you'll come back to this page.": "你已退出登录。重新登录后将返回此页面。",
  "You don't have access": "你没有访问权限",
  "Your account is signed in and verified — it just isn't allowed on this instance. Ask an administrator to add you.":
    "你的账户已登录并通过验证，但此实例尚未授予访问权限。请联系管理员添加你。",
  "This instance lists its principals in": "此实例的可访问账户列在",
  "We couldn't reach the assistant": "无法连接助手",
  "The service didn't respond. This is usually temporary.": "服务没有响应。这通常是暂时的问题。",
  "If this keeps happening, the core service may be down.": "如果问题持续，核心服务可能不可用。",
  "Dev sign-in": "开发环境登录",
  "No identity provider is configured, so this instance trusts a local cookie. Set":
    "尚未配置身份提供方，此实例使用本地 Cookie。设置",
  "and run the portal to use real sign-in.": "并运行门户，即可使用正式登录。",
  Principal: "账户主体",
  Now: "现在",
  "↪ steered the running task": "↪ 调整了正在运行的任务",
  "deleted their message": "删除了消息",
  "edited their message:": "编辑了消息：",
  "at least": "至少",
  Done: "完成",
  Back: "返回",
  Add: "添加",
  Pending: "待处理",
  "· expires": "· 到期时间",
  Access: "访问权限",
  "You’ll paste the secret on an encrypted one-time page next.": "接下来你将在加密的一次性页面上粘贴密钥。",
  "Your one-time page is ready": "一次性页面已就绪",
  "Open it in a new tab and paste the secret there.": "在新标签页打开并粘贴密钥。",
  "Open the one-time page": "打开一次性页面",
  Service: "服务",
  "Environment variable": "环境变量",
  optional: "可选",
  Purpose: "用途",
  "Check impact": "检查影响",
  Context: "上下文",
  Title: "标题",
  ". You can view it, but not change it.": "。你可以查看，但不能修改。",
  Settings: "设置",
  Change: "更改",
  Undo: "撤销",
  Inbox: "收件箱",
  "Try again": "重试",
  connected: "已连接",
  Opening: "正在打开",
  selected: "已选择",
  "Bot ID": "机器人 ID",
  ". You are": "。你是",
  "— no identity provider, signed in as": "— 未配置身份提供方，当前登录身份：",
  "Sign in": "登录",
  Version: "版本",
  Assets: "资源",
  "New Skills start with Home context access. After publishing, open Edit to configure Skill Access.":
    "新技能默认可以在首页上下文中使用。发布后，打开编辑以配置技能访问权限。",
  Local: "本地",
  Copy: "复制",
  "Allow custom": "允许自定义",
  "Open subagent · Drag to the sidebar to make a top-level session": "打开子智能体 · 拖到侧边栏以设为顶层会话",
  "What may the agent use this credential for?": "智能体可以将此凭据用于什么用途？",
  "Refresh keychain and discover MCP tools": "刷新密钥链并发现 MCP 工具",
  "return note…": "返回说明…",
  "Remove imported theme": "移除已导入的主题",
  "One line: what it does / when to use it": "一句话描述它的作用和使用时机",
  "The SKILL.md contents: the steps to follow when this skill is used.": "SKILL.md 内容：使用此技能时要遵循的步骤。",
  "When a GitHub issue is opened, triage it and post a one-paragraph summary.":
    "当 GitHub 问题被创建时，进行分类并发布一段摘要。",
  "auto-generated if blank": "留空则自动生成",
  "Opening Slack…": "正在打开 Slack…",
  "An action is required.": "必须填写操作。",
  Webhooks: "Webhook",
  Loops: "持续任务",
  "Group chats, files, and automations": "集中管理对话、文件和自动化任务",
  "Everything you and QM have shared": "你与 QM 共享的所有文件",
  "Work that runs on a schedule": "按计划自动运行的任务",
  "Inbound events that wake QM": "唤醒 QM 的外部事件",
  "Connected accounts and credentials": "已连接的账户和凭据",
  "What QM has shipped for you": "QM 为你发布的应用",
  "What QM remembers about your work": "QM 记住的工作信息",
  "Reusable procedures QM can follow": "QM 可执行的复用流程",
  "Standing work QM keeps pushing forward": "QM 持续推进的工作",
  "Org settings, people, and policy": "组织设置、人员和策略",
  "What can I help with?": "有什么需要我帮忙？",
  "Ahoy, what are we after?": "今天想做什么？",
  "What are we charting today?": "今天要规划什么？",
  "Where shall we set sail?": "今天从哪里开始？",
  "What's the heading, captain?": "今天要朝什么目标前进？",
  "Clarify your next priorities": "梳理下一步重点",
  "Set up a useful workspace": "搭建实用的工作空间",
  "Plan the week ahead": "规划本周工作",
  "Suggested activities": "建议活动",
  "Your keychain": "你的密钥链",
  "Search QM": "搜索 QM",
  "Search chats, skills, crons, apps…": "搜索对话、技能、定时任务和应用…",
  "No results match": "没有匹配结果：",
  "starts a new chat where QM finds the matching resource and links it": "新建对话，让 QM 查找匹配资源并提供链接",
  "System follows your device's light or dark setting. Import an iTerm2 .itermcolors or a VS Code color theme .json to paint the app with its palette.":
    "跟随系统时使用设备的深浅色设置。也可以导入 iTerm2 的 .itermcolors 或 VS Code 的主题 .json 文件。",
  Light: "浅色",
  Dark: "深色",
  System: "跟随系统",
  "Replace theme file": "替换主题文件",
  "Import theme file": "导入主题文件",
  "All conversations": "所有对话",
  Company: "公司",
  "Not signed in": "未登录",
  "Couldn't read that theme file.": "无法读取该主题文件。",
  active: "最近活动",
  "No files yet.": "暂无文件。",
  "Search webhooks": "搜索 Webhook",
  "No webhooks yet.": "暂无 Webhook。",
  "Loading webhooks…": "正在加载 Webhook…",
  "No webhooks in this context.": "此上下文中暂无 Webhook。",
  "Filter by context": "按上下文筛选",
  "Refresh my suggested activities": "刷新我的建议活动",
  "Hi there.": "你好。",
  "your company": "你的公司",
  "This connection attempt has expired": "此连接请求已过期",
  "Choose an app below to start again.": "请在下方选择应用重新开始。",
  "Confirming access before marking it connected.": "正在确认访问权限。",
  "You cancelled authorization. You can try again whenever you’re ready.": "你已取消授权，随时可以重试。",
  "We couldn’t confirm an active connection yet. Try checking again, or restart authorization.":
    "尚未确认连接成功。请重新检查或再次授权。",
  "Chat options": "对话选项",
  "Start a new chat": "新建对话",
  "Clear selection (Esc)": "清除选择（Esc）",
  "Pin selected": "置顶选中对话",
  "Unpin selected": "取消置顶选中对话",
  "Archive selected": "归档选中对话",
  "Unarchive selected": "取消归档选中对话",
  "Color selected": "设置选中对话的颜色",
  "Expand this pane": "展开此窗格",
  "Make default": "设为默认",
  "Remove from presets": "从预设中移除",
  "Read-only. Replies happen on the original surface": "只读。请在原始会话中回复",
  "Ask. Enter to send, Shift+Enter for a new line": "提问。按 Enter 发送，Shift+Enter 换行",
  "Nothing running can take this. It will go out as its own turn": "当前没有可接收此消息的任务，它将作为独立轮次发送",
  "Note from last fire": "上次运行的备注",
  "When off, the agent never acts on overheard messages here; it only responds to direct @mentions. Default: on only when standing orders (or an action-mode bot) are set below, otherwise mention-only.":
    "关闭后，智能体不会因这里的旁听消息采取行动，只响应直接 @提及。默认仅在下方设置长期指令（或行动模式机器人）时启用；否则仅响应提及。",
  healthy: "运行正常",
  degraded: "性能下降",
  failing: "运行失败",
  quarantined: "已隔离",
  paused: "已暂停",
  ready: "待处理",
  unconfirmed: "待确认",
  shipped: "已交付",
  returned: "已退回",
  expired: "已过期",
  never: "从未",
  "Clear quarantine": "解除隔离",
  Resume: "恢复",
  "Shipping without review": "无需审查直接交付",
  "Ships outputs without review": "无需审查即可交付产出",
  "a return needs a note for the next attempt": "退回时需要填写供下次尝试参考的备注",
  "Collapse pins": "收起置顶内容",
  "Show pins": "显示置顶内容",
  "Connecting Slack": "正在连接 Slack",
  "Refresh sent mail": "刷新已发送邮件",
  "Create the inbox loop and the personal cron that scans your connected apps and drafts replies":
    "创建收件箱循环任务和个人定时任务，扫描已连接的应用并草拟回复",
  "Sync now": "立即同步",
  "Send the drafted reply in Gmail": "在 Gmail 中发送已起草的回复",
  "Send the drafted reply to Slack": "将已起草的回复发送到 Slack",
  "The sync cron is on": "同步定时任务已开启",
  "The sync cron is paused. Manage it under Crons": "同步定时任务已暂停。请在定时任务中管理",
  "Stopping…": "正在停止…",
  "Interrupted, resuming…": "已中断，正在恢复…",
  "You stopped after": "你已停止，运行时长",
  "Describe a change…": "描述需要修改的内容…",
  "The pinned Slack header (when enabled below) names this model.": "下方启用 Slack 置顶消息后，其中会显示此模型名称。",
  this: "此",
  "Shared snapshot": "共享快照",
  "Anyone with the link": "知道链接的任何人",
  "Organization only": "仅限组织成员",
  completed: "已完成",
  running: "运行中",
  ok: "成功",
  failed: "失败",
  refused: "已拒绝",
  pending_approval: "等待审批",
  queued: "排队中",
  silent: "无回复",
  react: "已回应",
  deferred: "已延后",
  skipped: "已跳过",
  "edit failed": "编辑失败",
  "archive failed": "归档失败",
  "unarchive failed": "取消归档失败",
  "enable failed": "启用失败",
  "disable failed": "停用失败",
  "delete failed": "删除失败",
  Goal: "目标",
  "Goal paused": "目标已暂停",
  "Pursuing goal": "正在执行目标",
  "Effort levels": "思考强度选项",
  "Unpin selected conversations": "取消置顶选中的对话",
  "Pin selected conversations": "置顶选中的对话",
  "Unarchive selected conversations": "取消归档选中的对话",
  "Archive selected conversations": "归档选中的对话",
  "Write a reply…": "撰写回复…",
  "No draft yet. The next sync writes one, or write your own.": "暂无回复草稿。下次同步会生成草稿，你也可以自行撰写。",
  "No subject": "无主题",
  "Popular apps": "热门应用",
  "Show fewer apps": "收起应用列表",
};

export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  return null;
}

export function resolveLocale(stored?: string | null, languages?: readonly string[]): AppLocale {
  const saved = normalizeLocale(stored);
  if (saved) return saved;
  const detected =
    languages ??
    (typeof navigator === "undefined"
      ? []
      : [...(navigator.languages ?? []), navigator.language].filter((value): value is string => Boolean(value)));
  for (const language of detected) {
    const inferred = normalizeLocale(language);
    if (inferred) return inferred;
  }
  return "en";
}

function storedLocale(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

export function currentLocale(): AppLocale {
  return resolveLocale(storedLocale());
}

export function localeCode(locale: AppLocale = currentLocale()): string {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

function translatePattern(source: string): string | null {
  let match: RegExpMatchArray | null;
  if ((match = source.match(/^Sign in with (.+)$/))) return `使用 ${match[1]} 登录`;
  if ((match = source.match(/^Uses your (.+) subscription and its usage limits\.$/)))
    return `使用你的 ${match[1]} 订阅及其用量限制。`;
  if ((match = source.match(/^Paste a key from (.+) — usage is billed to the key\.$/)))
    return `粘贴来自 ${match[1]} 的密钥，用量将计入该密钥。`;
  if ((match = source.match(/^Chat with (.+) on your own account$/))) return `使用你自己的 ${match[1]} 账户对话`;
  if ((match = source.match(/^Connected with your (.+) subscription$/))) return `已通过你的 ${match[1]} 订阅连接`;
  if ((match = source.match(/^New chats will use your (.+) account\.$/))) return `新对话将使用你的 ${match[1]} 账户。`;
  if ((match = source.match(/^Use your (.+) subscription for new chats\.$/)))
    return `新对话将使用你的 ${match[1]} 订阅。`;
  if (
    (match = source.match(
      /^Paste it only in the secure form, never in this conversation\. (.+) uses it to create its app, then discards it\.$/,
    ))
  )
    return `只在安全表单中粘贴令牌，切勿在此对话中发送。${match[1]} 会用它创建应用，随后将其丢弃。`;
  if ((match = source.match(/^(.+) — in flight for (\d+)m$/))) return `${match[1]} — 已运行 ${match[2]} 分钟`;
  if ((match = source.match(/^(.+) — took (\d+)s$/))) return `${match[1]} — 耗时 ${match[2]} 秒`;
  if ((match = source.match(/^(.+) settings saved\.$/))) return `${match[1]} 的设置已保存。`;
  if ((match = source.match(/^(.+) is offline and archived\.$/))) return `${match[1]} 已下线并归档。`;
  if ((match = source.match(/^(.+) is restored and running\.$/))) return `${match[1]} 已恢复运行。`;
  if ((match = source.match(/^Reorder (.+); use Up or Down$/))) return `调整 ${match[1]} 的顺序；使用向上或向下键`;
  if ((match = source.match(/^Make (.+) default$/))) return `将 ${match[1]} 设为默认`;
  if ((match = source.match(/^Remove (.+) from presets$/))) return `从预设中移除 ${match[1]}`;
  if ((match = source.match(/^Add (.+) to presets$/))) return `将 ${match[1]} 添加到预设`;
  if ((match = source.match(/^Back to parent: (.+)$/))) return `返回上级：${match[1]}`;
  if ((match = source.match(/^Open sent email: (.+)$/))) return `打开已发送邮件：${match[1]}`;
  if ((match = source.match(/^Add (.+) to Slack$/))) return `将 ${match[1]} 添加到 Slack`;
  if ((match = source.match(/^Connect (.+)$/))) return `连接 ${match[1]}`;
  if ((match = source.match(/^In this conversation: (.+)$/))) return `此对话中的人员：${match[1]}`;
  if ((match = source.match(/^Ask (.+) for something$/))) return `向 ${match[1]} 提问`;
  if ((match = source.match(/^(\d+) apps? found$/))) return `找到 ${match[1]} 个应用`;
  if ((match = source.match(/^Browse all (\d+) apps$/))) return `浏览全部 ${match[1]} 个应用`;
  if ((match = source.match(/^No apps match “(.+)”\. Try another name\.$/)))
    return `没有匹配“${match[1]}”的应用。请尝试其他名称。`;
  if ((match = source.match(/^(\d+) turns$/))) return `${match[1]} 轮`;
  if ((match = source.match(/^([\d,]+) tokens$/))) return `${match[1]} 个令牌`;
  if ((match = source.match(/^(\d+)h (\d+)m$/))) return `${match[1]} 小时 ${match[2]} 分钟`;
  if ((match = source.match(/^(\d+)m (\d+)s$/))) return `${match[1]} 分钟 ${match[2]} 秒`;
  if ((match = source.match(/^(\d+)h$/))) return `${match[1]} 小时`;
  if ((match = source.match(/^([\d.]+)m$/))) return `${match[1]} 分钟`;
  if ((match = source.match(/^(\d+)s$/))) return `${match[1]} 秒`;
  if ((match = source.match(/^(\d+)d$/))) return `${match[1]} 天`;
  if ((match = source.match(/^(\d+)w$/))) return `${match[1]} 周`;
  if ((match = source.match(/^Hi, (.+)\.$/))) return `你好，${match[1]}。`;
  if ((match = source.match(/^(.+) connected$/))) return `${match[1]} 已连接`;
  if ((match = source.match(/^Opening (.+)…$/))) return `正在打开 ${match[1]}…`;
  if ((match = source.match(/^Checking (.+) connection…$/))) return `正在检查 ${match[1]} 的连接…`;
  if ((match = source.match(/^(.+) wasn’t connected$/))) return `${match[1]} 未连接`;
  if ((match = source.match(/^Couldn’t connect (.+)$/))) return `无法连接 ${match[1]}`;
  match = source.match(/^(\d+)m ago$/);
  if (match) return `${match[1]} 分钟前`;
  match = source.match(/^(\d+)h ago$/);
  if (match) return `${match[1]} 小时前`;
  match = source.match(/^(\d+)d ago$/);
  if (match) return `${match[1]} 天前`;
  match = source.match(/^(\d+) selected subjects?$/);
  if (match) return `已选择 ${match[1]} 个主体`;
  match = source.match(/^(\d+) conversations selected$/);
  if (match) return `已选择 ${match[1]} 个对话`;
  match = source.match(/^Model: (.+), (.+) effort(, Fast)?$/);
  if (match) return `模型：${match[1]}，思考强度：${translateText(match[2]!, "zh-CN")}${match[3] ? "，快速模式" : ""}`;
  match = source.match(/^No people found for “(.+)”\.$/);
  if (match) return `没有找到匹配“${match[1]}”的人员。`;
  match = source.match(
    /^(\d+) existing subjects? (?:is|are) outside your directory view\. An organization administrator must update this policy\.$/,
  );
  if (match) return `有 ${match[1]} 个现有主体不在你的组织目录可见范围内，必须由组织管理员更新此策略。`;
  match = source.match(/^(\d+) conversations?$/);
  if (match) return `${match[1]} 个对话`;
  match = source.match(/^(\d+) files?$/);
  if (match) return `${match[1]} 个文件`;
  match = source.match(/^Uploading (\d+) files?…$/);
  if (match) return `正在上传 ${match[1]} 个文件…`;
  match = source.match(/^Uploaded (\d+) files?\.$/);
  if (match) return `已上传 ${match[1]} 个文件。`;
  match = source.match(/^Uploaded (\d+) of (\d+)\. (.+)$/);
  if (match) return `已上传 ${match[1]} / ${match[2]}。${match[3]}`;
  match = source.match(/^(\d+) results?$/);
  if (match) return `${match[1]} 条结果`;
  match = source.match(/^(\d+) saved$/);
  if (match) return `已保存 ${match[1]} 条`;
  match = source.match(/^(\d+) tool calls?$/);
  if (match) return `${match[1]} 次工具调用`;
  match = source.match(/^(\d+) runs?$/);
  if (match) return `${match[1]} 次运行`;
  match = source.match(/^(\d+) members?$/);
  if (match) return `${match[1]} 位成员`;
  match = source.match(/^(\d+) messages?$/);
  if (match) return `${match[1]} 条消息`;
  match = source.match(/^(\d+) assets?$/);
  if (match) return `${match[1]} 个资源`;
  match = source.match(/^(\d+) variants?$/);
  if (match) return `${match[1]} 个变体`;
  match = source.match(/^(\d+) skills? in (\d+) groups?$/);
  if (match) return `${match[1]} 个技能，分为 ${match[2]} 组`;
  match = source.match(/^(\d+) background jobs? running$/);
  if (match) return `${match[1]} 个后台任务正在运行`;
  match = source.match(/^(\d+) watches? armed$/);
  if (match) return `${match[1]} 个监视器已就绪`;
  match = source.match(/^(\d+) tools?$/);
  if (match) return `${match[1]} 个工具`;
  match = source.match(/^(\d+) attempts?$/);
  if (match) return `${match[1]} 次尝试`;
  match = source.match(/^(\d+) active grants?$/);
  if (match) return `${match[1]} 项有效授权`;
  match = source.match(/^(\d+) active credential grants?$/);
  if (match) return `${match[1]} 项有效凭据授权`;
  match = source.match(/^(\d+)m left$/);
  if (match) return `剩余 ${match[1]} 分钟`;
  match = source.match(/^(\d+)h (\d+)m left$/);
  if (match) return `剩余 ${match[1]} 小时 ${match[2]} 分钟`;
  match = source.match(/^Working for (\d+)s$/);
  if (match) return `已工作 ${match[1]} 秒`;
  match = source.match(/^Worked for (\d+)s$/);
  if (match) return `工作了 ${match[1]} 秒`;
  match = source.match(/^Failed after (\d+)s$/);
  if (match) return `${match[1]} 秒后失败`;
  match = source.match(/^Saved — new conversations here run on (.+?)(?: · (.+) effort)?\.$/);
  if (match)
    return `已保存——此处的新对话将使用 ${match[1]}${match[2] ? ` · 思考强度：${translateText(match[2]!, "zh-CN")}` : ""}。`;
  match = source.match(/^Restore memory from (.+)\?$/);
  if (match) return `从 ${match[1]} 恢复记忆？`;
  match = source.match(/^Synced (.+)$/);
  if (match) return `已同步 ${match[1]}`;
  match = source.match(/^Remove (.+) from (.+)\?$/);
  if (match) return `从 ${match[2]} 移除 ${match[1]}？`;
  match = source.match(/^every (.+)$/);
  if (match) return `每 ${translateText(match[1]!, "zh-CN")}`;
  match = source.match(/^New chat in (.+)$/);
  if (match) return `在 ${match[1]} 中新建对话`;
  match = source.match(/^Start a new chat in (.+)$/);
  if (match) return `在 ${match[1]} 中新建对话`;
  match = source.match(/^Options for (.+)$/);
  if (match) return `${match[1]} 的选项`;
  match = source.match(/^Share (.+)$/);
  if (match) return `分享 ${match[1]}`;
  match = source.match(/^Open \/(.+)$/);
  if (match) return `打开 /${match[1]}`;
  match = source.match(/^Color selected conversations (.+)$/);
  if (match) return `将选中的对话设为${match[1]}色`;
  match = source.match(/^Copy link to (.+)$/);
  if (match) return `复制 ${match[1]} 的链接`;
  match = source.match(/^Unlink #(.+) from (.+)\?$/);
  if (match) return `取消关联 #${match[1]} 与 ${match[2]}？`;
  match = source.match(/^Unlink #(.+)$/);
  if (match) return `取消关联 #${match[1]}`;
  match = source.match(
    /^The agent posts this project's updates to #(.+), and everyone in the channel is in the project\.$/,
  );
  if (match) return `智能体会将此项目的更新发布到 #${match[1]}，频道中的所有人都属于该项目。`;
  match = source.match(/^More actions for (.+)$/);
  if (match) return `${match[1]} 的更多操作`;
  match = source.match(/^Handling for (.+)$/);
  if (match) return `${match[1]} 的处理方式`;
  match = source.match(/^Batch interval for (.+) in hours$/);
  if (match) return `${match[1]} 的批处理间隔（小时）`;
  match = source.match(/^Remove (.+) from the ledger$/);
  if (match) return `从记录中移除 ${match[1]}`;
  match = source.match(/^Archive (.+)$/);
  if (match) return `归档 ${match[1]}`;
  match = source.match(/^In (.+)$/);
  if (match) return `位于 ${match[1]}`;
  match = source.match(/^Filter by: (.+)$/);
  if (match) return `筛选：${match[1]}`;
  match = source.match(/^(.+) project$/);
  if (match) return `${match[1]} 项目`;
  match = source.match(/^tomorrow (.+)$/);
  if (match) return `明天 ${match[1]}`;
  match = source.match(/^Next run: (.+)$/);
  if (match) return `下次运行：${match[1]}`;
  match = source.match(/^Last fired: (.+)$/);
  if (match) return `上次触发：${match[1]}`;
  match = source.match(/^First run: (.+)$/);
  if (match) return `首次运行：${match[1]}`;
  match = source.match(/^Revision (.+)$/);
  if (match) return `修订版 ${match[1]}`;
  match = source.match(/^No matches for “(.+)”\.$/);
  if (match) return `没有匹配“${match[1]}”的人员。`;
  match = source.match(/^No results match “(.+)”\.$/);
  if (match) return `没有匹配“${match[1]}”的结果。`;
  match = source.match(/^Note left by (.+)$/);
  if (match) return `${match[1]} 留下的备注`;
  match = source.match(/^(\d+) waiting on you$/);
  if (match) return `${match[1]} 项待你处理`;
  match = source.match(/^(.+)\. Click to inspect$/);
  if (match) return `${translateText(match[1]!, "zh-CN")}。点击查看详情`;
  match = source.match(/^Forked from (.+)\. Open the original$/);
  if (match) return `从 ${match[1]} 分支。打开原始对话`;
  match = source.match(/^Forked from (.+)$/);
  if (match) return `分支来源：${match[1]}`;
  match = source.match(/^Back to (.+)$/);
  if (match) return `返回${match[1]}`;
  match = source.match(/^Open the (.+) project$/);
  if (match) return `打开${match[1]}项目`;
  match = source.match(/^Remove (.+)$/);
  if (match) return `移除${match[1]}`;
  match = source.match(/^Open (.+)$/);
  if (match) return `打开 ${match[1]}`;
  match = source.match(/^Manage (.+)$/);
  if (match) return `管理 ${match[1]}`;
  match = source.match(/^Color selected (#[\da-f]{6})$/i);
  if (match) return `将选中对话设为 ${match[1]}`;
  match = source.match(/^Invalid filter: "(.+)"\. Use path: value1, value2\.$/);
  if (match) return `筛选条件“${match[1]}”无效。请使用 path: value1, value2。`;
  match = source.match(/^Invalid filter: "(.+)"\. Both path and value are required\.$/);
  if (match) return `筛选条件“${match[1]}”无效。路径和值都必填。`;
  return null;
}

export function translateText(source: string, locale: AppLocale = currentLocale()): string {
  if (locale === "en") return source;
  const leading = source.match(/^\s*/)?.[0] ?? "";
  const trailing = source.match(/\s*$/)?.[0] ?? "";
  const value = source.trim().replace(/\s+/g, " ");
  if (!value) return source;
  const translated = ZH[value] ?? translatePattern(value);
  return translated == null ? source : `${leading}${translated}${trailing}`;
}

export const t = (source: string): string => translateText(source);

export function formatChatCta(prompt: string, name?: string | null, locale: AppLocale = currentLocale()): string {
  const translated = translateText(prompt, locale);
  const person = name?.trim();
  if (!person) return translated;
  return locale === "zh-CN" ? `你好，${person}。${translated}` : `Hi, ${person}. ${translated}`;
}

const localizedTemplates = new WeakMap<TemplateStringsArray, TemplateStringsArray>();

function localizedMarkup(value: string): string {
  const attributes = value.replace(/\b(title|aria-label|placeholder)=(['"])(.*?)\2/g, (_, name, quote, content) => {
    return `${name}=${quote}${translateText(content, "zh-CN")}${quote}`;
  });
  return attributes.replace(/(^|>)([^<>]+)(?=<|$)/g, (_, opening, content) => {
    return `${opening}${translateText(content, "zh-CN")}`;
  });
}

function localizedTemplate(strings: TemplateStringsArray): TemplateStringsArray {
  if (currentLocale() === "en") return strings;
  const cached = localizedTemplates.get(strings);
  if (cached) return cached;
  const values = strings.map(localizedMarkup);
  const raw = [...values];
  Object.defineProperty(values, "raw", { value: raw });
  const result = values as unknown as TemplateStringsArray;
  localizedTemplates.set(strings, result);
  return result;
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): TemplateResult {
  return litHtml(localizedTemplate(strings), ...values);
}

export function installI18n(root: HTMLElement = document.documentElement): void {
  const locale = currentLocale();
  root.lang = locale;
}

export function setLocale(locale: AppLocale): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    void 0;
  }
  document.documentElement.lang = locale;
  location.reload();
}
