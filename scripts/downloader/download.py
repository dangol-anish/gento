import asyncio
import os
import re

import httpx

from scripts.downloader.scrape import BASE_HEADERS, get_image_urls


def sanitize_filename(name: str) -> str:
    return re.sub(r'[\\/*?:"<>|]', "_", name)


async def download_image(
    client: httpx.AsyncClient,
    url: str,
    path: str,
    chapter_url: str,
    retries: int,
) -> bool:
    for attempt in range(retries):
        try:
            headers = BASE_HEADERS.copy()
            headers["Referer"] = chapter_url

            response = await client.get(url, headers=headers)
            response.raise_for_status()
            if not response.content:
                raise ValueError("Empty image payload")

            with open(path, "wb") as f:
                f.write(response.content)
            return True
        except Exception:
            if attempt < retries - 1:
                await asyncio.sleep(2**attempt)
            else:
                return False


async def download_chapter(
    chapter_url: str,
    manga_title: str,
    chapter_name: str,
    output_root: str,
    timeout: float,
    max_image_threads: int,
    retry_attempts: int,
) -> str:
    manga_dir = os.path.join(output_root, sanitize_filename(manga_title))
    chapter_dir = os.path.join(manga_dir, sanitize_filename(chapter_name))
    os.makedirs(chapter_dir, exist_ok=True)

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        image_urls = await get_image_urls(chapter_url, timeout=timeout, client=client)
        if not image_urls:
            return chapter_dir

        semaphore = asyncio.Semaphore(max_image_threads)

        async def download_single(index: int, img_url: str):
            ext = os.path.splitext(img_url.split("?")[0])[1] or ".jpg"
            img_path = os.path.join(chapter_dir, f"page_{index + 1}{ext}")
            async with semaphore:
                await download_image(client, img_url, img_path, chapter_url, retry_attempts)

        await asyncio.gather(*(download_single(i, url) for i, url in enumerate(image_urls)))
    return chapter_dir
