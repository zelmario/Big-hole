#!/usr/bin/env python3
"""Render README.md to a local HTML page, so it can be read the way GitHub will show it.

Entirely offline and deliberately small: it handles the subset of Markdown this README uses --
headings, paragraphs, lists, tables, fenced code, images, links, bold and inline code -- and
nothing else. The point is to see the screenshots in place before publishing, not to be a
Markdown implementation.

    python3 tools/readme-preview.py             # -> docs/readme-preview.html
    then open http://localhost:5173/docs/readme-preview.html while `npm run dev` is up
"""
import html
import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "README.md")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/readme-preview.html")


def inline(text: str) -> str:
    """Inline spans. Code first, so nothing inside a code span is re-interpreted."""
    parts = re.split(r"(`[^`]+`)", text)
    out = []
    for part in parts:
        if part.startswith("`") and part.endswith("`") and len(part) > 1:
            out.append(f"<code>{html.escape(part[1:-1])}</code>")
            continue
        p = html.escape(part)
        p = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", r'<img alt="\1" src="../\2">', p)
        p = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', p)
        p = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", p)
        p = re.sub(r"(?<![*\w])\*([^*]+)\*(?!\*)", r"<em>\1</em>", p)
        out.append(p)
    return "".join(out)


def render(md: str) -> str:
    lines = md.split("\n")
    out, i = [], 0
    while i < len(lines):
        line = lines[i]

        if line.startswith("```"):
            i += 1
            body = []
            while i < len(lines) and not lines[i].startswith("```"):
                body.append(html.escape(lines[i]))
                i += 1
            out.append("<pre><code>" + "\n".join(body) + "</code></pre>")
            i += 1
            continue

        if re.match(r"^#{1,6} ", line):
            level = len(line) - len(line.lstrip("#"))
            out.append(f"<h{level}>{inline(line[level:].strip())}</h{level}>")
            i += 1
            continue

        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append(lines[i])
                i += 1
            cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
            body = [r for r in cells if not all(set(c) <= set("-: ") for c in r)]
            head, rest = body[0], body[1:]
            table = ["<table><thead><tr>"]
            table += [f"<th>{inline(c)}</th>" for c in head]
            table.append("</tr></thead><tbody>")
            for row in rest:
                table.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in row) + "</tr>")
            table.append("</tbody></table>")
            out.append("".join(table))
            continue

        if re.match(r"^\s*[-*] |^\s*\d+\. ", line):
            ordered = bool(re.match(r"^\s*\d+\. ", line))
            items = []
            while i < len(lines) and re.match(r"^\s*([-*] |\d+\. )", lines[i]):
                item = re.sub(r"^\s*([-*] |\d+\. )", "", lines[i])
                i += 1
                # Continuation lines are indented under the bullet.
                while i < len(lines) and lines[i].startswith("  ") and lines[i].strip():
                    item += " " + lines[i].strip()
                    i += 1
                items.append(f"<li>{inline(item)}</li>")
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>" + "".join(items) + f"</{tag}>")
            continue

        if line.strip() == "---":
            out.append("<hr>")
            i += 1
            continue

        if line.strip() == "":
            i += 1
            continue

        para = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(
            r"^(#{1,6} |```|\||\s*[-*] |\s*\d+\. |---$)", lines[i]
        ):
            para.append(lines[i])
            i += 1
        out.append(f"<p>{inline(' '.join(para))}</p>")

    return "\n".join(out)


CSS = """
:root { color-scheme: dark; }
body { max-width: 900px; margin: 0 auto; padding: 40px 24px 120px;
  background: #0d1117; color: #e6edf3;
  font: 16px/1.6 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
h1 { font-size: 2em; border-bottom: 1px solid #30363d; padding-bottom: .3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #30363d; padding-bottom: .3em; margin-top: 2em; }
h3 { font-size: 1.2em; margin-top: 1.6em; }
a { color: #4493f8; }
code { background: #21262d; padding: .15em .4em; border-radius: 6px; font-size: 85%;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: #161b22; padding: 16px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 13px; }
img { max-width: 100%; border: 1px solid #30363d; border-radius: 8px; margin: 12px 0; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; display: block; overflow-x: auto; }
th, td { border: 1px solid #30363d; padding: 6px 13px; text-align: left; }
th { background: #161b22; }
hr { border: 0; border-top: 1px solid #30363d; margin: 32px 0; }
blockquote { border-left: 4px solid #30363d; margin: 0; padding-left: 16px; color: #8b949e; }
"""

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(
    f"<!doctype html><html><head><meta charset=utf-8><title>Big Hole — README preview</title>"
    f"<style>{CSS}</style></head><body>{render(SRC.read_text())}</body></html>"
)
print(f"{OUT} written — open http://localhost:5173/{OUT} while the dev server is running")
