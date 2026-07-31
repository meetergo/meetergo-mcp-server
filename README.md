# meetergo MCP server

Lets an AI agent actually run a calendar: find slots, book, reschedule, cancel,
review what is coming up, and keep the contact record straight.

Not to be confused with the **docs** MCP server at
`https://developer.meetergo.com/mcp`, which searches documentation and cannot
change anything. Both are useful and they do different jobs:

| | Docs MCP | This server |
|---|---|---|
| Endpoint | `developer.meetergo.com/mcp` | runs locally over stdio |
| Tools | `SearchMeetergo` | 17 scheduling and CRM tools |
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

| Tool | Writes? | Purpose |
|---|---|---|
| `get_me` | | Confirm the token works — start here when something looks empty |
| `list_meeting_types` | | What can be booked |
| `get_availability` | | Bookable slots for a meeting type |
| `book_appointment` | **yes** | Book a slot |
| `reschedule_appointment` | **yes** | Move an appointment |
| `cancel_appointment` | **yes** | Cancel, or drop one attendee |
| `list_appointments` | | Paginated calendar with filters |
| `get_todays_appointments` | | Today only |
| `get_appointment` | | One appointment in full, including `attendeeId`s |
| `add_guest` | **yes** | Add a guest email to an appointment |
| `update_appointment_notes` | **yes** | Write call prep or an outcome back |
| `create_one_time_booking_link` | **yes** | Send a single-use link instead of booking for someone |
| `search_contacts` | | Find a contact before creating a duplicate |
| `get_contact` | | Full record, by `contactId` or by `attendeeId` from a booking |
| `create_contact` | **yes** | Add a contact |
| `update_contact` | **yes** | Edit a contact |
| `list_calendar_connections` | | Which calendars are attached |

Writes carry `readOnlyHint: false`, and `cancel_appointment` carries
`destructiveHint: true`, so hosts can require confirmation before an agent
changes anything real.

## Why seventeen and not a hundred

The Platform API has 100 operations. Every tool definition consumes context in
the model's window, and selection accuracy drops as the list grows — an agent
picking between 100 near-identical operations picks worse than one choosing
between seventeen.

The bar for a tool here is that it closes a loop an agent can complete on its
own: discover, schedule, change, review, follow up, and know who it is talking
to. Configuration surfaces stay out — meeting-type creation, routing-form
definitions and page branding all need a large request body the model would have
to invent from a docstring, and a mistyped payload is worse than no tool. Those
belong in the dashboard, and stay reachable over
[REST](https://developer.meetergo.com).

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

## Prior art

The community [`chill-lichen/meetergo-mcp`](https://github.com/chill-lichen/meetergo-mcp)
server (Python, BSD-3) covers a wider slice of the API — routing forms,
webhooks, page branding. It found several endpoint-path bugs before we did.
Worth a look if you need surface this server deliberately leaves out.
