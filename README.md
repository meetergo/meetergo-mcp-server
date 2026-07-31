# meetergo MCP server

Lets an AI agent actually run a calendar: find slots, book, reschedule, cancel,
review what is coming up, and keep the contact record straight.

Not to be confused with the **docs** MCP server at
`https://developer.meetergo.com/mcp`, which searches documentation and cannot
change anything. Both are useful and they do different jobs:

| | Docs MCP | This server |
|---|---|---|
| Endpoint | `developer.meetergo.com/mcp` | runs locally over stdio |
| Tools | `SearchMeetergo` | 40 scheduling, CRM and config tools |
| Can it book? | No | **Yes** |
| Use it to | write an integration | be the integration |

## Setup

Create a Personal Access Token at
[my.meetergo.com/integrations](https://my.meetergo.com/integrations) — it looks
like `rgo-…` — then add the server to your MCP client:

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

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `MEETERGO_TOKEN` | **yes** | `rgo-…` Personal Access Token or `ak_live:…` Platform API Key |
| `MEETERGO_USER_ID` | with a Platform API Key | The user to act as |
| `MEETERGO_API_URL` | | API base override, default `https://api.meetergo.com/v4` |
| `MEETERGO_TIMEOUT_MS` | | Per-request timeout, default `30000` |

Rate limits and transient upstream errors (429, 502, 503, 504) are retried up to
three times, honouring `Retry-After` where the API sends one.

Retries are **not** applied blindly. A booking or cancellation that fails
ambiguously — a timeout, a dropped connection, a 502 — may already have been
applied by the API, and there is no idempotency key to make a second attempt
safe. Only reads are retried on those; writes are retried solely on a 429, the
one response that states the request was never processed.

## Tools

40 tools, covering scheduling end to end. **Scheduling** is the loop most agents
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

### CRM

| Tool | Writes? | Purpose |
|---|---|---|
| `search_contacts` | | Find a contact before creating a duplicate |
| `get_contact` | | Full record, by `contactId` or by `attendeeId` from a booking |
| `create_contact` | **yes** | Add a contact |
| `update_contact` | **yes** | Edit a contact |
| `bulk_create_contacts` | **yes** | Import many at once (3 calls per min) |
| `delete_contact` | **destructive** | Remove a contact and its form answers |

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
