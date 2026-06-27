"""
Magazine archive ingestion script.

Usage:
    uv run ingest.py --pdf-dir ./pdfs/
    uv run ingest.py --pdf-dir ./pdfs/ --reindex
"""

from __future__ import annotations

import json
import os
import re
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import click
import pdfplumber
from opensearchpy import OpenSearch, helpers
from sentence_transformers import SentenceTransformer

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

INDEX_NAME = "articles"
PIPELINE_NAME = "hybrid-pipeline"
EMBED_MODEL = "all-MiniLM-L6-v2"
EMBED_DIM = 384
EMBED_BATCH = 32
HEADING_FONT_RATIO = 1.5   # heading font size >= ratio * median page font
HEADING_MIN_WORDS = 3
AD_MAX_WORDS = 50
AD_KEYWORDS = re.compile(r"\b(Anzeige|Tel\.|Telefon|www\.|GmbH|AG|Fax)\b", re.IGNORECASE)

INDEX_BODY = {
    "settings": {
        "index.knn": True,
        "number_of_shards": 1,
        "number_of_replicas": 0,
    },
    "mappings": {
        "properties": {
            "issue_id":       {"type": "keyword"},
            "issue_filename": {"type": "keyword"},
            "issue_year":     {"type": "integer"},
            "issue_date":     {"type": "date", "format": "yyyy-MM-dd"},
            "issue_number":   {"type": "integer"},
            "type":           {"type": "keyword"},
            "title":          {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
            "text":           {"type": "text", "analyzer": "german"},
            "page_start":     {"type": "integer"},
            "page_end":       {"type": "integer"},
            "embedding": {
                "type": "knn_vector",
                "dimension": EMBED_DIM,
                "method": {
                    "name": "hnsw",
                    "engine": "lucene",
                    "parameters": {"ef_construction": 128, "m": 16},
                },
            },
        }
    },
}

PIPELINE_BODY = {
    "phase_results_processors": [
        {
            "normalization-processor": {
                "normalization": {"technique": "min_max"},
                "combination": {
                    "technique": "arithmetic_mean",
                    "parameters": {"weights": [0.4, 0.6]},
                },
            }
        }
    ]
}

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Article:
    title: str
    text: str
    page_start: int
    page_end: int
    type: str = "article"  # "article" or "advertisement"


@dataclass
class IssueMetadata:
    issue_id: str
    filename: str
    year: int
    date: str          # ISO yyyy-MM-dd
    number: int | None = None


# ---------------------------------------------------------------------------
# Filename parsing
# ---------------------------------------------------------------------------

# Supported filename patterns:
#   YYYY-MM.pdf           → year=YYYY, number=month
#   YYYY_NN.pdf           → year=YYYY, number=NN
#   YYYY-MM-DD.pdf        → year=YYYY, number=month
#   anything_YYYY_NN.pdf  → year=YYYY, number=NN
_PAT_YYYY_MM = re.compile(r"(\d{4})[_-](\d{1,2})(?:[_-]\d{1,2})?\.pdf$", re.IGNORECASE)


def parse_filename(path: Path) -> IssueMetadata:
    name = path.name
    m = _PAT_YYYY_MM.search(name)
    if m:
        year, number = int(m.group(1)), int(m.group(2))
        date = f"{year:04d}-{number:02d}-01"
        issue_id = f"{year:04d}_{number:02d}"
        return IssueMetadata(issue_id=issue_id, filename=name, year=year, date=date, number=number)
    # Fallback: just extract a 4-digit year if present
    year_m = re.search(r"(\d{4})", name)
    year = int(year_m.group(1)) if year_m else 0
    issue_id = re.sub(r"\.pdf$", "", name, flags=re.IGNORECASE)
    return IssueMetadata(issue_id=issue_id, filename=name, year=year, date=f"{year:04d}-01-01")


# ---------------------------------------------------------------------------
# PDF extraction
# ---------------------------------------------------------------------------

@dataclass
class PageBlock:
    """One contiguous run of words on a page."""
    words: list[dict]

    @property
    def text(self) -> str:
        return " ".join(w["text"] for w in self.words)

    @property
    def font_size(self) -> float:
        sizes = [w.get("size", 0) for w in self.words if w.get("size")]
        return statistics.mean(sizes) if sizes else 0.0

    @property
    def top(self) -> float:
        return self.words[0].get("top", 0) if self.words else 0.0


def _group_into_lines(words: list[dict], y_tolerance: float = 3.0) -> list[list[dict]]:
    """Group words that share approximately the same baseline into lines."""
    if not words:
        return []
    lines: list[list[dict]] = []
    current: list[dict] = [words[0]]
    for w in words[1:]:
        if abs(w.get("top", 0) - current[-1].get("top", 0)) <= y_tolerance:
            current.append(w)
        else:
            lines.append(current)
            current = [w]
    lines.append(current)
    return lines


def extract_pages(pdf_path: Path) -> list[tuple[int, list[list[dict]]]]:
    """
    Returns list of (1-based page_number, lines) where each line is a list of word dicts.
    Word dicts include: text, x0, y0, x1, y1, top, size, fontname.
    """
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages, start=1):
            words = page.extract_words(extra_attrs=["fontname", "size"]) or []
            lines = _group_into_lines(words)
            pages.append((i, lines, len(page.images or [])))
    return pages


# ---------------------------------------------------------------------------
# Article segmentation
# ---------------------------------------------------------------------------

def _median_font_size(lines: list[list[dict]]) -> float:
    sizes = [w.get("size", 0) for line in lines for w in line if w.get("size")]
    return statistics.median(sizes) if sizes else 12.0


def _is_heading(line: list[dict], median_size: float) -> bool:
    if len(line) < HEADING_MIN_WORDS:
        return False
    avg = statistics.mean(w.get("size", 0) for w in line if w.get("size") or True)
    return avg >= median_size * HEADING_FONT_RATIO


def _is_advertisement(text: str, image_count: int, word_count: int) -> bool:
    if image_count > max(1, word_count // 20):
        return True
    if word_count < AD_MAX_WORDS and AD_KEYWORDS.search(text):
        return True
    return False


def _line_text(line: list[dict]) -> str:
    return " ".join(w["text"] for w in line)


def segment_articles(pages: list[tuple[int, list[list[dict]], int]]) -> list[Article]:
    """
    Detect article boundaries across pages and return a flat list of Articles.
    Multi-page articles are stitched when a page ends mid-sentence.
    """
    articles: list[Article] = []

    # State for current open article
    cur_title: str = ""
    cur_lines: list[str] = []
    cur_page_start: int = 1
    cur_page_end: int = 1

    def flush(page_end: int) -> None:
        nonlocal cur_title, cur_lines, cur_page_start, cur_page_end
        if not cur_lines:
            return
        text = " ".join(cur_lines).strip()
        word_count = len(text.split())
        # Get image count for the first page of this article
        img_count = next((img for pn, _, img in pages if pn == cur_page_start), 0)
        art_type = "advertisement" if _is_advertisement(text, img_count, word_count) else "article"
        articles.append(Article(
            title=cur_title or text[:60],
            text=text,
            page_start=cur_page_start,
            page_end=page_end,
            type=art_type,
        ))
        cur_title = ""
        cur_lines = []

    for page_num, lines, image_count in pages:
        if not lines:
            flush(page_num - 1)
            continue

        median_size = _median_font_size(lines)
        page_started_new_article = False

        for line in lines:
            line_str = _line_text(line).strip()
            if not line_str:
                continue

            if _is_heading(line, median_size):
                # Close previous article before starting a new one
                flush(page_num - 1 if not page_started_new_article else page_num)
                cur_title = line_str
                cur_page_start = page_num
                cur_page_end = page_num
                page_started_new_article = True
            else:
                cur_lines.append(line_str)
                cur_page_end = page_num

        # Check if article continues onto next page (no terminal punctuation at page end)
        last_line = _line_text(lines[-1]).strip() if lines else ""
        ends_mid_sentence = last_line and last_line[-1] not in ".!?:»"

        if not ends_mid_sentence:
            # Flush completed articles at natural paragraph breaks
            # (but only if we started a new article on this page, otherwise let it flow)
            pass  # keep accumulating; flush happens when next heading is found or PDF ends

    flush(pages[-1][0] if pages else 1)
    return articles


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

_model: SentenceTransformer | None = None


def get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        click.echo(f"Loading embedding model {EMBED_MODEL}...")
        _model = SentenceTransformer(EMBED_MODEL)
    return _model


def embed_articles(articles: list[Article]) -> list[list[float]]:
    model = get_model()
    texts = [f"{a.title}\n\n{a.text}"[:2048] for a in articles]
    embeddings = model.encode(
        texts,
        batch_size=EMBED_BATCH,
        show_progress_bar=len(texts) > EMBED_BATCH,
        normalize_embeddings=True,
    )
    return [e.tolist() for e in embeddings]


# ---------------------------------------------------------------------------
# OpenSearch client
# ---------------------------------------------------------------------------

def make_client() -> OpenSearch:
    url = os.environ.get("OPENSEARCH_URL", "http://localhost:9200")
    return OpenSearch(url, use_ssl=False, verify_certs=False, ssl_show_warn=False)


def setup_index(client: OpenSearch) -> None:
    if not client.indices.exists(index=INDEX_NAME):
        click.echo(f"Creating index '{INDEX_NAME}'...")
        client.indices.create(index=INDEX_NAME, body=INDEX_BODY)
    try:
        client.http.put(f"/_search/pipeline/{PIPELINE_NAME}", body=PIPELINE_BODY)
    except Exception as e:
        click.echo(f"Warning: could not create search pipeline: {e}", err=True)


def issue_already_indexed(client: OpenSearch, issue_id: str) -> bool:
    resp = client.count(index=INDEX_NAME, body={"query": {"term": {"issue_id": issue_id}}})
    return resp["count"] > 0


def bulk_upsert(client: OpenSearch, docs: list[dict]) -> tuple[int, int]:
    actions = [
        {
            "_op_type": "index",
            "_index": INDEX_NAME,
            "_id": d["_id"],
            **{k: v for k, v in d.items() if k != "_id"},
        }
        for d in docs
    ]
    ok, errors = helpers.bulk(client, actions, raise_on_error=False)
    return ok, len(errors)


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process_pdf(
    pdf_path: Path,
    meta: IssueMetadata,
    client: OpenSearch,
    reindex: bool,
) -> dict:
    stats = {"pages": 0, "articles": 0, "ads": 0, "errors": 0}

    if not reindex and issue_already_indexed(client, meta.issue_id):
        click.echo(f"  Skipping {meta.filename} (already indexed)")
        return stats

    click.echo(f"  Processing {meta.filename}...")

    try:
        pages = extract_pages(pdf_path)
    except Exception as e:
        click.echo(f"  ERROR extracting {meta.filename}: {e}", err=True)
        stats["errors"] += 1
        return stats

    stats["pages"] = len(pages)
    articles = segment_articles(pages)

    if not articles:
        click.echo(f"  WARNING: no articles found in {meta.filename}")
        return stats

    embeddings = embed_articles(articles)

    docs = []
    for idx, (article, embedding) in enumerate(zip(articles, embeddings)):
        doc_id = f"{meta.issue_id}_p{article.page_start}_a{idx}"
        docs.append({
            "_id": doc_id,
            "issue_id": meta.issue_id,
            "issue_filename": meta.filename,
            "issue_year": meta.year,
            "issue_date": meta.date,
            "issue_number": meta.number,
            "type": article.type,
            "title": article.title,
            "text": article.text,
            "page_start": article.page_start,
            "page_end": article.page_end,
            "embedding": embedding,
        })
        if article.type == "advertisement":
            stats["ads"] += 1
        else:
            stats["articles"] += 1

    ok, errors = bulk_upsert(client, docs)
    stats["errors"] += errors
    click.echo(
        f"  → {stats['pages']} pages, {stats['articles']} articles, "
        f"{stats['ads']} ads, {errors} errors"
    )
    return stats


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option("--pdf-dir", required=True, type=click.Path(exists=True, file_okay=False), help="Directory containing PDF files")
@click.option("--reindex", is_flag=True, default=False, help="Re-index issues that are already in OpenSearch")
def main(pdf_dir: str, reindex: bool) -> None:
    """Ingest magazine PDFs into OpenSearch."""
    pdf_paths = sorted(Path(pdf_dir).glob("**/*.pdf"))
    if not pdf_paths:
        click.echo(f"No PDF files found in {pdf_dir}", err=True)
        sys.exit(1)

    click.echo(f"Found {len(pdf_paths)} PDF(s) in {pdf_dir}")

    client = make_client()
    try:
        client.cluster.health()
    except Exception as e:
        click.echo(f"Cannot connect to OpenSearch: {e}", err=True)
        sys.exit(1)

    setup_index(client)

    total = {"pages": 0, "articles": 0, "ads": 0, "errors": 0}
    for pdf_path in pdf_paths:
        meta = parse_filename(pdf_path)
        stats = process_pdf(pdf_path, meta, client, reindex)
        for k in total:
            total[k] += stats[k]

    click.echo(
        f"\nDone. Total: {total['pages']} pages, {total['articles']} articles, "
        f"{total['ads']} ads, {total['errors']} errors"
    )


if __name__ == "__main__":
    main()
