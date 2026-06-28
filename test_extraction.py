"""
Extraction tests. Configure expected results in EXPECTED below, then run:
    uv run --group dev pytest test_extraction.py -v
"""

from __future__ import annotations

import functools
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from ingest import extract_pages, parse_filename, segment_articles

PDF_DIR = Path(__file__).parent / "pdfs"


# ---------------------------------------------------------------------------
# DSL
# ---------------------------------------------------------------------------

@dataclass
class Seg:
    """One expected article.

    title  — substring expected in article.title  (case-insensitive)
    body   — substring expected in article.text   (case-insensitive)

    Set either or both; both conditions must be satisfied by the same article.
    """
    title: str = ""
    body:  str = ""

    def __post_init__(self) -> None:
        if not self.title and not self.body:
            raise ValueError("Seg requires at least one of title or body")


@dataclass
class Issue:
    year: int
    number: int
    date: str           # ISO yyyy-MM-dd
    pages: int
    segments: list[Seg] = field(default_factory=list)


EXPECTED: dict[str, Issue] = {
    "1992_04.pdf": Issue(
        year=1992, number=4, date="1992-04-01", pages=12,
        segments=[
            Seg(title="Budget und Voranschlag – Trockene Materie?"),
            Seg(title="Wald aus der Feder"),
            Seg(title="Vom Bürohaus zum Museum"),
            Seg(title="Geld Sparen – Auch in Wald..."),
            Seg(title="... und trotzdem handeln"),
            Seg(title="Wald im Volleyball-Fieber?"),
            Seg(title="Volewa: Trotz Raumproblemen am Ball"),
            Seg(title="Arbeitslosigkeit verfünffacht"),
        ],
    ),
    "1993_06.pdf": Issue(
        year=1993, number=6, date="1993-06-01", pages=8,
        segments=[
            Seg(title="Zug-Zwang"),
            Seg(title="Neue Röntgenanlage: Spital noch moderner"),
            Seg(title="Kund zum besitzen"),
            Seg(title="Clown André in den Fussstapfen von Grock"),
            Seg(title="Das Bauen muss einfacher werden..."),
            Seg(title="... auch in der Gemeinde Wald"),
            Seg(title="Holzwerkstatt Wald – die Besondere"),
            Seg(title="Jan Tischhauser – Ski-Zirkus-Direktor"),
        ],
    ),
    "2006_09.pdf": Issue(
        year=2006, number=9, date="2006-09-01", pages=12,
        segments=[
            Seg(title="Lobby für die Bahn"),
            Seg(title="Rebberge mit Aussicht"),
            Seg(title="Umsteigen bitte!"),
            Seg(title="Eine Erfolgsgeschichte"),
            Seg(title="Verein mit Verantwortung"),
            Seg(title="Schnaps brennen – uralt und modern"),
            Seg(title="Vom Kosthaus zur Fabrikloft"),
            Seg(title="Meldungen aus dem Gemeindehaus"),
            Seg(title="Räbeliechtli, Räbeliechtli, wo gasch hi?"),
            Seg(title="Der Schwertplatz im Weihnachtsglanz"),
            Seg(title="Leserbriefe"),
            Seg(title="Weihnachtspäckli – Weihnachtsfreude"),
        ],
    ),
    "2026_05.pdf": Issue(
        year=2026, number=5, date="2026-05-01", pages=16,
        segments=[
            Seg(title="Am Rand"),
            Seg(title="Psychiatrische Langzeitpflege"),
            Seg(title="Das Dorf zwischen den Ständen"),
            Seg(title="Vernetzte Unternehmer"),
            Seg(title="Kosovarische Pita und Burek"),
            Seg(title="Wege zur Lehrstelle"),
            Seg(title="Auf der Alp Scheidegg zu Hause"),
            Seg(title="Zwischen Hoffnung und Konkurs"),
            Seg(title="Dies und Das"),
            Seg(title="Grüezi Fiorentina Talamo"),
        ],
    ),
}


# ---------------------------------------------------------------------------
# Extraction cache (each PDF is extracted once across all tests)
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=None)
def _extract(pdf_name: str):
    pages = extract_pages(PDF_DIR / pdf_name)
    return pages, segment_articles(pages)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("pdf_name", list(EXPECTED.keys()))
def test_parse_filename(pdf_name: str) -> None:
    exp = EXPECTED[pdf_name]
    meta = parse_filename(PDF_DIR / pdf_name)
    assert meta.year == exp.year
    assert meta.number == exp.number
    assert meta.date == exp.date
    assert meta.filename == pdf_name


@pytest.mark.parametrize("pdf_name", list(EXPECTED.keys()))
def test_page_count(pdf_name: str) -> None:
    pages, _ = _extract(pdf_name)
    assert len(pages) == EXPECTED[pdf_name].pages


@pytest.mark.parametrize("pdf_name,seg", [
    pytest.param(pdf_name, seg, id=f"{pdf_name}::{(seg.title or seg.body)[:30]}")
    for pdf_name, issue in EXPECTED.items()
    for seg in issue.segments
])
def test_segment_present(pdf_name: str, seg: Seg) -> None:
    _, articles = _extract(pdf_name)

    def matches(a) -> bool:
        if seg.title and seg.title.lower() not in a.title.lower():
            return False
        if seg.body and seg.body.lower() not in a.text.lower():
            return False
        return True

    match = next((a for a in articles if matches(a)), None)
    assert match is not None, (
        f"No article matching title={seg.title!r} body={seg.body!r} found in {pdf_name}.\n"
        f"Titles found: {[a.title[:60] for a in articles]}"
    )
