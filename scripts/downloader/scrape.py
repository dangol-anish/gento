from __future__ import annotations

import asyncio
import re
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from scripts.downloader import mangadex


MANGABUDDY_BASE_URL = "https://mangabuddy.com"
MANGAPILL_BASE_URL = "https://mangapill.com"
WEEBCENTRAL_BASE_URL = "https://weebcentral.com"
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
    headers["Referer"] = referer or MANGABUDDY_BASE_URL
    if extra_headers:
        headers.update(extra_headers)
    return headers


async def _fetch_text(
    client: httpx.AsyncClient,
    url: str,
    referer: str | None = None,
    extra_headers: dict | None = None,
) -> str:
    # Best-effort retries for flaky / Cloudflare-ish endpoints.
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            response = await client.get(url, headers=_build_headers(referer, extra_headers))
            response.raise_for_status()
            return response.text
        except Exception as exc:
            last_exc = exc
            if attempt < 2:
                await asyncio.sleep(2**attempt)
            else:
                raise


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
    api_url = f"{MANGABUDDY_BASE_URL}/api/manga/{book_id}/chapters?source=detail"
    html = await _fetch_text(
        client,
        api_url,
        referer=MANGABUDDY_BASE_URL,
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
            chapter_url = f"{MANGABUDDY_BASE_URL}{href if href.startswith('/') else '/' + href}"

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


def _is_mangadex_url(url: str) -> bool:
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return False
    return parsed.hostname in {"mangadex.org", "www.mangadex.org"} or "mangadex.org" in (parsed.hostname or "")


def _is_mangapill_url(url: str) -> bool:
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return False
    return parsed.hostname in {"mangapill.com", "www.mangapill.com"} or "mangapill.com" in (parsed.hostname or "")


def _is_weebcentral_url(url: str) -> bool:
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return False
    return parsed.hostname in {"weebcentral.com", "www.weebcentral.com"} or "weebcentral.com" in (parsed.hostname or "")


def _absolute_url(base: str, href: str) -> str:
    href = (href or "").strip()
    if not href:
        return ""
    if href.startswith("http://") or href.startswith("https://"):
        return href
    if not href.startswith("/"):
        href = "/" + href
    return base.rstrip("/") + href


def _extract_first_text(soup: BeautifulSoup, selectors: list[tuple[str, dict]]) -> str:
    for tag, attrs in selectors:
        el = soup.find(tag, attrs=attrs)
        if el:
            text = el.get_text(" ", strip=True)
            if text:
                return text
    h1 = soup.find("h1")
    return h1.get_text(" ", strip=True) if h1 else ""


def _chapter_number_guess(title: str) -> float:
    match = re.search(r"(?:chapter|ch\\.?)[\\s#]*([\\d.]+)", title, re.IGNORECASE)
    if not match:
        match = re.search(r"([\\d.]+)", title)
    if not match:
        return float("inf")
    try:
        return float(match.group(1))
    except ValueError:
        return float("inf")


async def _get_mangapill_details(url: str, timeout: float = 20) -> tuple[dict | None, list[dict] | None]:
    parsed = urlparse(url.strip())
    if not parsed.path.strip("/"):
        return None, None

    # Expect paths like /manga/{id}/{slug}
    if parsed.path.startswith("/manga/"):
        series_url = _absolute_url(MANGAPILL_BASE_URL, parsed.path)
    else:
        series_url = url.strip()

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        html = await _fetch_text(client, series_url, referer=MANGAPILL_BASE_URL)
        soup = BeautifulSoup(html, "html.parser")

        title = _extract_first_text(soup, [("h1", {}), ("meta", {"property": "og:title"})]) or "Unknown Title"

        metadata = {
            "Title": title,
            "Web": series_url,
            "Series": title,
            "Manga": "Yes",
        }

        # Best-effort summary extraction
        summary_el = soup.find(attrs={"class": re.compile(r"(summary|description|synopsis)", re.IGNORECASE)})
        if summary_el:
            summary = summary_el.get_text(" ", strip=True)
            if summary:
                metadata["Summary"] = summary

        chapters_raw = []
        for a_tag in soup.find_all("a", href=True):
            href = a_tag.get("href", "").strip()
            parsed_href = urlparse(href) if href else None
            href_path = (parsed_href.path if parsed_href else href) or ""
            if not href_path.startswith("/chapters/"):
                continue
            name = a_tag.get_text(" ", strip=True) or href.rsplit("/", 1)[-1]
            chap_url = href if (parsed_href and parsed_href.scheme in {"http", "https"}) else _absolute_url(MANGAPILL_BASE_URL, href)
            if not chap_url:
                continue
            chapters_raw.append({"name": name, "url": chap_url, "_num": _chapter_number_guess(name)})

        chapters_raw.sort(key=lambda item: item["_num"])
        chapters = [{"name": row["name"], "url": row["url"]} for row in chapters_raw]

        seen = set()
        unique = []
        for chap in chapters:
            if chap["url"] in seen:
                continue
            seen.add(chap["url"])
            unique.append(chap)

        return metadata, unique


def _extract_weebcentral_series_id(url: str) -> str:
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return ""
    parts = [p for p in parsed.path.strip("/").split("/") if p]
    if len(parts) >= 2 and parts[0] == "series":
        return parts[1]
    return ""


def _extract_weebcentral_chapter_id(url: str) -> str:
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return ""
    parts = [p for p in parsed.path.strip("/").split("/") if p]
    if len(parts) >= 2 and parts[0] == "chapters":
        return parts[1]
    return ""


async def _get_weebcentral_details(url: str, timeout: float = 20) -> tuple[dict | None, list[dict] | None]:
    series_id = _extract_weebcentral_series_id(url)
    if not series_id:
        return None, None

    series_url = f"{WEEBCENTRAL_BASE_URL.rstrip('/')}/series/{series_id}"
    chapters_url = f"{series_url}/full-chapter-list"

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        series_html = await _fetch_text(client, series_url, referer=WEEBCENTRAL_BASE_URL)
        series_soup = BeautifulSoup(series_html, "html.parser")

        title = _extract_first_text(series_soup, [("h1", {}), ("meta", {"property": "og:title"})]) or "Unknown Title"

        metadata = {
            "Title": title,
            "Web": series_url,
            "Series": title,
            "Manga": "Yes",
        }

        summary_el = series_soup.find(attrs={"class": re.compile(r"(summary|description|synopsis)", re.IGNORECASE)})
        if summary_el:
            summary = summary_el.get_text(" ", strip=True)
            if summary:
                metadata["Summary"] = summary

        chapter_html = await _fetch_text(client, chapters_url, referer=series_url)
        chapter_soup = BeautifulSoup(chapter_html, "html.parser")

        chapters_raw = []
        for a_tag in chapter_soup.find_all("a", href=True):
            href = a_tag.get("href", "").strip()
            parsed_href = urlparse(href) if href else None
            href_path = (parsed_href.path if parsed_href else href) or ""
            if not href_path.startswith("/chapters/"):
                continue
            raw_name = a_tag.get_text(" ", strip=True) or href.rsplit("/", 1)[-1]
            # WeebCentral anchor text often includes "Last Read ..." metadata.
            name = raw_name.split("Last Read", 1)[0].strip() or raw_name
            # Final fallback: trim to "Chapter <num>" if present.
            match = re.search(r"(Chapter\\s+[\\d.]+)", name, re.IGNORECASE)
            name = match.group(1) if match else name
            chap_url = href if (parsed_href and parsed_href.scheme in {"http", "https"}) else _absolute_url(WEEBCENTRAL_BASE_URL, href)
            if not chap_url:
                continue
            chapters_raw.append({"name": name, "url": chap_url, "_num": _chapter_number_guess(name)})

        chapters_raw.sort(key=lambda item: item["_num"])
        chapters = [{"name": row["name"], "url": row["url"]} for row in chapters_raw]

        seen = set()
        unique = []
        for chap in chapters:
            if chap["url"] in seen:
                continue
            seen.add(chap["url"])
            unique.append(chap)

        return metadata, unique


async def _get_mangabuddy_details(url: str, timeout: float = 20) -> tuple[dict | None, list[dict] | None]:
    manga_slug = _extract_manga_slug(url)
    if not manga_slug:
        return None, None

    series_url = f"{MANGABUDDY_BASE_URL}/{manga_slug}"

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        try:
            detail_html = await _fetch_text(client, series_url, referer=MANGABUDDY_BASE_URL)
        except httpx.HTTPStatusError as exc:
            # Fallback: some paths may be blocked while original URL still resolves.
            if exc.response is not None and exc.response.status_code == 403:
                detail_html = await _fetch_text(client, url.strip(), referer=MANGABUDDY_BASE_URL)
            else:
                raise

        soup = BeautifulSoup(detail_html, "html.parser")
        metadata = _extract_metadata(soup, series_url)

        book_id = _extract_book_id(detail_html)
        if not book_id:
            return metadata, []

        chapters = await _fetch_chapters(client, book_id)
        return metadata, chapters


async def get_manga_details(url: str, timeout: float = 20) -> tuple[dict | None, list[dict] | None]:
    if _is_mangadex_url(url):
        return await mangadex.get_manga_details(url, timeout=timeout, translated_languages=["en"])
    if _is_mangapill_url(url):
        return await _get_mangapill_details(url, timeout=timeout)
    if _is_weebcentral_url(url):
        return await _get_weebcentral_details(url, timeout=timeout)
    return await _get_mangabuddy_details(url, timeout=timeout)


async def get_image_urls(
    chapter_url: str, timeout: float = 20, client: httpx.AsyncClient | None = None
) -> list[str]:
    if _is_mangadex_url(chapter_url):
        return await mangadex.get_image_urls(chapter_url, timeout=timeout, client=client)
    if _is_mangapill_url(chapter_url):
        own_client = client is None
        active_client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)
        try:
            html = await _fetch_text(active_client, chapter_url, referer=MANGAPILL_BASE_URL)
            soup = BeautifulSoup(html, "html.parser")
            urls = []
            for img in soup.select(".js-page"):
                src = img.get("data-src") or img.get("src")
                if not src:
                    continue
                src = re.sub(r"\?.*$", "", src.strip())
                if src:
                    urls.append(src)
            return urls
        except Exception:
            return []
        finally:
            if own_client:
                await active_client.aclose()

    if _is_weebcentral_url(chapter_url):
        own_client = client is None
        active_client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)
        try:
            chapter_id = _extract_weebcentral_chapter_id(chapter_url)
            images_url = chapter_url.strip()
            if chapter_id:
                images_url = (
                    f"{WEEBCENTRAL_BASE_URL.rstrip('/')}/chapters/{chapter_id}"
                    "/images?is_prev=False&current_page=1&reading_style=long_strip"
                )

            html = await _fetch_text(active_client, images_url, referer=WEEBCENTRAL_BASE_URL)
            soup = BeautifulSoup(html, "html.parser")
            urls = []
            for img in soup.find_all("img"):
                src = img.get("src") or img.get("data-src")
                if not src:
                    continue
                src = re.sub(r"\?.*$", "", src.strip())
                if src:
                    urls.append(src)
            return urls
        except Exception:
            return []
        finally:
            if own_client:
                await active_client.aclose()

    own_client = client is None
    active_client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)

    try:
        html = await _fetch_text(active_client, chapter_url, referer=MANGABUDDY_BASE_URL)
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
