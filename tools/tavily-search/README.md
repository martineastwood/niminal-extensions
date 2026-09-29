# tavily-search

Give niminal a `web_search` external tool backed by the
[Tavily](https://tavily.com) search API.

The tool returns a short synthesized answer (optional) plus ranked results with
titles, URLs, and content excerpts. It declares the `network` capability, so it
asks for permission like any other tool that reaches the network.

| Argument | Type | Description |
| --- | --- | --- |
| `query` | string | Search query. Required. |
| `max_results` | integer | 1-20 results. Defaults to 5. |
| `topic` | string | `general` or `news`. Defaults to `general`. |
| `include_answer` | boolean | Include a synthesized answer. Defaults to `true`. |

## Requirements

- Python 3 (stdlib only)
- A Tavily API key in `TAVILY_API_KEY`

## Install

Copy this directory into a niminal tools root and make the program executable:

```bash
cp -r tavily-search ~/.niminal/tools/
chmod +x ~/.niminal/tools/tavily-search/web-search.py
```

Export the key where niminal runs:

```bash
export TAVILY_API_KEY=tvly-...
```

Restart niminal or run `/reload`.
