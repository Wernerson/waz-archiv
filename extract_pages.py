"""
Page-level text extraction from magazine PDFs, skipping advertising pages.

Usage:
    uv run extract_pages.py
    uv run extract_pages.py --pdf-dir ./pdfs/ --output pages.json
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import click
import pdfplumber

# Contact/commerce vocabulary typical for ad blocks, incl. Swiss phone numbers.
AD_KEYWORDS = re.compile(
    r"(Tel\.|Telefon|Fax|www\.|GmbH|Inserat|Anzeige|Reklame|\b0\d{2}\s\d{3}\s\d{2}\s\d{2}\b)",
    re.IGNORECASE,
)
AD_MIN_HINTS = 3
AD_MIN_DENSITY = 2.5   # keyword hits per 100 words; ad pages score >4, editorial <2
MIN_PAGE_WORDS = 60    # below this a page carries no usable content

_FILENAME_PAT = re.compile(r"(\d{4})_(\d{1,2})\.pdf$", re.IGNORECASE)


def parse_issue_date(filename: str) -> str:
    """1993_06.pdf -> 1993-06-01 (second field is the issue number)."""
    m = _FILENAME_PAT.search(filename)
    if not m:
        raise ValueError(f"cannot parse issue date from filename: {filename}")
    year, number = m.groups()
    return f"{year}-{int(number):02d}-01"


def is_ad_page(text: str) -> bool:
    # "ANZEIGEN" section header, printed letter-spaced ("A N Z E I G E N")
    # or with doubled glyphs ("AA NN ZZ EE ..."), hence the run-collapsed check.
    head = re.sub(r"\s+", "", text[:200]).upper()
    collapsed = re.sub(r"(.)\1+", r"\1", head)
    if "ANZEIGEN" in head or "ANZEIGEN" in collapsed:
        return True
    n_words = len(text.split())
    if n_words < MIN_PAGE_WORDS:
        return True
    hints = len(AD_KEYWORDS.findall(text))
    density = hints / n_words * 100
    return hints >= AD_MIN_HINTS and density >= AD_MIN_DENSITY


@click.command()
@click.option("--pdf-dir", type=click.Path(exists=True, file_okay=False, path_type=Path),
              default="pdfs", show_default=True, help="Directory containing the issue PDFs.")
@click.option("--output", type=click.Path(dir_okay=False, path_type=Path),
              default="pages.json", show_default=True, help="JSON file to write.")
def extract(pdf_dir: Path, output: Path) -> None:
    """Extract page texts from all PDFs in PDF_DIR, dropping advertising pages."""
    pdf_paths = sorted(pdf_dir.glob("*.pdf"))
    if not pdf_paths:
        click.echo(f"no PDFs found in {pdf_dir}", err=True)
        sys.exit(1)

    records = []
    for pdf_path in pdf_paths:
        issue_date = parse_issue_date(pdf_path.name)
        skipped = []
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text() or ""
                if is_ad_page(text):
                    skipped.append(page.page_number)
                    continue
                records.append({
                    "issue_date": issue_date,
                    "page": page.page_number,
                    "text": text,
                })
            n_pages = len(pdf.pages)
        click.echo(
            f"{pdf_path.name}: {n_pages - len(skipped)}/{n_pages} pages extracted"
            + (f", ads skipped: {skipped}" if skipped else "")
        )

    output.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    click.echo(f"wrote {len(records)} pages to {output}")


if __name__ == "__main__":
    extract()
