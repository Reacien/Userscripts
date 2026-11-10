#!/usr/bin/env python3
"""
Build script: transforms the SMMO Travel Companion userscript into
extension-ready content.js and styles.css.

Reads:  SimpleMMO/smmo-travel-companion.user.js
Writes: dist/content.js
        dist/styles.css
"""

import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
USERSRIPT = os.path.join(ROOT, "smmo-travel-companion.user.js")
OUTDIR = os.path.join(ROOT, "dist")

def main():
    with open(USERSRIPT, "r", encoding="utf-8") as f:
        text = f.read()

    # 1. Strip the ==UserScript== header block
    header_start = text.find("// ==UserScript==")
    header_end = text.find("// ==/UserScript==")
    if header_start == -1 or header_end == -1:
        sys.exit("Could not find ==UserScript== header block")
    header_end = text.find("\n", header_end) + 1
    body = text[header_end:]

    # 2. Find the IIFE start
    iife_start = body.find("(function ()")
    if iife_start == -1:
        sys.exit("Could not find IIFE start")

    # 3. Find the style block
    style_start = body.find("const style = document.createElement")
    style_append = body.find("document.head.appendChild(style)")
    if style_start == -1 or style_append == -1:
        sys.exit("Could not find style block")
    style_end = style_append + len("document.head.appendChild(style);")
    dollar_start = body.find("const $ = (id)", style_end)

    pre_style = body[:style_start].rstrip()
    style_block = body[style_start:style_end]
    post_style = body[dollar_start:]

    # 4. Extract CSS between backticks
    css_start = style_block.find("`") + 1
    css_end = style_block.rfind("`")
    css_content = style_block[css_start:css_end]

    # 5. Build content.js - replace inline style injection with a comment
    css_injection_replacement = (
        "  // Styles are loaded via manifest.json -> styles.css "
        "(declared in content_scripts css)"
    )
    content_js = (
        pre_style + "\n\n" + css_injection_replacement + "\n\n" + post_style
    )

    # 6. Write output files
    os.makedirs(OUTDIR, exist_ok=True)
    with open(os.path.join(OUTDIR, "content.js"), "w", encoding="utf-8") as f:
        f.write(content_js)
    with open(os.path.join(OUTDIR, "styles.css"), "w", encoding="utf-8") as f:
        f.write(css_content)

    print(f"Wrote {OUTDIR}/content.js ({len(content_js)} chars)")
    print(f"Wrote {OUTDIR}/styles.css ({len(css_content)} chars)")

if __name__ == "__main__":
    main()
