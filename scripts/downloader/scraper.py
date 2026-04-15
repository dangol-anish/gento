import argparse
import sys

from scripts.common.errors import invalid_request
from scripts.common.events import emit, run_with_error_boundary


def run(url: str, out_dir: str) -> None:
    """
    Stage 0 scaffold. Real scraping logic will be implemented next.
    """
    if not url.strip():
        raise invalid_request("url must be a non-empty string.")
    if not out_dir.strip():
        raise invalid_request("out directory must be a non-empty string.")

    emit("progress", stage=0, percent=10, message=f"Received URL: {url}")
    emit("complete", stage=0, output_dir=out_dir)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--out", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    exit_code = run_with_error_boundary(0, lambda: run(args.url, args.out))
    sys.exit(exit_code)
