# SV Number MCP server

Phone numbers as tools. Your agent orders a private number in the country a service
expects, reads the SMS verification code straight from the API, and hands the number back.
Nine tools over stdio, no SDK to learn.

```
order_number(service="tg", country=6)   ->  +62 838 1234 5678
wait_for_code(activationId)             ->  123456
finish_activation(activationId)         ->  done
```

## Install

Claude Code:

```bash
claude mcp add sv-number --env SVN_API_KEY=your_key_here -- npx -y sv-number-mcp
```

Anything that reads a JSON config (Codex, Cursor, Claude Desktop):

```json
{
  "mcpServers": {
    "sv-number": {
      "command": "npx",
      "args": ["-y", "sv-number-mcp"],
      "env": { "SVN_API_KEY": "your_key_here" }
    }
  }
}
```

The key comes from [your profile](https://sms-verification-number.com/en/user/profile/)
after [signup](https://sms-verification-number.com/en/register/). The balance has to be
funded: there is no free tier on this API. The key is read from the environment and never
leaves the process, no tool returns it and no error message quotes it.

## Tools

| Tool | What it does |
| --- | --- |
| `get_balance` | what is left on the account |
| `list_countries` | every country with its id and operators |
| `list_services` | services in a country: code, price, how many are online, and the share of codes that actually arrived |
| `order_number` | order a private number for one service in one country |
| `wait_for_code` | poll until the code lands and return it, already parsed out of the SMS |
| `finish_activation` | close a successful activation |
| `cancel_activation` | cancel and get the money back |
| `request_another_sms` | ask for one more code on the same number |
| `totp_code` | compute the authenticator code locally, by RFC 6238 |

`list_services` returns a delivery rate per service and country. An agent that picks by
that number instead of by price stops paying for cheap countries where codes never arrive.

## What the server handles for you

Every call carries the mandatory `lang` parameter. Text markers that the API returns
instead of JSON are checked before anything is parsed, and turned into a sentence an agent
can act on: `NO_NUMBERS` becomes "change country, or set operator to any" rather than a
bare token. Polling runs at a sane interval instead of hammering `getStatus`, and
`wait_for_code` stops at the 20 minute life of a number.

## What it is not

Receiving verification codes is the whole job. These numbers do not send SMS, do not take
calls, and are not meant for banking, payment or government accounts. An agent that needs a
permanent number to hold a conversation wants a carrier product instead.

## Config

| Variable | Default |
| --- | --- |
| `SVN_API_KEY` | required |
| `SVN_API_BASE` | `https://sms-verification-number.com/stubs/handler_api` |
| `SVN_LANG` | `en`, sets both the language and the currency of the answers |
| `SVN_POLL_SECONDS` | `4` |

## Related

- The same product as a markdown skill: https://github.com/sv-number/skills
- API reference: https://sms-verification-number.com/en/api-sms-activate/
- Coverage and prices: https://sms-verification-number.com/en/number-for-ai-agents/

MIT. The service behind it is commercial.
