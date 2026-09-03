# External identity sources

External identity sources connect a managed directory to qm for sign-in and identity matching. They do not replace qm's organization member records and never overwrite a member's name, title, department memberships, access groups, permissions, files, projects, sessions, skills, or crons.

## Configure a source

Open Admin and select **Identity sources**. An organization administrator can create a source, test its credentials, independently enable login and scheduled synchronization, choose a synchronization interval from 15 minutes to 24 hours, and select a match policy.

The initial provider is WeCom. Login and targeted member lookup need a CorpID, AgentID, self-built application Secret, and a trusted callback URL. Full synchronization additionally needs the separate directory synchronization Secret from WeCom's address-book synchronization management page. The default callback is `<AUTH_ISSUER>/directory/callback`; the legacy `/wecom/callback` path remains accepted. Register that callback under the application's trusted web authorization domain, enable the sensitive fields needed for `snsapi_privateinfo`, and keep the application member visibility broad enough for every member expected to sign in or be synchronized. Callback URLs cannot embed a username or password; expose the callback path without proxy authentication instead. WeCom may still withhold sensitive member fields until the user grants them.

Secrets are encrypted with the connector secret key and are write-only in Admin. Leaving the replacement Secret blank preserves the current value. Saving a new Secret or public connection field runs the provider connection test before committing the change.

A newly created source starts with login and synchronization disabled. Login can be enabled after the application connection succeeds. Synchronization requires the directory synchronization Secret and a successful preview for the current source revision. Changing connection fields, credentials, matching policy, or provider capabilities invalidates that preview confirmation.

## Synchronization

Synchronization writes a separate, source-scoped external member snapshot. It never writes the Slack directory snapshot or organization master data.

- **Preview sync** reads and normalizes the provider directory and reports counts without modifying the durable snapshot.
- **Sync now** commits a complete snapshot only after every provider page and member lookup succeeds.
- **Scheduled sync** uses the same complete-snapshot path and defaults to every six hours.
- **Targeted refresh** updates one stable external member and cannot mark unrelated members inactive.

If a complete synchronization fails, the previous successful snapshot remains intact. Run status, counts, sanitized errors, leases, and timestamps are durable and visible on the source detail page.

For WeCom, `biz_mail` is treated as a verified corporate email and `email` as an unverified personal email. The two fields are never interchangeable. CorpID plus UserID is the stable external identity; changing an email address does not change an existing binding.

## Matching and sign-in

Matching follows one shared policy for all providers:

1. Reuse an existing stable source binding.
2. Automatically bind only one unique verified corporate email when that policy is enabled.
3. Show employee-number and mobile matches as administrator suggestions only.
4. Treat duplicate or contradictory evidence as a conflict.
5. Leave all other members unmatched.

WeCom QR login first resolves the stable UserID. Core checks the durable binding before asking for sensitive profile data. An already-bound UserID signs in immediately even when WeCom returns no email. Only an unbound identity without a trusted corporate email is redirected through `snsapi_privateinfo`; Core exchanges that authorization for a `user_ticket`, calls `auth/getuserdetail`, verifies that every response carries the same UserID, and then uses only `biz_mail` for unique matching or controlled creation. Cancelling the second authorization, receiving a different UserID, or receiving no `biz_mail` fails closed without creating or linking an account. See the official [authorization URL](https://developer.work.weixin.qq.com/document/path/91022), [access-user identity](https://developer.work.weixin.qq.com/document/path/91023), and [sensitive-profile](https://developer.work.weixin.qq.com/document/path/95833) documentation.

Automatic provisioning is opt-in. When enabled, an active UserID from the current complete member snapshot may create exactly one organization user from a live, verified `biz_mail` assertion. Core first reuses a unique existing email user, then creates and binds only when no candidate exists. A login-observed UserID without current snapshot membership, an unverified or missing corporate email, an open provider lookup circuit, or any identity conflict still fails closed. Organization-wide email reconciliation remains required for email-first provisioning, but it does not block this snapshot-scoped WeCom QR path.

WeCom renders that consent screen only inside its own client, so a desktop browser cannot follow the redirect. When the QR scan happens outside the WeCom client, the broker parks the pending sign-in and shows a handoff page instead: it pushes a [text-card application message](https://developer.work.weixin.qq.com/document/path/90236) carrying the authorization link to the member, shows a scannable code as a fallback, and refreshes itself until the consent lands. Approving in WeCom finishes the sign-in in the desktop browser that started it; the WeCom client only shows a confirmation. The message needs both application visibility and a base API license — WeCom can report an undelivered recipient as `invaliduser` or `unlicenseduser` without failing the whole request, and the handoff page then leads with the code instead of claiming a message was delivered. Sign-in still works with the message channel unavailable.

An unmatched sign-in fails closed when automatic provisioning is disabled or its safety requirements are not met. Conflicting sign-ins always fail closed. Administrators resolve them from the source's member workbench by binding, ignoring, unignoring, or correcting a binding. Different sources may bind to the same qm member, while one source cannot bind two external members to that member.

Correcting a binding invalidates the old and new users' current sessions. It does not move either user's historical resources.

Deleting a source first pauses managed login, invalidates sessions for users bound through that source, removes its credentials, and retains the source ID, member snapshot, bindings, and audit history. A deleted administrator-managed source can be restored in place with new credentials; restored login and synchronization remain disabled until a new preview succeeds.

## Environment compatibility

Existing `AUTH_WECOM_CORP_ID`, `AUTH_WECOM_AGENT_ID`, and `AUTH_WECOM_SECRET` values are read by Core as a compatibility fallback. `AUTH_WECOM_SECRET` is the self-built application Secret and all three values must be set together. Full synchronization also requires the optional `AUTH_WECOM_DIRECTORY_SYNC_SECRET`; without it the fallback source supports login and targeted lookup only. Optional controls are:

- `AUTH_WECOM_DIRECTORY_SYNC_SECRET`
- `AUTH_WECOM_REDIRECT_URI`
- `AUTH_WECOM_NAME`
- `AUTH_WECOM_LOGIN_ENABLED`
- `AUTH_WECOM_SYNC_ENABLED`
- `AUTH_WECOM_JIT_PROVISIONING_ENABLED`
- `AUTH_WECOM_SYNC_MINUTES`
- `AUTH_WECOM_MATCH_POLICY`

`AUTH_WECOM_REDIRECT_URI` is the public callback registered with WeCom. Its origin and deployment prefix may
differ from `AUTH_ISSUER`, but it must use HTTPS and end with `/directory/callback` or the legacy
`/wecom/callback`. An external proxy must preserve the query string and route that public path to the matching
broker callback under `AUTH_BROKER_PREFIX`.

Environment-managed credentials enter only the Core container and are not persisted. Admin identifies the source as environment managed and disables inline edits and deletion. Invalid fallback credentials or metadata never prevent Admin from loading. An administrator can pause it until Core restarts. `AUTH_WECOM_SYNC_ENABLED=1` requests synchronization but does not bypass safety review: the source starts with synchronization disabled and a successful preview enables it. `AUTH_WECOM_JIT_PROVISIONING_ENABLED=1` explicitly opts the fallback source into snapshot-scoped automatic provisioning; a current complete snapshot and every runtime identity safety check remain mandatory. Core stores only an irreversible keyed configuration fingerprint, so unchanged configuration keeps its preview confirmation across restarts while any credential, connection, matching-policy, or capability change disables synchronization and requires a new preview. Creating an administrator-managed source for the same provider tenant atomically takes over the existing source ID, so member snapshots and bindings remain stable. Administrator-managed configuration always wins for the same provider tenant, including during concurrent instance startup. If that source is later deleted, its durable tombstone blocks environment fallback until the same source is explicitly restored or the tombstone is deliberately removed.

## Failure recovery

Connection and synchronization errors expose stable, sanitized codes without provider tokens or raw payloads. A paused source or disabled login is removed from the broker's login options immediately. Disabling synchronization prevents new scheduled runs without corrupting a run already committing its transaction. Provider, Core, or Auth outages fail sign-in closed.

Migration preview is read-only. It classifies existing stable bindings, unique corporate-email candidates, suspected duplicate accounts, conflicts, and unmatched members. Administrators confirm changes through the same binding workflow used for newly synchronized members.
