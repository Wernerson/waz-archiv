"""
WAZ archive pipeline: scrape issue metadata from waz-zh.ch and extract page
texts from the issue PDFs, skipping advertising pages.

Usage:
    uv run extract_pages.py scrape             # metadata -> issues.json
    uv run extract_pages.py extract            # PDFs + covers -> pdfs/, covers/, pages.json
"""

from __future__ import annotations

import json
import os
import re
import statistics
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

import click
import pdfplumber
import requests
from bs4 import BeautifulSoup

ARCHIVE_URL = "https://www.waz-zh.ch/Archiv"
USER_AGENT = "waz-archiv-indexer/0.1"

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

GERMAN_MONTHS = {
    "januar": 1, "februar": 2, "märz": 3, "april": 4, "mai": 5, "juni": 6,
    "juli": 7, "august": 8, "september": 9, "oktober": 10, "november": 11,
    "dezember": 12,
}


# ---------------------------------------------------------------------------
# Page extraction (ad filter + title heuristic)
# ---------------------------------------------------------------------------

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


def extract_issue_pages(pdf_path: Path) -> tuple[list[dict], list[int]]:
    """Extract non-ad pages from one PDF; returns (page records, skipped page numbers)."""
    records: list[dict] = []
    skipped: list[int] = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            if is_ad_page(text):
                skipped.append(page.page_number)
                continue
            records.append({
                "page": page.page_number,
                "title": extract_title(page),
                "text": text,
            })
    return records, skipped


# ---------------------------------------------------------------------------
# Website scraping
# ---------------------------------------------------------------------------

def make_session() -> requests.Session:
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    return session


def fetch_html(session: requests.Session, url: str, delay: float) -> BeautifulSoup:
    last_err: Exception | None = None
    for attempt in (1, 2, 3):
        time.sleep(delay * attempt)
        try:
            res = session.get(url, timeout=30)
            res.raise_for_status()
            # the server occasionally returns truncated pages; detect and retry
            if "</html>" not in res.text[-500:]:
                raise ValueError("truncated response")
            return BeautifulSoup(res.text, "html.parser")
        except (requests.RequestException, ValueError) as err:
            last_err = err
            click.echo(f"WARN {url} (attempt {attempt}): {err}", err=True)
    raise last_err  # type: ignore[misc]


def parse_german_date(text: str) -> str:
    """'Dienstag, 1. Dezember 1992' -> '1992-12-01'."""
    m = re.search(r"(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s+(\d{4})", text)
    if not m:
        raise ValueError(f"cannot parse date: {text!r}")
    day, month_name, year = m.groups()
    month = GERMAN_MONTHS[month_name.lower()]
    return f"{year}-{month:02d}-{int(day):02d}"


def local_pdf_name(pdf_url: str) -> str:
    """URL -> filesystem-friendly basename (query stripped, spaces -> _)."""
    path = urlsplit(pdf_url).path
    return unquote(path.rsplit("/", 1)[-1]).replace(" ", "_")


def local_cover_name(cover_url: str) -> str:
    """URL -> filesystem-friendly basename, prefixed with its parent directory
    id (e.g. ".../EasyDNNnews/403/Startseite1.jpg" -> "403_Startseite1.jpg")
    since the site reuses generic image names across issues."""
    parts = [p for p in urlsplit(cover_url).path.split("/") if p]
    name = unquote(parts[-1]).replace(" ", "_")
    return f"{parts[-2]}_{name}" if len(parts) > 1 else name


def download_file(session: requests.Session, url: str, dest: Path) -> None:
    """Stream a URL to disk atomically (temp file + rename)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    res = session.get(url, timeout=120, stream=True)
    res.raise_for_status()
    with open(tmp, "wb") as f:
        for chunk in res.iter_content(chunk_size=1 << 16):
            f.write(chunk)
    os.replace(tmp, dest)


def parse_issue_page(soup: BeautifulSoup, url: str) -> dict:
    title_el = soup.select_one("h3.edn_articleTitle")
    if not title_el:
        raise ValueError("no edn_articleTitle")
    title = title_el.get_text(strip=True)
    number_m = re.match(r"WAZ\s+(\S+)", title)

    time_el = soup.select_one(".edn_metaDetails time")
    if not time_el:
        raise ValueError("no <time> element")
    date = parse_german_date(time_el.get_text(strip=True))

    summary = soup.select_one(".edn_articleSummary")
    toc = []
    pdf_link = None
    if summary:
        toc = [
            re.sub(r"\s+", " ", li.get_text(" ", strip=True)).strip()
            for li in summary.select("li")
        ]
        toc = [t for t in toc if t]
        pdf_link = summary.select_one("a.pdflink") or summary.select_one('a[href*=".pdf"]')
    if pdf_link is None:
        pdf_link = soup.select_one('a.pdflink, a[href*=".pdf"]')
    if pdf_link is None:
        raise ValueError("no PDF link")
    pdf_url = requests.utils.requote_uri(urljoin(url, pdf_link["href"].strip()))

    # Front-page cover image the site already renders for the article teaser —
    # reuse it as the issue thumbnail so the frontend never has to open the PDF.
    cover_el = soup.select_one('meta[property="og:image"]')
    if cover_el is None:
        raise ValueError("no og:image meta tag")
    cover_url = requests.utils.requote_uri(urljoin(url, cover_el["content"].strip()))

    return {
        "title": title,
        "number": number_m.group(1) if number_m else None,
        "date": date,
        "url": url,
        "pdf": local_pdf_name(pdf_url),
        "pdf_url": pdf_url,
        "cover_url": cover_url,
        "toc": toc,
    }


def collect_issue_urls(session: requests.Session, delay: float) -> list[str]:
    """All issue detail URLs, chronological (years ascending)."""
    soup = fetch_html(session, ARCHIVE_URL, delay)
    years = sorted({
        int(m.group(1))
        for a in soup.select('a[href*="/Archiv/category/"]')
        if (m := re.search(r"/Archiv/category/(\d{4})", a["href"]))
    })
    click.echo(f"found {len(years)} year categories ({years[0]}–{years[-1]})")

    urls: list[str] = []
    for year in years:
        soup = fetch_html(session, f"{ARCHIVE_URL}/category/{year}", delay)
        seen: list[str] = []
        for a in soup.select('a[href*="/Archiv/waz-"]'):
            href = urljoin(ARCHIVE_URL, a["href"])
            if href not in seen:
                seen.append(href)
        # category pages list newest first -> reverse for chronological order
        urls.extend(reversed(seen))
        click.echo(f"  {year}: {len(seen)} issues")
    return urls


# ---------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------

def write_json(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.group()
def cli() -> None:
    """WAZ archive scraping and page extraction."""


@cli.command()
@click.option("--issues", type=click.Path(dir_okay=False, path_type=Path),
              default="issues.json", show_default=True, help="Metadata file to write.")
@click.option("--limit", type=int, default=None, help="Only the first N issues (testing).")
@click.option("--delay", type=float, default=0.3, show_default=True,
              help="Seconds between HTTP requests.")
def scrape(issues: Path, limit: int | None, delay: float) -> None:
    """Scrape issue metadata (number, date, TOC, PDF link) from waz-zh.ch."""
    session = make_session()
    urls = collect_issue_urls(session, delay)
    if limit:
        urls = urls[:limit]

    records = []
    for url in urls:
        record = None
        for attempt in (1, 2, 3):  # occasional truncated responses — retry
            try:
                record = parse_issue_page(fetch_html(session, url, delay), url)
                break
            except (ValueError, KeyError, requests.RequestException) as err:
                click.echo(f"WARN {url} (attempt {attempt}): {err}", err=True)
                time.sleep(2 * attempt)
        if record is None:
            continue
        records.append(record)
        click.echo(f"WAZ {record['number']}  {record['date']}  toc={len(record['toc'])}  {record['pdf']}")

    write_json(issues, records)
    click.echo(f"wrote {len(records)} issues to {issues}")


@cli.command()
@click.option("--issues", type=click.Path(exists=True, dir_okay=False, path_type=Path),
              default="issues.json", show_default=True, help="Metadata file from `scrape`.")
@click.option("--output", type=click.Path(dir_okay=False, path_type=Path),
              default="pages.json", show_default=True, help="JSON file to write.")
@click.option("--pdf-dir", type=click.Path(file_okay=False, path_type=Path),
              default="pdfs", show_default=True,
              help="PDFs are downloaded here permanently and served from this server.")
@click.option("--cover-dir", type=click.Path(file_okay=False, path_type=Path),
              default="covers", show_default=True,
              help="Cover images are downloaded here permanently and served from this server.")
@click.option("--limit", type=int, default=None, help="Only the first N issues (testing).")
@click.option("--delay", type=float, default=0.3, show_default=True,
              help="Seconds between downloads.")
@click.option("--force", is_flag=True, help="Re-extract issues already in the output.")
def extract(issues: Path, output: Path, pdf_dir: Path, cover_dir: Path, limit: int | None,
            delay: float, force: bool) -> None:
    """Extract page texts for every issue. The PDF and cover image are
    downloaded once into --pdf-dir / --cover-dir and kept there so the
    webapp can serve them directly instead of proxying waz-zh.ch."""
    issue_meta = json.loads(issues.read_text(encoding="utf-8"))
    if limit:
        issue_meta = issue_meta[:limit]

    done: dict[str, dict] = {}
    if output.exists() and not force:
        # tolerate an old-format or foreign file: only records with url+pages count
        done = {
            rec["url"]: rec
            for rec in json.loads(output.read_text(encoding="utf-8"))
            if isinstance(rec, dict) and "url" in rec and "pages" in rec
        }

    session = make_session()
    results: list[dict] = []
    n_extracted = 0
    for meta in issue_meta:
        pdf_local = pdf_dir / meta["pdf"]
        cover_name = local_cover_name(meta["cover_url"])
        cover_local = cover_dir / cover_name

        try:
            if not pdf_local.is_file():
                time.sleep(delay)
                download_file(session, meta["pdf_url"], pdf_local)
            if not cover_local.is_file():
                time.sleep(delay)
                download_file(session, meta["cover_url"], cover_local)
        except Exception as err:  # noqa: BLE001 — keep going, issue is retried next run
            click.echo(f"WARN downloading assets for {meta['title']}: {err}", err=True)
            continue

        if meta["url"] in done:
            # Assets are freshly (re-)downloaded above, but the extracted page
            # text is expensive to redo — reuse it for issues already done.
            results.append({**meta, "cover": cover_name, "pages": done[meta["url"]]["pages"]})
            continue

        try:
            page_records, skipped = extract_issue_pages(pdf_local)
        except Exception as err:  # noqa: BLE001 — keep going, issue is retried next run
            click.echo(f"WARN {meta['title']}: {err}", err=True)
            continue

        results.append({**meta, "cover": cover_name, "pages": page_records})
        n_extracted += 1
        click.echo(
            f"{meta['title']}: {len(page_records)} pages"
            + (f", ads skipped: {skipped}" if skipped else "")
        )
        write_json(output, results)

    write_json(output, results)
    click.echo(
        f"wrote {len(results)} issues to {output} "
        f"({n_extracted} extracted, {len(results) - n_extracted} reused)"
    )


if __name__ == "__main__":
    cli()
