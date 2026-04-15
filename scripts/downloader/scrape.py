from __future__ import annotations

import re
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup


BASE_URL = "https://mangabuddy.com"
BASE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
}


def _build_headers(referer: str | None = None, extra_headers: dict | None = None) -> dict:
    headers = BASE_HEADERS.copy()
    headers["Referer"] = referer or BASE_URL
    if extra_headers:
        headers.update(extra_headers)
    return headers


async def _fetch_text(
    client: httpx.AsyncClient,
    url: str,
    referer: str | None = None,
    extra_headers: dict | None = None,
) -> str:
    response = await client.get(url, headers=_build_headers(referer, extra_headers))
    response.raise_for_status()
    return response.text


def _extract_manga_slug(url: str) -> str:
    parsed = urlparse(url.strip())
    path = parsed.path.strip("/")
    if not path:
        return ""
    return path.split("/")[0]


def _extract_metadata(soup: BeautifulSoup, page_url: str) -> dict:
    name_box = soup.find("div", class_="name box")
    manga_title = name_box.find("h1").get_text(strip=True) if name_box else "Unknown Title"

    metadata = {
        "Title": manga_title,
        "Web": page_url,
        "Series": manga_title,
        "Manga": "Yes",
    }

    detail_box = soup.find("div", class_="detail-box")
    if detail_box:
        summary_div = detail_box.find("div", class_="summary")
        if summary_div:
            metadata["Summary"] = summary_div.get_text(" ", strip=True)

        for p_tag in detail_box.find_all("p"):
            strong_tag = p_tag.find("strong")
            if not strong_tag:
                continue

            key = strong_tag.get_text(strip=True).replace(":", "")
            full_text = p_tag.get_text(" ", strip=True)
            key_text = strong_tag.get_text(" ", strip=True)
            value = full_text.replace(key_text, "", 1).strip(" :")

            if key == "Author(s)":
                metadata["Writer"] = value
            elif key == "Genre(s)":
                metadata["Genre"] = value

    return metadata


def _extract_book_id(html: str) -> str | None:
    match = re.search(r"var\s+bookId\s*=\s*(\d+);", html)
    return match.group(1) if match else None


def _chapter_number_from_title(title: str) -> float:
    match = re.search(r"Chapter\s+([\d.]+)", title, re.IGNORECASE)
    if not match:
        return float("inf")
    try:
        return float(match.group(1))
    except ValueError:
        return float("inf")


async def _fetch_chapters(client: httpx.AsyncClient, book_id: str) -> list[dict]:
    api_url = f"{BASE_URL}/api/manga/{book_id}/chapters?source=detail"
    html = await _fetch_text(
        client,
        api_url,
        referer=BASE_URL,
        extra_headers={"X-Requested-With": "XMLHttpRequest"},
    )

    soup = BeautifulSoup(html, "html.parser")
    chapter_rows = []

    for idx, li in enumerate(soup.find_all("li")):
        a_tag = li.find("a")
        strong = li.find("strong", class_="chapter-title")
        if not a_tag or not strong:
            continue

        href = a_tag.get("href", "").strip()
        if not href:
            continue

        if href.startswith("http"):
            chapter_url = href
        else:
            chapter_url = f"{BASE_URL}{href if href.startswith('/') else '/' + href}"

        title = strong.get_text(strip=True)
        chapter_rows.append(
            {
                "name": title,
                "url": chapter_url,
                "_number": _chapter_number_from_title(title),
                "_idx": idx,
            }
        )

    chapter_rows.sort(key=lambda item: (item["_number"], item["_idx"]))
    return [{"name": row["name"], "url": row["url"]} for row in chapter_rows]


async def get_manga_details(url: str, timeout: float = 20) -> tuple[dict | None, list[dict] | None]:
    manga_slug = _extract_manga_slug(url)
    if not manga_slug:
        return None, None

    series_url = f"{BASE_URL}/{manga_slug}"

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        try:
            detail_html = await _fetch_text(client, series_url, referer=BASE_URL)
        except httpx.HTTPStatusError as exc:
            # Fallback: some paths may be blocked while original URL still resolves.
            if exc.response is not None and exc.response.status_code == 403:
                detail_html = await _fetch_text(client, url.strip(), referer=BASE_URL)
            else:
                raise

        soup = BeautifulSoup(detail_html, "html.parser")
        metadata = _extract_metadata(soup, series_url)

        book_id = _extract_book_id(detail_html)
        if not book_id:
            return metadata, []

        chapters = await _fetch_chapters(client, book_id)
        return metadata, chapters


async def get_image_urls(
    chapter_url: str, timeout: float = 20, client: httpx.AsyncClient | None = None
) -> list[str]:
    own_client = client is None
    active_client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)

    try:
        html = await _fetch_text(active_client, chapter_url, referer=BASE_URL)
        match = re.search(r"var\s+chapImages\s*=\s*['\"]([^'\"]+)['\"]", html)
        if not match:
            return []

        return [
            re.sub(r"\?.*$", "", img.strip())
            for img in match.group(1).split(",")
            if img.strip()
        ]
    except Exception:
        return []
    finally:
        if own_client:
            await active_client.aclose()
