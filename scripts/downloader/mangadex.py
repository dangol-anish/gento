from __future__ import annotations

import re
from urllib.parse import urlparse

import httpx


API_BASE = "https://api.mangadex.org"
WEB_BASE = "https://mangadex.org"

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}


def _pick_localized(value: dict | None) -> str:
    if not isinstance(value, dict) or not value:
        return ""
    for key in ("en", "en-us", "en-gb"):
        if isinstance(value.get(key), str) and value[key].strip():
            return value[key].strip()
    for inner in value.values():
        if isinstance(inner, str) and inner.strip():
            return inner.strip()
    return ""


def _extract_manga_id(url: str) -> str:
    parsed = urlparse(url.strip())
    parts = [p for p in parsed.path.split("/") if p]
    # Typical: /title/<uuid>/<slug>
    if len(parts) >= 2 and parts[0] == "title":
        return parts[1]
    # Sometimes users paste raw uuid or other variants.
    if len(parts) >= 1 and re.fullmatch(r"[0-9a-fA-F-]{36}", parts[0]):
        return parts[0]
    return ""


def _extract_chapter_id(url: str) -> str:
    parsed = urlparse(url.strip())
    parts = [p for p in parsed.path.split("/") if p]
    # Typical: /chapter/<uuid>
    if len(parts) >= 2 and parts[0] == "chapter":
        return parts[1]
    if len(parts) >= 1 and re.fullmatch(r"[0-9a-fA-F-]{36}", parts[0]):
        return parts[0]
    return ""


def _chapter_sort_key(item: dict) -> tuple:
    chap = item.get("chapter")
    try:
        chap_num = float(chap) if chap is not None and chap != "" else float("inf")
    except ValueError:
        chap_num = float("inf")
    volume = item.get("volume")
    try:
        vol_num = float(volume) if volume is not None and volume != "" else float("inf")
    except ValueError:
        vol_num = float("inf")
    created = item.get("createdAt") or ""
    return (vol_num, chap_num, created)


async def get_manga_details(
    url: str,
    timeout: float = 20,
    translated_languages: list[str] | None = None,
) -> tuple[dict | None, list[dict] | None]:
    manga_id = _extract_manga_id(url)
    if not manga_id:
        return None, None

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        manga_res = await client.get(
            f"{API_BASE}/manga/{manga_id}",
            params={"includes[]": ["author", "artist"]},
            headers=DEFAULT_HEADERS,
        )
        manga_res.raise_for_status()
        manga_json = manga_res.json()
        data = (manga_json or {}).get("data") or {}
        attrs = data.get("attributes") or {}

        title = _pick_localized(attrs.get("title")) or "Unknown Title"
        description = _pick_localized(attrs.get("description"))
        tags = attrs.get("tags") or []
        genres: list[str] = []
        for tag in tags:
            name = _pick_localized((tag or {}).get("attributes", {}).get("name"))
            if name:
                genres.append(name)

        metadata: dict = {
            "Title": title,
            "Web": f"{WEB_BASE}/title/{manga_id}",
            "Series": title,
            "Manga": "Yes",
        }
        if description:
            metadata["Summary"] = description
        if genres:
            metadata["Genre"] = ", ".join(sorted(set(genres)))

        # Fetch chapters (paginated).
        params: dict = {
            "limit": 500,
            "offset": 0,
            "order[volume]": "asc",
            "order[chapter]": "asc",
            "order[createdAt]": "asc",
        }
        if translated_languages:
            params["translatedLanguage[]"] = translated_languages

        chapters: list[dict] = []
        offset = 0
        while True:
            params["offset"] = offset
            feed_res = await client.get(
                f"{API_BASE}/manga/{manga_id}/feed",
                params=params,
                headers=DEFAULT_HEADERS,
            )
            feed_res.raise_for_status()
            feed_json = feed_res.json() or {}
            items = feed_json.get("data") or []
            total = int(feed_json.get("total") or 0)
            for item in items:
                item_attrs = (item or {}).get("attributes") or {}
                chap_id = (item or {}).get("id") or ""
                chapter_no = item_attrs.get("chapter")
                chapter_title = item_attrs.get("title") or ""
                display = "Chapter"
                if chapter_no:
                    display = f"Chapter {chapter_no}"
                if chapter_title:
                    display = f"{display}: {chapter_title}"
                chapters.append(
                    {
                        "name": display,
                        "url": f"{WEB_BASE}/chapter/{chap_id}",
                        "volume": item_attrs.get("volume"),
                        "chapter": chapter_no,
                        "createdAt": item_attrs.get("createdAt"),
                    }
                )
            offset += len(items)
            if offset >= total or not items:
                break

        chapters.sort(key=_chapter_sort_key)
        return metadata, [{"name": c["name"], "url": c["url"]} for c in chapters]


async def get_image_urls(
    chapter_url: str,
    timeout: float = 20,
    client: httpx.AsyncClient | None = None,
    use_data_saver: bool = False,
) -> list[str]:
    chapter_id = _extract_chapter_id(chapter_url)
    if not chapter_id:
        return []

    own_client = client is None
    active_client = client or httpx.AsyncClient(timeout=timeout, follow_redirects=True)
    try:
        res = await active_client.get(
            f"{API_BASE}/at-home/server/{chapter_id}",
            headers=DEFAULT_HEADERS,
        )
        res.raise_for_status()
        payload = res.json() or {}
        base_url = payload.get("baseUrl") or ""
        chapter = payload.get("chapter") or {}
        chapter_hash = chapter.get("hash") or ""
        pages = chapter.get("dataSaver" if use_data_saver else "data") or []
        if not base_url or not chapter_hash or not isinstance(pages, list) or not pages:
            return []
        folder = "data-saver" if use_data_saver else "data"
        return [f"{base_url}/{folder}/{chapter_hash}/{name}" for name in pages if isinstance(name, str)]
    except Exception:
        return []
    finally:
        if own_client:
            await active_client.aclose()

