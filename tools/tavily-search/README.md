# tavily-search

Give niminal a `web_search` external tool backed by the
[Tavily](https://tavily.com) search API.

The tool returns a short synthesized answer (optional) plus ranked results with
titles, URLs, and content excerpts. You can scope a search to domains or a
recent period, or ask for full page text instead of excerpts. It declares the
`network` capability, so it asks for permission like any other tool that
reaches the network.

| Argument | Type | Description |
| --- | --- | --- |
| `query` | string | Search query. Required. |
| `max_results` | integer | 1-20 results. Defaults to 5. |
| `topic` | string | `general`, `news`, or `finance`. Defaults to `general`. |
| `include_answer` | boolean | Include a synthesized answer. Defaults to `true`. |
| `search_depth` | string | `basic`, `advanced`, `fast`, or `ultra-fast`. Defaults to `basic`. |
| `time_range` | string | Limit to `day`, `week`, `month`, or `year`. |
| `days` | integer | Limit news results to the last N days. |
| `include_domains` | string[] | Only return results from these domains. |
| `exclude_domains` | string[] | Drop results from these domains. |
| `include_raw_content` | boolean | Return full page text per result instead of an excerpt. Defaults to `false`. |

## Searching with a filter

Restrict a query to the sites and the period you trust:

```json
web_search({
  "query": "breaking change migration guide",
  "include_domains": ["docs.example.com"],
  "time_range": "month"
})
```

## Reading whole pages

Set `include_raw_content` to get the full page text for each result. Each page
is capped at 12,000 characters and one call is capped at about 80,000
characters; text over a cap ends with `[truncated]`. For a specific page, the
[tavily-extract](../tavily-extract/) tool fetches it directly.

## Requirements

- Python 3 (stdlib only)
- A Tavily API key in `TAVILY_API_KEY`

## Install

Copy this directory into a niminal tools root and make the program executable:

```bash
cp -r tavily-search ~/.niminal/tools/
```

Export the key where niminal runs:

```bash
export TAVILY_API_KEY=tvly-...
```

Restart niminal or run `/reload`.
