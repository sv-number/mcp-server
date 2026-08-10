# SV Number MCP server

Phone numbers as tools. Your agent orders a private number in the country a service
expects, reads the SMS verification code straight from the API, and hands the number back.
Nine tools over stdio, no SDK to learn.

200+ countries, the widest coverage in this category. Every other claim on this page is
checkable too, but this one takes a single call: run `list_countries` and count the rows.

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
| `list_services` | find the code for a site: search by name or domain, best match first, price, how many are online, and the share of codes that actually arrived |
| `order_number` | order a private number for one service in one country |
| `wait_for_code` | poll until the code lands and return it, already parsed out of the SMS |
| `finish_activation` | close a successful activation |
| `cancel_activation` | cancel and get the money back |
| `request_another_sms` | ask for one more code on the same number |
| `totp_code` | compute the authenticator code locally, by RFC 6238 |

`list_services` answers with `matches` ranked best first plus `notInList`, the fallback
service. It takes a site name or a URL, so `discord.com` finds `Discord`, and it ranks a
whole word above a substring so `x` puts `X.com (Twitter)` above `Maxim`. Codes are
arbitrary and must never be recalled from memory: `uk` is Airbnb, `re` is Coinbase, `tn` is
LinkedIn. When nothing matches, the answer says so and points at another country, because
the catalogue is not the same everywhere, and at `ot` ("Not on list"), which receives SMS
from any sender that is not in the list. A site that has its own code sends to that code,
so `ot` is a fallback and not a wildcard.

`deliveredPercent` is the delivery rate for that service and country, and `null` when the
pair has no statistics yet, which is the common case. Where there is a number, pick by it
instead of by price; where there is not, `online` shows how big the live pool is, which is
the next best signal.

## What the server handles for you

Every call carries `lang`. The API answers without it, but then it prices in another
currency, so the server never leaves it out. Text markers that the API returns
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
