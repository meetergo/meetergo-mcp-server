# meetergo MCP server

Lets an AI agent actually run a calendar: find slots, book, reschedule, cancel,
review what is coming up, and keep the contact record straight.

Not to be confused with the **docs** MCP server at
`https://developer.meetergo.com/mcp`, which searches documentation and cannot
change anything. Both are useful and they do different jobs:

| | Docs MCP | This server |
|---|---|---|
| Endpoint | `developer.meetergo.com/mcp` | `mcp.meetergo.com/mcp`, or `npx` over stdio |
| Tools | `SearchMeetergo` | 194 scheduling, CRM, Mira and config tools |
| Can it book? | No | **Yes** |
| Use it to | write an integration | be the integration |

## Setup

Create a Personal Access Token at
[my.meetergo.com/integrations](https://my.meetergo.com/integrations) — it looks
like `rgo-…` — then either point your client at the hosted server or run this
package locally over stdio. The token works on every plan, including Free.

### Hosted

```
https://mcp.meetergo.com/mcp
```

Streamable HTTP, authenticated with `Authorization: Bearer rgo-…`. The path
matters: `mcp.meetergo.com` alone is not the endpoint. For clients that take a
remote URL and headers:

```json
{
  "mcpServers": {
    "meetergo": {
      "url": "https://mcp.meetergo.com/mcp",
      "headers": { "Authorization": "Bearer rgo-your_token_here" }
    }
  }
}
```

### Local (npx)

```json
{
  "mcpServers": {
    "meetergo": {
      "command": "npx",
      "args": ["-y", "@meetergo/mcp-server"],
      "env": { "MEETERGO_TOKEN": "rgo-your_token_here" }
    }
  }
}
```

Works with Claude Desktop, Claude Code, Cursor, or anything else that speaks
MCP.

### Scope the token

When you create the token you can limit it to the capabilities the agent
actually needs (scheduling, contacts and deals, Mira, forms, account). A limited
token is refused on everything outside those groups, including reads, so give it
every group whose tools you intend to use — a Mira-only token cannot book, and a
scheduling-only token cannot read your knowledge base.

### Signing in instead of pasting a token

OAuth sign-in is live on the hosted endpoint. Discovery is published at
`/.well-known/oauth-protected-resource` (RFC 9728), so a capable client can
start the flow from the MCP URL. Clients are pre-registered rather than created
through dynamic client registration. For a Claude custom connector, enter the
public client id `mcp-claude` under Advanced settings and leave the client secret
blank. The directory clients for Claude and ChatGPT are configured with their
respective providers.

#### Cursor and Grok Bot

This repository includes the Cursor Marketplace plugin used by both Cursor and
Grok Bot. Install **meetergo** from Settings, Plugins, Marketplace, then finish
the browser sign-in. The plugin connects to the hosted endpoint and uses the
public PKCE client id `mcp-cursor`; there is no client secret or token to paste.

For local review before the marketplace listing is published, load this
repository as a local Cursor plugin. Its `.cursor-plugin/plugin.json` manifest
points at `mcp.json`, which contains the same hosted URL and OAuth client id.

A Personal Access Token works in every MCP client, on every plan including Free.
That is what the rest of this page assumes.

### Acting for another user

A Personal Access Token always acts as its owner. To run an agent across a whole
company — an assistant booking on behalf of several colleagues — use a **Platform
API Key** (`ak_live:<uuid>:<secret>`) and name the target user:

```json
"env": {
  "MEETERGO_TOKEN": "ak_live:...",
  "MEETERGO_USER_ID": "the-user-uuid"
}
```

The two token types have opposite requirements, and the server checks both at
startup rather than letting you find out mid-booking:

- a Platform API Key **must** have `MEETERGO_USER_ID` — the API demands an
  acting user on nearly every route;
- a Personal Access Token **must not** — it always acts as its owner, and the
  API rejects the header outright.

Against the hosted endpoint the acting user travels as the
`X-Meetergo-Api-User-Id` request header instead of an environment variable; the
same two rules apply, and sending it with a Personal Access Token is refused.

### Environment

The stdio entry (`meetergo-mcp`, what `npx` runs):

| Variable | Required | Purpose |
|---|---|---|
| `MEETERGO_TOKEN` | **yes** | `rgo-…` Personal Access Token or `ak_live:…` Platform API Key |
| `MEETERGO_USER_ID` | with a Platform API Key | The user to act as |
| `MEETERGO_API_URL` | | API base override, default `https://api.meetergo.com/v4` |
| `MEETERGO_NEXT_URL` | | Booking-page host rendered into widget install snippets, default `https://cal.meetergo.com` |
| `MEETERGO_TIMEOUT_MS` | | Per-request timeout, default `30000` |

### Running the hosted entry yourself

The package also ships `meetergo-mcp-http`, the Streamable HTTP entry that runs
behind `https://mcp.meetergo.com/mcp`. Credentials arrive per request in the
`Authorization` header rather than from the environment, so one process serves
any number of accounts — `MEETERGO_TOKEN` and `MEETERGO_USER_ID` are not read
here. It reads:

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | | Listen port, default `8080` |
| `MEETERGO_API_URL` | | API base override, default `https://api.meetergo.com/v4` |
| `MEETERGO_NEXT_URL` | | Booking-page host rendered into widget install snippets, default `https://cal.meetergo.com` |
| `MEETERGO_DASHBOARD_URL` | | Dashboard host used for upgrade links in plan-limit errors, default `https://my.meetergo.com` |
| `MCP_PUBLIC_URL` | | This server's public URL, default `http://localhost:$PORT`. Only its **origin** is used: origin + `/mcp` is the resource identifier — the `resource` field of the discovery document, and the value an OAuth token must carry in `aud`. `https://host`, `https://host/` and `https://host/mcp` are therefore the same setting. Anything that is not an absolute http(s) URL fails at startup |
| `OAUTH_ISSUER` | all three or none | OpenID issuer of the authorization server, e.g. `https://login.meetergo.com/realms/meetergo`. Must be absolute and **https** — the exchange posts this server's client secret and the user's token to it — or the process refuses to start. A trailing slash is trimmed |
| `OAUTH_CLIENT_ID` | all three or none | Confidential client this server exchanges tokens into (RFC 8693) |
| `OAUTH_CLIENT_SECRET` | all three or none | That client's secret |

**The three `OAUTH_*` variables are all-or-nothing.** Set all three and an
inbound access token is validated first — issuer, `aud`, `typ: Bearer`, RS256
signature against the issuer's JWKS, expiry — and only then exchanged for a
separate token for the upstream API. The MCP spec forbids forwarding the token a
client handed you, so the exchange is not an optimisation; it is the only path.

Set none and the process is bearer-token-only: Personal Access Tokens and
Platform API Keys work, both `.well-known` paths answer 404, the 401 challenge
carries no `resource_metadata`, and an OAuth token is refused rather than passed
upstream.

Set one or two and you get the bearer-token-only behaviour above, not a partial
OAuth — plus a warning log, `oauth_disabled_incomplete_config`, naming the
variables that are missing.

### Retries

Both entries behave the same here. Rate limits and transient upstream errors
(429, 502, 503, 504) get up to three attempts in total (so two retries),
honouring `Retry-After` where the API sends one.

Retries are **not** applied blindly. A booking or cancellation that fails
ambiguously — a timeout, a dropped connection, a 502 — may already have been
applied by the API, and there is no idempotency key to make a second attempt
safe. Only reads are retried on those; writes are retried solely on a 429, the
one response that states the request was never processed.

## One-prompt onboarding

If your client supports MCP prompts, run **`meetergo: onboard`**. Otherwise
paste this:

> Set up meetergo for my company. Call get_me and get_setup_status first and
> tell me what already exists. Then analyse my website with
> propose_conversion_setup and present the proposed setup — meeting types,
> qualification questions, the website assistant. Build nothing until I approve.
> After I approve: create what's missing, turn the questions into a routing form
> with create_qualification_form, crawl my site, then PROVE it works with
> run_test_drive and show me the verdicts. Finish by giving me the install
> snippet, and verify with verify_widget_install after I've pasted it.

The agent audits what exists, proposes, waits for your yes, builds, and then
**shows you scripted visitors booking through your own assistant** before
anything goes live. A second prompt, **`meetergo: weekly-review`**, pulls last
week's conversations and offers to teach the assistant every answer it missed.

## Plan limits

Every tool reports plan walls structurally: which limit was hit and where
upgrading happens, so your agent explains the situation instead of failing
vaguely. `get_me` also returns a `plan` block (tier, limits) so a good agent
warns you *before* starting something your plan cannot finish. Connecting the
server itself is never gated — a token from any plan, including Free, works.

## Tools

194 tools, covering scheduling end to end. **Scheduling** is the loop most agents
live in; the rest is there so an agent never has to fall back to raw REST.

### Scheduling

| Tool | Writes? | Purpose |
|---|---|---|
| `get_me` | | Confirm the token works — start here when something looks empty |
| `list_meeting_types` | | What can be booked |
| `get_availability` | | Bookable slots for a meeting type |
| `book_appointment` | **yes** | Book a slot |
| `reschedule_appointment` | **yes** | Move an appointment |
| `cancel_appointment` | **destructive** | Cancel, or drop one attendee |
| `list_appointments` | | Paginated calendar with filters |
| `get_todays_appointments` | | Today only |
| `get_appointment` | | One appointment in full, including `attendeeId`s |
| `add_guest` | **yes** | Add a guest email to an appointment |
| `update_appointment_notes` | **yes** | Write call prep or an outcome back |
| `create_one_time_booking_link` | **yes** | Send a single-use link instead of booking for someone |
| `list_calendar_connections` | | Which calendars are attached |

### Follow-up

| Tool | Writes? | Purpose |
|---|---|---|
| `send_quick_email` | **yes** | One-off email to an attendee (5 per 5 min) |
| `update_meeting_transcription` | **yes** | Attach a transcript or summary from a notetaker |

### Meeting types

| Tool | Writes? | Purpose |
|---|---|---|
| `get_meeting_type` | | Full config — read before updating |
| `create_meeting_type` | **yes** | Create a bookable meeting type |
| `update_meeting_type` | **yes** | Change one |
| `delete_meeting_type` | **destructive** | Remove one; its page stops working |

### Booking page

| Tool | Writes? | Purpose |
|---|---|---|
| `get_personal_page` | | Colours, header, links, meeting-type order |
| `update_personal_page` | **yes** | Change branding |

### Routing forms

| Tool | Writes? | Purpose |
|---|---|---|
| `list_routing_forms` | | All forms and funnels |
| `get_routing_form` | | Steps, fields and routing rules |
| `create_routing_form` | **yes** | Build a qualification form |
| `update_routing_form` | **yes** | Change one |
| `delete_routing_form` | **destructive** | Remove one; shared links break |
| `send_routing_form` | **yes** | Send by email or SMS, or mint a link |
| `list_form_recipients` | | Who got it, who answered |
| `list_data_fields` | | Reusable fields across forms |
| `create_data_field` | **yes** | Add one |
| `update_data_field` | **yes** | Change a field's label, type, key, required flag, options or target mapping |
| `delete_data_field` | **destructive** | Remove a field |
| `get_data_field_usage` | | Where a field is actually used — check before editing or deleting it |
| `reorder_data_fields` | **yes** | Set field display order — the full `fieldIds` list, not a partial move |

### CRM

| Tool | Writes? | Purpose |
|---|---|---|
| `search_contacts` | | Find a contact before creating a duplicate |
| `find_duplicate_contacts` | | Group existing contacts by shared email, phone or name — there is no dedicated dedup endpoint for contacts (unlike deals), so this pages through every contact and groups client-side |
| `get_contact` | | Full record, by `contactId` or by `attendeeId` from a booking |
| `create_contact` | **yes** | Add a contact; also takes `address` and `additionalData` |
| `update_contact` | **yes** | Edit a contact, including `language`, `address`, `additionalData` and the research-suggested `title`/`employer`/`seniority`/`function`/`location` |
| `set_contact_source_type` | **yes** | Tag a contact with an account-defined source-type flag (e.g. network contact vs. standard customer); creates the backing data field itself on first use if none exists yet |
| `bulk_create_contacts` | **yes** | Import many at once (3 calls per min) |
| `delete_contact` | **destructive** | Remove a contact and its form answers |
| `bulk_delete_contacts` | **destructive** | Delete up to 500 contacts in one call (3 calls per min) — the cleanup after a bad import or a round of test contacts |
| `get_contact_timeline` | | Unified activity feed — meetings, synced emails, forms, notes, tasks, communications — merged and cursor-paginated |
| `get_contact_emails` | | Synced email headers and previews for a contact |
| `get_deal_emails` | | Synced email headers and previews for a deal |
| `get_email_body` | | Full body of one synced email, fetched on demand from the provider |
| `get_email_send_capability` | | Whether the current user's connected mailbox could send right now |

There is no send endpoint: draft the email as text in the reply and let the
human send it. `get_contact_timeline` is the compact way to answer "what's
happened with this lead so far" instead of reading notes, tasks and emails
separately.

`additionalData` on `create_contact`/`update_contact` is the contact-level
custom field system behind `list_data_fields` — same trap as company/deal
`customFields`: a misspelled or wrong-cased key is not rejected, it's
silently stored as an extra key nobody sees.

A contact row with `crmCompanyRef` also auto-creates a separate, unlisted
`ContactCompany` record from its email domain if that domain hasn't been seen
before — harmless for a handful of known domains, but a large import across
many distinct domains leaves that many orphan records with no endpoint to
view or remove them.

### Deals

| Tool | Writes? | Purpose |
|---|---|---|
| `list_pipelines` | | Pipelines and their stages — read this before creating or moving a deal |
| `list_deals` | | Search and filter by pipeline, stage, contact, company, owner or outcome |
| `get_deal` | | Full record, including linked contact, company, stage, owner and a `signal` health block (health score, days in stage, in/outbound counts, open/overdue tasks) |
| `create_deal` | **yes** | Add a deal to a pipeline |
| `update_deal` | **yes** | Change value, stage, owner, contact or company |
| `delete_deal` | **destructive** | Remove a deal and its activity history |
| `mark_deal_won` | **yes** | Close as won |
| `mark_deal_lost` | **yes** | Close as lost, with an optional reason |
| `reopen_deal` | **yes** | Undo a won or lost outcome |
| `get_deal_activity` | | Stage-change and update history, most recent first |
| `get_deal_summary` | | Deal counts and value across the pipeline, by stage |
| `get_deal_limits` | | Deal count against the plan limit (`-1` = unlimited) |
| `get_quiet_contacts` | | Open deals gone quiet (rotting, or past a days-since-activity threshold), ranked by value — computed client-side from `list_deals`' own `signal`/`isRotting` fields, no dedicated endpoint |
| `find_duplicate_deals` | | Deals that look like duplicates of a given deal, with a match score |
| `get_deal_contact_suggestions` | | Contacts a deal is probably about, when none is linked yet |
| `add_deal_contact` | **yes** | Link another contact to a deal with a role (decision_maker, influencer, user, primary, other) |
| `update_deal_contact` | **yes** | Change a linked contact's role or primary flag |
| `remove_deal_contact` | **destructive** | Unlink a contact from a deal |
| `merge_deals` | **destructive** | Merge duplicates into a survivor; the merged-in deals are permanently deleted |
| `bulk_import_deals` | **yes** | Upsert contacts and create one deal per row, into one pipeline stage (max 500 rows) |
| `get_deal_appointments` | | Appointments booked or held directly on a deal |

`bulk_import_deals` has the same `crmCompanyRef` orphan-record caveat as
`bulk_create_contacts` above. Look up and confirm duplicates with
`find_duplicate_deals` before calling `merge_deals` — it cannot be undone.

`create_deal`'s `contacts` array covers adding contacts with a role only at
creation time; `add_deal_contact`/`update_deal_contact`/`remove_deal_contact`
cover the same afterwards, e.g. when a second decision-maker joins mid-deal.
`get_deal` always embeds the current contacts array, so a `dealContactId` for
`update_deal_contact`/`remove_deal_contact` comes from reading that first —
it is the link's own id, not the contact's.

### Pipelines

| Tool | Writes? | Purpose |
|---|---|---|
| `create_pipeline` | **yes** | Add a pipeline, optionally with its stages in one call |
| `update_pipeline` | **yes** | Rename a pipeline or change its default flag |
| `delete_pipeline` | **destructive** | Remove a pipeline and its stages |
| `add_pipeline_stage` | **yes** | Add a stage; `name` and `color` required |
| `update_pipeline_stage` | **yes** | Change a stage's settings, including `salesMilestone` |
| `delete_pipeline_stage` | **destructive** | Remove a stage; `moveToStageId` is required so its deals aren't stranded |
| `reorder_pipeline_stages` | **yes** | Set a pipeline's stage order — the full `stageIds` list, not a partial move |

`salesMilestone` (`start`/`demo`/`offer`, on a stage) is what the "Sales
Learning" reports (average sales-cycle length, demo-to-quote conversion) key
off — the first time a deal enters a stage marked `start`/`demo`/`offer`
becomes its opportunity-start/first-demo/first-quote date. Those reports
show no data until at least one stage in the pipeline carries a milestone.

`update_pipeline_stage`'s own response isn't reliably complete — a field
left untouched has come back `null` even though the change never happened;
confirmed by re-reading `list_pipelines` right after. Re-read the pipeline
list for a stage's actual current state rather than trusting this call's
response.

### Companies

| Tool | Writes? | Purpose |
|---|---|---|
| `list_companies` | | Search and filter by name, industry, size or owner |
| `get_company` | | Full record, including owner and deal/contact counts |
| `create_company` | **yes** | Add a company. Only `name` is required |
| `update_company` | **yes** | Edit a company; pass `ownerId: null` to unassign it |
| `delete_company` | **destructive** | Remove a company (linked contacts and deals keep existing, just unlinked) |
| `get_company_by_domain` | | Look up a company by its website domain, e.g. before creating a duplicate |
| `get_company_contacts` | | Contacts linked to a company |
| `get_company_deals` | | Deals linked to a company, across every pipeline |
| `get_company_summary` | | Company counts and pipeline value, grouped by industry and size |
| `get_custom_field_definitions` | | Custom field definitions on companies or deals — key, label, type, required, and the option list for a multiselect field |
| `update_custom_field_definitions` | **destructive** | Replace the entire set of custom field definitions for companies or deals |
| `get_lost_reasons` | | Selectable reasons for marking a deal lost, and whether picking one is required |
| `update_lost_reasons` | **destructive** | Replace the entire set of selectable lost-deal reasons |
| `get_company_meeting_history` | | Meeting count, distinct people, and first/last meeting date |

`get_custom_field_definitions` is a separate system from `list_data_fields`
(booking-form fields on contacts). Look it up before writing `customFields` on
`create_company`/`update_company`/`create_deal`/`update_deal`: a misspelled or
wrong-cased key is not rejected — it is silently stored as an extra key
nobody sees.

`update_custom_field_definitions` and `update_lost_reasons` are both full
replaces of a company-wide settings list, not a patch: read the current set
first and send it back with your change folded in, or anything left out is
gone. Without `get_lost_reasons`/`update_lost_reasons`, marking a deal lost
only ever takes a free-text reason, which is how uncategorized reasons pile
up in loss-reason reporting.

### Communications

| Tool | Writes? | Purpose |
|---|---|---|
| `list_communications` | | Logged communications for a company, deal or contact: WhatsApp, email, call, SMS |
| `create_communication` | **yes** | Log a communication against a company, deal or contact |
| `update_communication` | **yes** | Correct a logged communication's type, direction, subject, body, duration, outcome or timestamp |
| `delete_communication` | **destructive** | Permanently delete a logged communication entry |

`list_communications`/`create_communication` require exactly one of
`crmCompanyId`, `dealId` or `contactId` — the same one-of-three scoping as
notes. `dealId` and `contactId` are not strict subsets of each other, though:
the API joins through the contact-deal link, so a communication logged
directly on the deal shows up under the linked contact's scope too, and vice
versa. `crmCompanyId` stays strict — it never reaches through to a company's
deals or contacts.

### Notes

| Tool | Writes? | Purpose |
|---|---|---|
| `list_notes` | | Notes logged against a company, deal or contact, most recent first |
| `create_note` | **yes** | Log a note against a company, contact or deal |
| `update_note` | **yes** | Change a note's content, or pin it to the top of its list |
| `delete_note` | **destructive** | Permanently delete a logged note |

`list_notes` and `create_note` both require exactly one of `crmCompanyId`,
`dealId` or `contactId` — the API rejects zero or more than one on
`create_note`; `list_notes` checks it itself, since the id picks which nested
path it reads.

### Attachments

| Tool | Writes? | Purpose |
|---|---|---|
| `list_attachments` | | Attachments on a company, deal or contact (same one-of-three scoping as notes) |

There is no `create_attachment` yet: the API expects a `fileAssetId` from an
upload step whose endpoint hasn't been found. A company-scoped upload route
that looked promising (`POST /crm/companies/{id}/attachments`) turned out to
be a stub — it answers `201` with a plausible-looking body but never actually
saves anything, so it's deliberately not wired up either.

### Tasks

| Tool | Writes? | Purpose |
|---|---|---|
| `list_tasks` | | Paginated CRM tasks, optionally scoped to a company, deal or contact |
| `get_task` | | One task in full, including its assignee and linked company, deal or contact |
| `create_task` | **yes** | Create a task; `type` (`call`/`follow_up`/`email`/`meeting`/`todo`, confirmed) and `dueDate` are required. Also takes `priority` (`low`/`medium`/`high`), `reminderAt`, `assigneeId`, and linking to a company/deal/contact |
| `update_task` | **yes** | Change title, type, due date, description, priority, reminder, assignee or linked company/deal/contact |
| `complete_task` | **yes** | Mark a task done, on its own endpoint — no body |
| `uncomplete_task` | **yes** | Reopen a completed task, on its own endpoint — no body |
| `delete_task` | **destructive** | Permanently delete a task |
| `get_task_summary` | | Aggregate counts: total, completed, overdue, due today/this week, by type and priority |
| `list_overdue_tasks` | | Open tasks past their due date |
| `list_upcoming_tasks` | | Open tasks due soon |
| `list_company_tasks` | | A company's tasks, on the confirmed `by-company` endpoint |
| `log_personal_followup` | **yes** | Log a personal conversation as a fixed, labeled note (Anliegen/Kontext/Zusage) plus a linked reminder task, due in 30 days by default |

`completed`, `status`, `isCompleted` and `completedAt` are silently ignored on
`update_task` itself — HTTP 200, no effect. `complete_task`/`uncomplete_task`
are the only endpoints that actually flip it. `list_tasks`'s own
`crmCompanyId` filter was never confirmed to filter anything — prefer
`list_company_tasks` when scoping to one company.

### Mira, the website assistant

Everything needed to take a website from "no assistant" to a live one that
answers from the company's own pages and books meetings.

| Tool | Writes? | Purpose |
|---|---|---|
| `get_setup_status` | | The launch checklist: what exists, what's missing, the next move |
| `get_mira_settings` | | The whole assistant config — read before changing it |
| `update_mira_settings` | **destructive** | Change it; returns the previous settings so you can put them back |
| `restore_mira_settings` | **destructive** | Restore a snapshot taken from an earlier update |
| `propose_conversion_setup` | | Read a crawled site and propose an assistant, qualification and booking setup |
| `create_qualification_form` | **yes** | Turn proposed questions into a real, editable routing form |
| `run_test_drive` | | Scripted visitors talk to the saved assistant; verdicts + transcripts back |
| `get_mira_widget_embed` | | The public key, the embed snippet, and a preview URL |
| `verify_widget_install` | | Fetch a page of the customer's site and confirm it serves THEIR widget |
| `answer_visitor_question` | **yes** | Teach the assistant an answer it was missing |
| `get_conversation_insights` | | What visitors asked and where the assistant had no answer |

### Knowledge base

| Tool | Writes? | Purpose |
|---|---|---|
| `crawl_company_website` | **yes** | Ingest a website so the assistant can answer from it |
| `get_crawl_status` | | Progress of a running crawl |
| `list_knowledge_documents` | | What has been ingested |
| `delete_knowledge_document` | **destructive** | Remove a document; the assistant stops citing it |
| `search_company_knowledge` | | Retrieve the passages a question would be answered from |

### Webhooks

| Tool | Writes? | Purpose |
|---|---|---|
| `list_webhooks` | | Endpoints in use (max 6 per company) |
| `create_webhook` | **yes** | Register an HTTPS endpoint |
| `update_webhook` | **yes** | Change URL or events |
| `delete_webhook` | **destructive** | Remove one; events stop immediately |

Writes carry `readOnlyHint: false`, and everything marked **destructive** above
carries `destructiveHint: true`, so hosts can require confirmation before an
agent removes something a human would miss.

### meetergo Docs and attachments

Pages and spreadsheets in meetergo Docs, optionally linked to a CRM contact, and edits to CRM attachments.

| Tool | Writes? | What it does |
|---|---|---|
| `list_documents` |  | List pages and spreadsheets in meetergo Docs, compact rows without content (open a single document for that). |
| `get_document` |  | Load one page or spreadsheet. |
| `create_document` | **yes** | Create a page or spreadsheet in meetergo Docs. |
| `update_document` | **yes** | Change a document; only supplied fields change. |
| `delete_document` | **destructive** | Permanently delete a page or spreadsheet from meetergo Docs. |
| `get_attachment_download_url` |  | Return a presigned url for a CRM attachment's file (attachment id from the attachment list). |
| `update_attachment` | **yes** | Set the description/label of a CRM attachment. |
| `delete_attachment` | **destructive** | Remove an attachment from a CRM company, deal or contact. |

### Availability schedules

Weekly working-hours schedules and their exceptions. Not the free-slot lookup `get_availability`.

| Tool | Writes? | What it does |
|---|---|---|
| `get_availability_schedule` |  | Read weekly working-hours schedules (with their exceptions). |
| `list_availability_exceptions` |  | List date-specific exceptions (holidays, blocked or extra hours): your own, or the company-wide ones that apply to everyone. |
| `save_availability_schedule` | **yes** | Create a weekly schedule (no scheduleId; name and timezone required) or change one (scheduleId; only supplied fields change). |
| `delete_availability_schedule` | **destructive** | Permanently delete a weekly schedule. |
| `availability_schedule_action` | **yes** | set_default: make a schedule the default (yours, or userId's). |
| `save_availability_exception` | **yes** | Block or open a specific date range. |
| `delete_availability_exception` | **destructive** | Permanently delete a date exception. |

### Spaces

Client portals with sections, blocks, share links and invited people.

| Tool | Writes? | What it does |
|---|---|---|
| `list_spaces` |  | List client portals (kind "spaces"), reusable space templates ("templates"), or saved section templates ("section_templates"). |
| `get_space` |  | Read one space with its sections and blocks, or via part: its share links, form submissions (form_status), files visitors uploaded (uploads), or invited people. |
| `save_space` | **yes** | Create a blank portal (name required), create one from a template or existing space (sourceSpaceId; copies sections and blocks and swaps in the client), or update one (spaceId; only supplied fields... |
| `delete_space` | **destructive** | Delete a client portal, including its links. |
| `space_action` | **yes** · reaches outside | publish: make the portal live (visible to clients once a link or invite exists; confirm with the user first). |
| `edit_space_structure` | **destructive** | Change a space's layout. |
| `manage_space_link` | **destructive** · reaches outside | Share links are how clients open a portal. |
| `manage_space_people` | **destructive** · reaches outside | invite: give a person access to a portal (sendEmail also mails them the link; confirm the address and whether to email first). |
| `manage_space_section_template` | **destructive** | create: a template from scratch (name + structure { title, blocks[] }). |

### WhatsApp, signatures and meeting follow-up

Messaging, e-signature requests, provisional bookings, handoffs and post-meeting actions.

| Tool | Writes? | What it does |
|---|---|---|
| `get_whatsapp` |  | Read WhatsApp data, selected by `view`: senders (business numbers), templates (approved ones are needed outside the 24h window), conversations (newest first; filter by phone/status), conversation (... |
| `send_whatsapp_message` | **yes** · reaches outside | Send a WhatsApp message to a phone number or BSUID; the conversation is created or reused. |
| `get_signatures` |  | Read e-signature data, selected by `view`: usage (this month against the plan allowance; -1 = unlimited), list (newest first, 50 per page; pass the last id as `before`), get (status and signers of... |
| `manage_signature` | **destructive** · reaches outside | Act on a signature request via `action`. |
| `list_provisional_bookings` |  | List bookings that wait for confirmation: type requireHostConfirmation needs the host, doubleOptIn waits for the attendee. |
| `resolve_provisional_booking` | **destructive** · reaches outside | decline: rejects a pending booking request and notifies the attendee, optionally with a reason. |
| `list_handoff_options` |  | List the users an appointment (or a channel) can be handed off to, with a blocked reason where a user cannot take it. |
| `handoff_appointments` | **destructive** · reaches outside | Change the host of appointments. |
| `update_attendee` | **yes** | action no_show: marks an attendee as no-show for reporting. |
| `draft_follow_up_email` | **yes** | Generates an editable follow-up subject and body from the appointment summary or transcript. |
| `set_recap_sharing` | **yes** · reaches outside | shared true: publishes the meeting recap behind a public link. |
| `email_meeting_transcript` | **yes** · reaches outside | Sends a meeting summary and/or transcript (markdown) as an email to one address. |

### Booking setup

Meeting-type templates, queues, group booking links, users and calendar connections.

| Tool | Writes? | What it does |
|---|---|---|
| `list_meeting_type_templates` |  | Without templateId: all templates. |
| `save_meeting_type_template` | **destructive** · reaches outside | Create a template (no templateId; needs name, description, duration, channel) or change one (with templateId; only sent fields change). |
| `assign_meeting_type_template` | **destructive** · reaches outside | assign_host / assign_hosts (up to 100) give users a meeting type made from the template; assign_workspace does that for a team workspace; unassign removes the template assignment. |
| `delete_meeting_type_template` | **destructive** · reaches outside | Delete a meeting type template. |
| `list_queues` |  | No arguments: all queues of the company. |
| `update_queue` | **destructive** | Change who hosts a round robin meeting type and how bookings are distributed. |
| `manage_queue_user_group` | **destructive** | Create, update or delete a host group inside a queue. |
| `list_booking_links` |  | Read booking links. |
| `save_group_booking_link` | **yes** · reaches outside | Create a group booking link (no groupBookingLinkId; needs workspaceId, meetingTypeId, hostIds) or change one (with groupBookingLinkId; hostIds replaces the host list). |
| `delete_group_booking_link` | **destructive** · reaches outside | Delete a group booking link. |
| `list_users` |  | Company users with ids, names, email and type. |
| `get_calendar_connection_options` |  | With connectionId: the calendars of that connection (ids for a calendar connection update). |
| `update_calendar_connection` | **yes** | Change which calendars block availability, where new events are written and sync behaviour, or make the connection primary (setPrimary). |
| `disconnect_calendar_connection` | **destructive** | Remove a calendar connection. |
| `set_calendar_sync` | **destructive** | Choose which connected calendar receives bookings for a user, or clear it (clear: true), which stops writing bookings to any calendar. |

### Invoicing

Offers, invoices, credit notes, payments and dunning. Sending, finalizing and cancelling cannot be undone: always confirm the exact document first.

| Tool | Writes? | What it does |
|---|---|---|
| `list_sales_documents` |  | List invoicing documents (offers, order confirmations, invoices, credit notes, cancellations), filterable by kind, status and free-text search. |
| `get_sales_document` |  | Fetch one document with its lines and totals (view=document, default), or a related read: events (history), payments, credit_summary (credited vs outstanding), payment_link (hosted pay-page URL, fi... |
| `get_invoicing_config` |  | Read invoicing setup: kind=settings (seller data, tax, dunning, DATEV), products (id optional for one), bank_accounts, number_ranges (numbering per document kind) or recurring (recurring invoices,... |
| `get_invoice_buyer_prefill` |  | Buyer fields for a new document taken from a CRM company. |
| `save_sales_document_draft` | **yes** | Create a draft (no documentId; buyer required, kind defaults to invoice) or edit an existing DRAFT (documentId; only the fields you send change, lines replaces the whole list). |
| `delete_sales_document_draft` | **destructive** | Delete a DRAFT document (drafts only; finalized documents cannot be deleted, cancel it via the status tool). |
| `manage_sales_document` | **yes** | Non-sending document actions: duplicate (copy as a new draft), convert_to_invoice (offer to invoice), create_credit_note (draft Gutschrift over all or selected lines of an invoice; reason required;... |
| `send_sales_document` | **destructive** · reaches outside | Sends mail or WhatsApp to the customer: channel email (document, with pay link by default), whatsapp (needs phoneNumberId; the message links the hosted pay page) or dunning_reminder (reminder on th... |
| `change_sales_document_status` | **destructive** | Irreversible status changes: finalize (draft becomes a legally binding document and consumes the next number; profile zugferd-en16931 default or xrechnung-cii), cancel (cancels a finalized document... |
| `manage_document_payment` | **destructive** | Book a manual payment on a document (action record: amount, method bank_transfer/cash/other, optional paidAt and note) or remove one (action delete: paymentId from the payments view of the document). |
| `update_invoicing_config` | **destructive** · reaches outside | Write invoicing setup. |

## What the tools do for you

The API asks for things a model has no way to know. Rather than describing that
boilerplate in a docstring and hoping, the tools supply it:

- **`book_appointment`** builds the nested `attendee` object, defaults
  `receiveReminders` and the required empty `notes`, and refuses a booking with
  no name rather than writing a blank one into the invitation.
- **`get_availability` and `book_appointment`** resolve which hosts to compute
  for. The API rejects both with `Expected hostIds or queueId` before it even
  loads the meeting type, and a model only ever has a `meetingTypeId`.
- **`create_meeting_type`** fills the six required-but-irrelevant `meetingInfo`
  fields (`customChannelName`, `connectChannelName`, an empty
  `confirmationButton`, …) that reject the whole request when missing. Anything
  the schema does not name goes through `advanced`.
- **`list_appointments`** supplies the required `page` and `pageSize`, which the
  API has no defaults for.

## Development

```bash
npm test          # vitest
npm run build     # tsc -> dist
```

The tests assert the **wire format**, not just the tool list: which path each
tool calls, and the exact body shape the API's DTOs require. That is deliberate.
0.1.x shipped five tools that could never succeed — wrong paths, wrong query
keys, a flat body where `BookingDto` wants a nested `attendee` — and every test
passed, because they only ever checked that the tools existed. Adding or
changing a tool means pinning its request against the route in `apps/api`.
