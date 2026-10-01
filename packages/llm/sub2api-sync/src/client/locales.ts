/**
 * Locale dictionaries for the browser half. `zh` is the key source: the
 * `Sub2apiSyncKey` union drives the `LocaleNamespaceMap` merge, and `en` is
 * compile-time balanced against it (`satisfies Record<Sub2apiSyncKey, string>`).
 * Every user-facing copy in this plugin's components goes through this
 * dictionary — components carry no literal strings.
 *
 * @module sub2api-sync/client/locales
 */

export const NS = 'sub2api-sync'

const zh = {
  nav: 'Sub2API 同步',

  localOnlyWarning: '当前页面进程本地，配置仅本页生效',
  configUnavailable: '配置暂不可用：宿主未连接或未暴露该设置条目',

  nameLine: 'sub2api · {instance}',
  signedOut: '未登录',
  signedInPat: '已通过 PAT 登录',
  signedInAs: '已登录：{email}',
  signIn: '登录',
  signOut: '登出',
  signOutDone: '已登出',

  baseURLLabel: '实例地址',
  baseURLPlaceholder: 'https://api.example.com（可带 /v1）',
  save: '保存',
  savedNotice: '已保存',
  writeRefused: '写入未被接受，已恢复为最新状态',

  accountTitle: '面板账号',
  accountSignedOutHint: '登录后可发现分组、勾选同步，自动为每个分组准备 key',

  signInTitle: '登录 sub2api 面板',
  channelLabel: '登录方式',
  channelPat: 'PAT',
  channelPassword: '密码登录',
  patPlaceholder: '粘贴 sub2api 个人访问令牌',
  connect: '连接',
  emailPlaceholder: 'you@example.com',
  passwordLabel: '密码',
  passwordHint: '留空则使用宿主已保存的密码重新登录',
  twoFactorPlaceholder: '6 位数字验证码',
  twoFactorSubmit: '验证',
  back: '返回',
  cancel: '取消',
  close: '关闭',
  signedInNotice: '登录成功',

  groupsRefresh: '刷新',
  providerPreview: '显示为 {name}',

  syncTitle: '同步',
  syncNow: '立即同步',
  syncing: '同步中…',
  syncDone: '同步完成',
  reportEmpty: '还没有同步过',
  reportMeta: '写入 {writes} 项 · {attempts} 次尝试',
  entryModels: '{name} · {count} 个模型',
  entryError: '{name} · {error}',
  reportRemoved: '已移除：{routes}',
  reportWarningLine: '警告：{message}',
  routesSummary: '已注册 {count} 条路由',
  actionCreated: '新建',
  actionUpdated: '更新',
  actionUnchanged: '无变化',
  actionFailed: '失败',
  actionFailedLabel: '操作失败：{message}',

  bundleTemplateLabel: '供应商名模板',
  bundleTemplateHint: 'displayName 模板，必须包含 {keyName} 占位符',
  bundleTemplateInvalid: '模板必须包含 {keyName} 占位符',
  bundleKeyQuotaLabel: '新建 key 配额（USD）',
  bundleKeyQuotaHint: '自动建 key 时应用；留空不设置',
  bundleKeyExpiresLabel: '新建 key 有效期（天）',
  bundleKeyExpiresHint: '自动建 key 时应用；留空不过期',
  bundleIntervalLabel: '自动同步间隔（毫秒）',
  bundleIntervalHint: '至少 60000；留空关闭自动同步',
  bundleIntervalInvalid: '间隔不能小于 60000',
  bundleNumberInvalid: '请输入合法数字',
  bundleDeleteOrphanLabel: '移除分组时吊销远端 key',
  bundleDeleteOrphanHint: '仅对记录过 keyId 的分组生效',
  bundleEnrichLabel: '补全模型元数据',
  bundleEnrichHint: '同步时按模型 id 从 models.dev 补全容量元数据；关闭则仅用内置快照（离线）',
  bundleAllowRemoteLabel: '允许私网设备调用动作接口',
  bundleAllowRemoteWarning: '开启后同源或私网页面可改写模型路由与凭据——仅在可信内网开启',
  bundleAdvancedHint: 'protocolOverrides / compatTemplate 高级字段请编辑 cordis.patch.yml',

  badgeManagedTag: 'Sub2API 同步',
  badgeManageHint: '管理入口：设置 → Sub2API 同步',
  badgeModels: '{count} 个模型',
  footerSyncedCount: '已同步 {count} 个分组',
  footerSignedOut: '未连接面板',
  footerNeverSynced: '尚未同步',
  footerJustNow: '刚刚',
  footerMinutesAgo: '{count} 分钟前',
  detailBadgeSynced: '已同步 {count} 组',
  detailBadgeSignedOut: '未连接面板',
  detailSectionTitle: '最近同步',
  detailSectionEmpty: '还没有同步过——在设置 → Sub2API 同步 完成首次同步',
  activationTitle: '开始使用 Sub2API 同步',
  activationStep1: '1. 在设置中连接面板（PAT 或账号密码）',
  activationStep2: '2. 勾选要同步的分组（key 自动准备）',
  activationStep3: '3. 点击「立即同步」，模型即可使用',
  activationOpenConfig: '打开配置页',
  activationDismiss: '知道了',

  keysTitle: 'Keys',
  createKey: '创建 key',
  keyGroupLabel: '所属分组',
  keyNameLabel: 'Key 名称',
  keyNameHint: '默认与分组同名',
  keyGroupPlaceholder: '选择分组',
  keyCreated: '已创建并绑定：{name}',
  keysListEmpty: '还没有 key',
  keysListLoading: '正在读取 keys…',
  syncSelected: '同步所选（{count}）',
  syncSelectedDone: '同步完成：{ok}/{total} 条成功',
  keysLoadMore: '加载更多（还有 {count} 个）',
} as const

export type Sub2apiSyncKey = keyof typeof zh

const en = {
  nav: 'Sub2API Sync',

  localOnlyWarning: 'This page runs process-local; configuration applies to this page only',
  configUnavailable: 'Configuration is unavailable: the host is not connected or does not expose this entry',

  nameLine: 'sub2api · {instance}',
  signedOut: 'Signed out',
  signedInPat: 'Signed in with a personal access token',
  signedInAs: 'Signed in as {email}',
  signIn: 'Sign in',
  signOut: 'Sign out',
  signOutDone: 'Signed out',

  baseURLLabel: 'Instance address',
  baseURLPlaceholder: 'https://api.example.com (optionally with /v1)',
  save: 'Save',
  savedNotice: 'Saved',
  writeRefused: 'The write was not accepted; the latest state was restored',

  accountTitle: 'Panel account',
  accountSignedOutHint: 'Sign in to discover groups, pick the ones to sync, and let each group get its key prepared',

  signInTitle: 'Sign in to the sub2api panel',
  channelLabel: 'Sign-in channel',
  channelPat: 'PAT',
  channelPassword: 'Password',
  patPlaceholder: 'Paste a sub2api personal access token',
  connect: 'Connect',
  emailPlaceholder: 'you@example.com',
  passwordLabel: 'Password',
  passwordHint: 'Leave empty to re-login with the password the host already stored',
  twoFactorPlaceholder: '6-digit code',
  twoFactorSubmit: 'Verify',
  back: 'Back',
  cancel: 'Cancel',
  close: 'Close',
  signedInNotice: 'Signed in',

  groupsRefresh: 'Refresh',
  providerPreview: 'Appears as {name}',

  syncTitle: 'Sync',
  syncNow: 'Sync now',
  syncing: 'Syncing…',
  syncDone: 'Sync finished',
  reportEmpty: 'Never synced',
  reportMeta: '{writes} write(s) · {attempts} attempt(s)',
  entryModels: '{name} · {count} model(s)',
  entryError: '{name} · {error}',
  reportRemoved: 'Removed: {routes}',
  reportWarningLine: 'Warning: {message}',
  routesSummary: '{count} route(s) registered',
  actionCreated: 'created',
  actionUpdated: 'updated',
  actionUnchanged: 'unchanged',
  actionFailed: 'failed',
  actionFailedLabel: 'Operation failed: {message}',

  bundleTemplateLabel: 'Provider name template',
  bundleTemplateHint: 'displayName template; must contain the {keyName} placeholder',
  bundleTemplateInvalid: 'The template must contain the {keyName} placeholder',
  bundleKeyQuotaLabel: 'Created key quota (USD)',
  bundleKeyQuotaHint: 'Applied to auto-created keys; empty leaves it unset',
  bundleKeyExpiresLabel: 'Created key expiry (days)',
  bundleKeyExpiresHint: 'Applied to auto-created keys; empty means no expiry',
  bundleIntervalLabel: 'Auto-sync interval (ms)',
  bundleIntervalHint: 'At least 60000; empty disables auto-sync',
  bundleIntervalInvalid: 'The interval must be at least 60000',
  bundleNumberInvalid: 'Enter a valid number',
  bundleDeleteOrphanLabel: 'Revoke the remote key when a group is removed',
  bundleDeleteOrphanHint: 'Only affects groups whose keyId was recorded',
  bundleEnrichLabel: 'Enrich model metadata',
  bundleEnrichHint: 'Fill per-model capacity facts from models.dev at sync; off = bundled snapshot only (offline)',
  bundleAllowRemoteLabel: 'Allow private-network devices to call action routes',
  bundleAllowRemoteWarning: 'When enabled, same-origin or private-network pages can rewrite model routes and credentials — enable only on a trusted network',
  bundleAdvancedHint: 'Edit cordis.patch.yml for the advanced protocolOverrides / compatTemplate fields',

  badgeManagedTag: 'Sub2API Sync',
  badgeManageHint: 'Manage in Settings → Sub2API Sync',
  badgeModels: '{count} model(s)',
  footerSyncedCount: '{count} group(s) synced',
  footerSignedOut: 'Panel not connected',
  footerNeverSynced: 'Never synced',
  footerJustNow: 'just now',
  footerMinutesAgo: '{count} min ago',
  detailBadgeSynced: '{count} group(s) synced',
  detailBadgeSignedOut: 'Panel not connected',
  detailSectionTitle: 'Last sync',
  detailSectionEmpty: 'Never synced — finish the first sync in Settings → Sub2API Sync',
  activationTitle: 'Get started with Sub2API Sync',
  activationStep1: '1. Connect the panel in Settings (PAT or account password)',
  activationStep2: '2. Check the groups to sync (keys are prepared automatically)',
  activationStep3: '3. Click "Sync now" and the models are ready',
  activationOpenConfig: 'Open configuration',
  activationDismiss: 'Got it',

  keysTitle: 'Keys',
  createKey: 'Create key',
  keyGroupLabel: 'Group',
  keyNameLabel: 'Key name',
  keyNameHint: 'Defaults to the group name',
  keyGroupPlaceholder: 'Pick a group',
  keyCreated: 'Created and bound: {name}',
  keysListEmpty: 'No keys yet',
  keysListLoading: 'Loading keys…',
  syncSelected: 'Sync selected ({count})',
  syncSelectedDone: 'Synced: {ok}/{total} succeeded',
  keysLoadMore: 'Load more ({count} left)',
} satisfies Record<Sub2apiSyncKey, string>

/** Both shipped dictionaries; registration requires every built-in locale. */
export const dictionaries = { zh, en }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** sub2api-sync settings card and plugin-page tuning card copy. */
    'sub2api-sync': Sub2apiSyncKey
  }
}
