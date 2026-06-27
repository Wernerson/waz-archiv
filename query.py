"""
Quick hybrid search against the articles index.

Usage:
    uv run query.py "your search terms"
    uv run query.py "your search terms" --size 10
    uv run query.py "your search terms" --type article
"""

import json
import os
import sys

import click
from opensearchpy import OpenSearch
from sentence_transformers import SentenceTransformer

INDEX_NAME = "articles"
EMBED_MODEL = "all-MiniLM-L6-v2"


@click.command()
@click.argument("query_text")
@click.option("--size", default=5, show_default=True, help="Number of results")
@click.option("--type", "doc_type", default=None, help="Filter by type: article or advertisement")
@click.option("--bm25-only", is_flag=True, help="Disable vector search (BM25 only)")
def main(query_text: str, size: int, doc_type: str | None, bm25_only: bool) -> None:
    client = OpenSearch(
        os.environ.get("OPENSEARCH_URL", "http://localhost:9200"),
        use_ssl=False,
        verify_certs=False,
        ssl_show_warn=False,
    )

    if bm25_only:
        query = {"match": {"text": {"query": query_text}}}
        params = {}
    else:
        model = SentenceTransformer(EMBED_MODEL)
        vector = model.encode(query_text, normalize_embeddings=True).tolist()
        query = {
            "hybrid": {
                "queries": [
                    {"match": {"text": {"query": query_text}}},
                    {"knn": {"embedding": {"vector": vector, "k": size * 2}}},
                ]
            }
        }
        params = {"search_pipeline": "hybrid-pipeline"}

    body: dict = {
        "query": query,
        "_source": ["title", "type", "issue_filename", "issue_date", "page_start", "page_end"],
        "highlight": {"fields": {"text": {"fragment_size": 200, "number_of_fragments": 1}}},
        "size": size,
    }

    if doc_type:
        body["post_filter"] = {"term": {"type": doc_type}}

    resp = client.search(index=INDEX_NAME, body=body, params=params)

    hits = resp["hits"]["hits"]
    total = resp["hits"]["total"]["value"]
    click.echo(f"\n{total} total hits — showing top {len(hits)}\n")

    for i, hit in enumerate(hits, 1):
        src = hit["_source"]
        highlight = hit.get("highlight", {}).get("text", [""])[0]
        click.echo(f"""
{i}. [{src.get('type','?')}] {src.get('title','(no title)')}
   {src.get('issue_filename','')} · {src.get('issue_date','')} · pp. {src.get('page_start')}-{src.get('page_end')}
   score: {hit['_score']:.4f}
   {highlight if highlight else "no highlight"}
""")


if __name__ == "__main__":
    main()

