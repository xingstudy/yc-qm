import { html as litHtml, type TemplateResult } from "lit";

export type AppLocale = "en" | "zh-CN";

export const LOCALE_KEY = "qm:locale";

const ZH: Record<string, string> = {
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
  "open the original": "打开原始对话",
  "Preparing files...": "正在准备文件…",
  "Pinned header": "置顶消息",
  "Pinned header removed.": "已移除置顶消息。",
  "Pinned Slack header for this channel": "此频道的 Slack 置顶消息",
  "Private channel": "私有频道",
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
  Sessions: "会话",
  "Show full command": "显示完整命令",
  Steer: "调整任务",
  "Steer the running task with this instead of waiting": "用这条消息调整正在运行的任务，而不是等待",
  "starts a new chat where QM hunts down the matching session and links it": "新建对话，让 QM 查找匹配的会话并提供链接",
  Stop: "停止",
  "The org now recommends": "组织现在推荐",
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
  "Allow always": "始终允许",
  "Allow for session": "本会话允许",
  "Allow once": "允许一次",
  "Already open in a pane": "已在窗格中打开",
  "Another keychain change is still in progress.": "另一项密钥链更改仍在进行中。",
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
  "Bot name": "机器人名称",
  Browse: "浏览",
  "Can manage": "可管理",
  "Can view": "可查看",
  Cancel: "取消",
  Channel: "频道",
  "Channels & messages": "频道和消息",
  Chats: "对话",
  Close: "关闭",
  "Close pane": "关闭窗格",
  "Close sidebar": "关闭侧边栏",
  "Clone or push a new version with this short-lived authenticated URL.": "使用此短期有效的认证 URL 克隆或推送新版本。",
  "Clone source with this short-lived read-only authenticated URL.": "使用此短期有效的只读认证 URL 克隆源码。",
  "Color scheme: light / dark / system": "颜色模式：浅色 / 深色 / 跟随系统",
  "Color row": "设置行颜色",
  "Clear color": "清除颜色",
  "Clear row color": "清除行颜色",
  "Connect account": "连接账户",
  "Connected accounts": "已连接账户",
  Conversations: "对话",
  Connectors: "连接器",
  Continue: "继续",
  context: "上下文",
  Conversation: "对话",
  "Conversation options": "对话选项",
  Copied: "已复制",
  Contexts: "上下文",
  "Context settings": "上下文设置",
  "Core returned an invalid project": "核心服务返回了无效项目",
  "Couldn't link that channel — you must be a member of it.": "无法关联该频道——你必须是该频道的成员。",
  "Couldn't unlink the channel.": "无法取消关联该频道。",
  "Could not attach that file.": "无法附加该文件。",
  "Could not create the one-time page.": "无法创建一次性页面。",
  "Could not delete the key.": "无法删除密钥。",
  "Could not disconnect.": "无法断开连接。",
  "Could not revoke access.": "无法撤销访问权限。",
  "Could not start the connector.": "无法启动连接器。",
  "Could not deliver the message — the running task ended mid-send. It is back in the composer.":
    "无法送达消息——正在运行的任务在发送途中结束。消息已返回编辑器。",
  "Could not deliver the message — the running task never settled. It is back in the composer.":
    "无法送达消息——正在运行的任务始终未完成。消息已返回编辑器。",
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
  "Facts view": "事实视图",
  "Facts the agent carries into your conversations.": "智能体会带入对话的事实。",
  Fast: "快速",
  "Fast mode": "快速模式",
  "Fast mode active": "快速模式已启用",
  "Fast mode is only available on Opus models": "快速模式仅适用于 Opus 模型",
  Files: "文件",
  "Files created, uploaded, or shared with you": "由你创建、上传或与你共享的文件",
  "Files & folders": "文件和文件夹",
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
  "Open in Slack": "在 Slack 中打开",
  Organization: "组织",
  "Org default": "组织默认值",
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
  "Project settings": "项目设置",
  "Project options": "项目选项",
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
  let match = source.match(/^(\d+)m ago$/);
  if (match) return `${match[1]} 分钟前`;
  match = source.match(/^(\d+)h ago$/);
  if (match) return `${match[1]} 小时前`;
  match = source.match(/^(\d+)d ago$/);
  if (match) return `${match[1]} 天前`;
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
  match = source.match(/^Saved — new conversations here run on (.+)\.$/);
  if (match) return `已保存——此处的新对话将使用 ${match[1]}。`;
  match = source.match(/^Remove (.+) from (.+)\?$/);
  if (match) return `从 ${match[2]} 移除 ${match[1]}？`;
  match = source.match(/^every (.+)$/);
  if (match) return `每 ${match[1]}`;
  match = source.match(/^New chat in (.+)$/);
  if (match) return `在 ${match[1]} 中新建对话`;
  match = source.match(/^Options for (.+)$/);
  if (match) return `${match[1]} 的选项`;
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
