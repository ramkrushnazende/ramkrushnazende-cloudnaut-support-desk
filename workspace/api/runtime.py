"""Runtime bridge for local HTTP and single-Lambda deployments."""

from typing import Any

import httpx


_backend_app: Any | None = None


def configure_backend(app: Any) -> None:
    global _backend_app
    _backend_app = app


async def request_backend(
    method: str,
    path: str,
    *,
    params: dict | None = None,
    json: dict | None = None,
    headers: dict[str, str] | None = None,
    files: dict | None = None,
    timeout: float = 10,
) -> httpx.Response:
    request_kwargs = {
        "headers": headers,
    }
    if params is not None:
        request_kwargs["params"] = params
    if json is not None:
        request_kwargs["json"] = json
    if files is not None:
        request_kwargs["files"] = files

    if _backend_app is None:
        async with httpx.AsyncClient(timeout=timeout) as client:
            return await client.request(method, path, **request_kwargs)

    transport = httpx.ASGITransport(app=_backend_app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://lambda-backend",
        timeout=timeout,
    ) as client:
        return await client.request(method, path, **request_kwargs)