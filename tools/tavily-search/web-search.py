#!/usr/bin/env python3
"""Web search powered by Tavily. Reads tool arguments as JSON on stdin."""

import json
import os
import sys
import urllib.error
import urllib.request

SEARCH_URL = "https://api.tavily.com/search"
TIMEOUT_SECONDS = 40
DEFAULT_MAX_RESULTS = 5
MAX_RESULTS = 20
OPTIONAL_BODY_FIELDS = (
    "search_depth",
    "time_range",
    "days",
    "include_domains",
    "exclude_domains",
    "include_raw_content",
)
MAX_RAW_CHARS = 12000
MAX_RAW_TOTAL_CHARS = 80000


def result_limit(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return DEFAULT_MAX_RESULTS
    return max(1, min(MAX_RESULTS, number))


def search(arguments):
    key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not key:
        raise RuntimeError("TAVILY_API_KEY is not set")
    query = (arguments.get("query") or "").strip()
    if not query:
        raise RuntimeError("query is required")
    body = {
        "query": query,
        "topic": arguments.get("topic") or "general",
        "max_results": result_limit(arguments.get("max_results")),
        "include_answer": arguments.get("include_answer") is not False,
    }
    for field in OPTIONAL_BODY_FIELDS:
        if arguments.get(field):
            body[field] = arguments[field]
    request = urllib.request.Request(
        SEARCH_URL,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace").strip()
        raise RuntimeError(f"Tavily returned HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"cannot reach Tavily: {error.reason}") from error


def clip(text, limit):
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n[truncated]"


def format_results(data):
    blocks = []
    raw_budget = MAX_RAW_TOTAL_CHARS
    answer = (data.get("answer") or "").strip()
    if answer:
        blocks.append("Answer: " + answer)
    for index, result in enumerate(data.get("results") or [], start=1):
        title = (result.get("title") or "").strip() or "(untitled)"
        url = (result.get("url") or "").strip()
        content = " ".join((result.get("content") or "").split())
        block = f"[{index}] {title}\n{url}\n{content}".rstrip()
        raw = (result.get("raw_content") or "").strip()
        if raw and raw_budget > 0:
            allowance = min(MAX_RAW_CHARS, raw_budget)
            block += "\n\nFull text:\n" + clip(raw, allowance)
            raw_budget -= min(len(raw), allowance)
        blocks.append(block)
    return "\n\n".join(blocks) or "No results."


def main():
    try:
        arguments = json.load(sys.stdin)
    except ValueError:
        print("tool error: arguments must be one JSON object", file=sys.stderr)
        return 1
    try:
        print(json.dumps(format_results(search(arguments))))
    except Exception as error:
        print(f"tool error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
