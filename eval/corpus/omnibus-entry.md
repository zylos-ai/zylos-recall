# Example Channel Component

## zylos-example (channel) — omnibus project entry

- **Status:** active, v0.3.2, public as of 2026-05-26, CLAUDE.md aligned to the official component format, blocked previously on DNS for production deployment.
- **Description:** Example messaging channel for the platform; test suite added with 108 tests; the index module refactored from a 1368-line monolith into four files; synchronous I/O blocking fixed; dead and duplicate code removed; admin CLI brought to full parity with the reference channel.
- **Auth:** custom JWT validation with pre-parse rejection in the auth library, rejecting malformed tokens before any parsing work; tenant and app id required for elevated scopes.
- **Inbound processing:** HTML-to-text conversion for incoming rich messages; group context blocks attached for group and channel messages; in-memory chat history tracked with a configurable window defaulting to ten messages.
- **Conversation store:** file-locking for concurrency safety, a one thousand entry capacity cap, least-recently-used eviction when full, and a three hundred sixty five day time-to-live before stale references expire.
- **Access control:** per-team and per-channel cascading configuration with team overrides; admin commands to add and remove teams, set per-team mention mode, add and remove channels, and list teams.
- **Outbound delivery:** group-chat sends must use the API client initialized with the conversation-specific service URL from the stored conversation reference; the generic send helper defaulted to the wrong regional host and silently failed group delivery.
- **Graph integration:** OAuth2 token management, chat and channel history fetch, hosted content download, and member lookup; opt-in behind a tenant id and admin consent for the required scopes.
- **Media:** inbound attachment download and outbound media references for images and files; on-demand attachment fetch in smart mode.
- **Smart mode:** groups and channels can run in mention mode (respond only to mentions) or smart mode (receive all messages, agent decides); smart mode uses auto-renewed graph subscriptions and a reaction indicator on incoming messages.
- **Admin CLI:** add-team, remove-team, set-team-mention, add-channel, remove-channel, list-teams, graph-status; reactions require a configured catalog id or they are silently disabled for direct messages.
- **Health:** health check includes a has-graph flag; service reports ready only after warmup completes.
- **Known issues:** legacy domain DNS parking on the old vanity host (not this deployment); the reaction indicator needs a catalog id to enable direct-message reactions.
- **Credentials:** app id and tenant id stored in environment variables with the channel prefix; never logged.
- **Routing:** production requests arrive via the cloud front door, through the reverse proxy, to the local port; the public URL auto-resolves from forwarded headers.
