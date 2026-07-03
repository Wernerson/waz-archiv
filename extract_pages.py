"""
Page-level text extraction from magazine PDFs, skipping advertising pages.

Usage:
    uv run extract_pages.py
    uv run extract_pages.py --pdf-dir ./pdfs/ --output pages.json
"""

from __future__ import annotations

import json
import re
import statistics
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

HEADING_FONT_RATIO = 1.3   # heading word size >= ratio * median page font size
TITLE_MAX_WORDS = 12
TITLE_MIN_ALPHA_RATIO = 0.75
TITLE_MAX_TOP = 0.72       # headings below this page fraction are ad/footer territory

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


def _collapse_letter_spacing(words: list[str]) -> list[str]:
    """Merge runs of single-letter words: ["W","E","G","E","zur"] -> ["WEGE","zur"]."""
    out: list[str] = []
    run: list[str] = []
    for w in words:
        if len(w) == 1 and w.isalpha():
            run.append(w)
        else:
            if run:
                out.append("".join(run))
                run = []
            out.append(w)
    if run:
        out.append("".join(run))
    return out


def _title_ok(title: str) -> bool:
    """Display-quality gate; OCR-mangled headings must fail this."""
    if not 4 <= len(title) <= 100:
        return False
    if not 1 <= len(title.split()) <= TITLE_MAX_WORDS:
        return False
    letters = sum(ch.isalpha() for ch in title)
    non_space = sum(not ch.isspace() for ch in title)
    if letters / non_space < TITLE_MIN_ALPHA_RATIO:
        return False
    # Headline styling in the OCR'd 90s issues is all caps with unreliable
    # drop caps and spacing — a real mixed-case title is mostly lowercase.
    if sum(ch.islower() for ch in title) / letters < 0.3:
        return False
    # German titles start with an uppercase letter (or a digit, e.g. a year).
    if not (title[0].isupper() or title[0].isdigit()):
        return False
    # Digit-letter hybrids ("8pielberger") are OCR artifacts or ad copy.
    if any(re.search(r"\d[^\W\d]|[^\W\d]\d", w) for w in title.split()):
        return False
    return True


def extract_title(page) -> str | None:
    """Most prominent heading on the page that passes the quality gate."""
    sizes = [c["size"] for c in page.chars if c.get("text", "").strip()]
    if not sizes:
        return None
    median = statistics.median(sizes)
    heading_words = [
        w for w in page.extract_words(extra_attrs=["size"])
        if w["size"] >= HEADING_FONT_RATIO * median
    ]
    if not heading_words:
        return None

    # Cluster heading words into visual lines: a new line starts when the
    # vertical jump exceeds half the font size (handles slight baseline
    # wobble between differently-sized words of one headline).
    heading_words.sort(key=lambda w: (w["top"], w["x0"]))
    lines: list[list[dict]] = [[heading_words[0]]]
    for w in heading_words[1:]:
        prev = lines[-1][0]
        if w["top"] - prev["top"] < 0.5 * max(w["size"], prev["size"]):
            lines[-1].append(w)
        else:
            lines.append([w])

    # Split each line on large horizontal gaps so side-by-side headings in
    # different columns stay separate.
    segments = []
    for line in lines:
        ws = sorted(line, key=lambda w: w["x0"])
        seg = [ws[0]]
        for w in ws[1:]:
            if w["x0"] - seg[-1]["x1"] > 3 * w["size"]:
                segments.append(seg)
                seg = [w]
            else:
                seg.append(w)
        segments.append(seg)

    # Merge consecutive lines of one multi-line heading: similar font size,
    # small vertical gap, overlapping horizontal extent.
    candidates: list[dict] = []
    for seg in segments:
        cand = {
            "size": statistics.mean(w["size"] for w in seg),
            "top": min(w["top"] for w in seg),
            "x0": min(w["x0"] for w in seg),
            "x1": max(w["x1"] for w in seg),
            "words": [w["text"] for w in seg],
        }
        prev = candidates[-1] if candidates else None
        if (
            prev
            and abs(cand["size"] - prev["size"]) / prev["size"] < 0.15
            and 0 <= cand["top"] - prev["top"] < 2.2 * prev["size"]
            and cand["x0"] < prev["x1"] and prev["x0"] < cand["x1"]
        ):
            prev["words"] += cand["words"]
            prev["top"] = cand["top"]
            prev["x0"] = min(prev["x0"], cand["x0"])
            prev["x1"] = max(prev["x1"], cand["x1"])
        else:
            candidates.append(cand)

    for cand in sorted(candidates, key=lambda c: -c["size"]):
        if cand["top"] > TITLE_MAX_TOP * page.height:
            continue
        title = " ".join(_collapse_letter_spacing(cand["words"]))
        title = re.sub(r"\s+", " ", title).strip(" .·-–—~_|")
        if _title_ok(title):
            return title
    return None


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
                    "title": extract_title(page),
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
