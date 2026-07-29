# meetergo MCP server

Lets an AI agent actually run a calendar: find slots, book, reschedule, cancel,
review what is coming up.

Not to be confused with the **docs** MCP server at
`https://developer.meetergo.com/mcp`, which searches documentation and cannot
change anything. Both are useful and they do different jobs:

| | Docs MCP | This server |
|---|---|---|
| Endpoint | `developer.meetergo.com/mcp` | runs locally over stdio |
| Tools | `SearchMeetergo` | 9 scheduling tools |
| Can it book? | No | **Yes** |
| Use it to | write an integration | be the integration |

## Setup

Create a Personal Access Token at
[my.meetergo.com/integrations](https://my.meetergo.com/integrations), then add
the server to your MCP client:

```json
{
  "mcpServers": {
    "meetergo": {
      "command": "npx",
      "args": ["-y", "@meetergo/mcp-server"],
      "env": { "MEETERGO_TOKEN": "pat_your_token_here" }
    }
  }
}
```

Works with Claude Desktop, Claude Code, Cursor, or anything else that speaks
MCP. `MEETERGO_API_URL` overrides the API base if you are pointing at a
non-production environment.

## Tools

| Tool | Writes? | Purpose |
|---|---|---|
| `list_meeting_types` | | What can be booked — start here |
| `get_availability` | | Bookable slots for a meeting type |
| `book_appointment` | **yes** | Book a slot |
| `reschedule_appointment` | **yes** | Move an appointment |
| `cancel_appointment` | **yes** | Cancel, or drop one attendee |
| `list_appointments` | | Paginated calendar |
| `get_todays_appointments` | | Today only |
| `add_guests` | **yes** | Add guest emails |
| `list_calendar_connections` | | Which calendars are attached |

Writes carry `readOnlyHint: false`, and `cancel_appointment` carries
`destructiveHint: true`, so hosts can require confirmation before an agent
changes anything real.

## Why nine and not a hundred

The Platform API has 100 operations. Every tool definition consumes context in
the model's window, and selection accuracy drops as the list grows — an agent
picking between 100 near-identical operations picks worse than one choosing
between nine. These nine are the loop that makes "an agent runs your calendar"
true. Everything else stays available over
[REST](https://developer.meetergo.com).

## Development

```bash
npx tsx apps/mcp-server/src/index.ts     # run against the real API
nx typecheck mcp-server                  # types
```
