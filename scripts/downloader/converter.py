import os
import zipfile

from PIL import Image

from scripts.downloader.metadata import create_comic_info_xml


def convert_images_to_pdf(image_paths: list[str], output_path: str) -> bool:
    if not image_paths:
        return False

    images = []
    for img_path in image_paths:
        try:
            img = Image.open(img_path).convert("RGB")
            images.append(img)
        except Exception:
            return False

    try:
        if images:
            images[0].save(output_path, save_all=True, append_images=images[1:])
            return True
        return False
    except Exception:
        return False


def convert_images_to_cbz(
    image_paths: list[str], output_path: str, metadata: dict | None = None
) -> bool:
    if not image_paths:
        return False

    try:
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as cbz_file:
            for img_path in image_paths:
                cbz_file.write(img_path, os.path.basename(img_path))

            if metadata:
                xml_content = create_comic_info_xml(metadata)
                cbz_file.writestr("ComicInfo.xml", xml_content)
        return True
    except Exception:
        return False
