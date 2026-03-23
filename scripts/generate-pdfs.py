#!/usr/bin/env python3
"""Generate PDF files for each recipe using WeasyPrint."""

import sys
from pathlib import Path

try:
    from weasyprint import HTML, CSS
except ImportError:
    print("weasyprint not installed — skipping PDF generation", file=sys.stderr)
    sys.exit(0)

PUBLIC = Path("public").resolve()
RECIPES = PUBLIC / "recipes"
STYLESHEET = CSS(filename=str(PUBLIC / "css" / "style.css"))

if not RECIPES.is_dir():
    print(f"No recipes directory at {RECIPES}", file=sys.stderr)
    sys.exit(1)

count = 0
for index_html in sorted(RECIPES.glob("*/index.html")):
    recipe_dir = index_html.parent
    pdf_name = f"{recipe_dir.name}.pdf"
    pdf_path = recipe_dir / pdf_name
    print(f"  {recipe_dir.name} → {pdf_name}")
    HTML(filename=str(index_html)).write_pdf(str(pdf_path), stylesheets=[STYLESHEET])
    count += 1

print(f"Generated {count} PDFs")
