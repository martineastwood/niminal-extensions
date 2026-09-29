#!/usr/bin/env python3
"""Fetch page content through Tavily Extract. Reads tool arguments as JSON on stdin."""

import json
import os
import sys
import urllib.error
import urllib.request

EXTRACT_URL = "https://api.tavily.com/extract"
TIMEOUT_SECONDS = 60
MAX_URLS = 20
MAX_CHARS_PER_URL = 12000
MAX_TOTAL_CHARS = 80000


def requested_urls(arguments):
    urls = arguments.get("urls")
    if not isinstance(urls, list):
        raise RuntimeError("urls must be a non-empty array of strings")
    cleaned = [url.strip() for url in urls if isinstance(url, str) and url.strip()]
    if not cleaned:
        raise RuntimeError("urls must be a non-empty array of strings")
    return cleaned[:MAX_URLS]


def extract(arguments):
    key = os.environ.get("TAVILY_API_KEY", "").strip()
    if not key:
        raise RuntimeError("TAVILY_API_KEY is not set")
    body = {"urls": requested_urls(arguments)}
    for field in ("extract_depth", "format"):
        if arguments.get(field):
            body[field] = arguments[field]
    request = urllib.request.Request(
        EXTRACT_URL,
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
    budget = MAX_TOTAL_CHARS
    for result in data.get("results") or []:
        url = (result.get("url") or "").strip()
        text = (result.get("raw_content") or "").strip()
        if not text:
            blocks.append(url + "\n\nNo content returned.")
            continue
        allowance = min(MAX_CHARS_PER_URL, budget)
        if allowance <= 0:
            blocks.append(url + "\n\nContent omitted: output budget reached.")
            continue
        blocks.append(url + "\n\n" + clip(text, allowance))
        budget -= min(len(text), allowance)
    for failure in data.get("failed_results") or []:
        url = (failure.get("url") or "").strip()
        reason = (failure.get("error") or "unknown error").strip()
        blocks.append(url + "\n\nFailed: " + reason)
    return "\n\n".join(blocks) or "No content."


def main():
    try:
        arguments = json.load(sys.stdin)
    except ValueError:
        print("tool error: arguments must be one JSON object", file=sys.stderr)
        return 1
    try:
        print(json.dumps(format_results(extract(arguments))))
    except Exception as error:
        print(f"tool error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
