"""HTTP utilities — retry wrapper for external API calls."""

import logging
import time
import httpx

log = logging.getLogger("vault.http_utils")


def http_get_with_retry(url: str, *, params: dict | None = None,
                        timeout: float = 10, max_retries: int = 3,
                        backoff_base: float = 1.0) -> httpx.Response:
    """HTTP GET with exponential backoff retry on transient failures.

    Retries on: TimeoutException, ConnectError, HTTP 429, HTTP 5xx.
    Does NOT retry on: HTTP 4xx (except 429).
    Raises original exception after all retries exhausted.
    """
    last_exc = None
    for attempt in range(max_retries + 1):
        try:
            resp = httpx.get(url, params=params, timeout=timeout)
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt < max_retries:
                    delay = backoff_base * (2 ** attempt)
                    log.warning(
                        f"HTTP {resp.status_code} from {url} — retry {attempt + 1}/{max_retries} in {delay:.1f}s"
                    )
                    time.sleep(delay)
                    continue
                resp.raise_for_status()
            resp.raise_for_status()
            return resp
        except (httpx.TimeoutException, httpx.ConnectError) as e:
            last_exc = e
            if attempt < max_retries:
                delay = backoff_base * (2 ** attempt)
                log.warning(
                    f"{type(e).__name__} on {url} — retry {attempt + 1}/{max_retries} in {delay:.1f}s"
                )
                time.sleep(delay)
            else:
                raise
    raise last_exc  # should not reach here, but safety net
