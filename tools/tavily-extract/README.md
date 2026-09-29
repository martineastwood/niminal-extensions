# tavily-extract

Give niminal a `fetch_content` tool that reads a page instead of a snippet.
It uses the [Tavily](https://tavily.com) Extract API to turn a URL into clean
markdown, so the model can work with a whole article, changelog, or docs page
after a search points at it.

```json
fetch_content({"urls": ["https://docs.example.com/guide"]})
```

The tool declares the `network` capability, so it asks for permission like any
other tool that reaches the network.

## What you get back

One block per URL: the URL, then the page text as markdown.

```text
https://docs.example.com/guide

# Installation

Run the following command to install the package...
```

URLs that could not be read are reported at the end of the output with the
reason Tavily gave, so a partial failure is still useful.

## Arguments

| Argument | Type | Description |
| --- | --- | --- |
| `urls` | string[] | Page URLs to fetch. Required, up to 20. |
| `extract_depth` | string | `basic` or `advanced`. Use `advanced` for pages built by JavaScript. Defaults to `basic`. |
| `format` | string | `markdown` or `text`. Defaults to `markdown`. |

## How much text comes back

Every page is capped at 12,000 characters and a single call is capped at about
80,000 characters. Text over the cap ends with `[truncated]`. Fetch fewer URLs
per call, or search with `include_raw_content`, when you need to stay small.

## Requirements

- Python 3 (stdlib only)
- A Tavily API key in `TAVILY_API_KEY`
- Pages that Tavily can reach over HTTP or HTTPS. Local files and pages behind
  a login are not supported.

## Install

Copy this directory into a niminal tools root and make the program executable:

```bash
cp -r tavily-extract ~/.niminal/tools/
chmod +x ~/.niminal/tools/tavily-extract/extract.py
```

Export the key where niminal runs:

```bash
export TAVILY_API_KEY=tvly-...
```

Restart niminal or run `/reload`. The model can now call `fetch_content`
alongside `web_search`.

## Troubleshooting

`tool error: TAVILY_API_KEY is not set` means the key is missing from the
environment niminal runs in, not just from your shell.

`tool error: Tavily returned HTTP 401` means the key was rejected. `HTTP 429`
is rate limiting, and `HTTP 432` or `HTTP 433` mean the plan limit or the
pay-as-you-go limit was reached.

## Next steps

- [tavily-search](../tavily-search/) for the search tool that pairs with this one
- [External tools](https://niminal.dev/guides/external-tools/) for the manifest
  format
