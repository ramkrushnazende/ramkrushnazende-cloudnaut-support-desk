import os

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response

from auth import require_roles
from runtime import request_backend
from schemas.attachments import AttachmentResponse


router = APIRouter(tags=["Attachments"])
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8001")
BACKEND_TIMEOUT = float(os.getenv("BACKEND_TIMEOUT", "30"))
MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024
ATTACHMENT_ROLES = ("employee", "support", "admin")


def raise_backend_error(response: httpx.Response):
    try:
        data = response.json()
    except ValueError:
        data = None

    detail = (
        data.get("detail", "Backend request failed")
        if isinstance(data, dict)
        else "Backend request failed"
    )
    raise HTTPException(status_code=response.status_code, detail=detail)


async def backend_attachment_request(
    method: str,
    path: str,
    *,
    access_token: str,
    files: dict | None = None,
):
    try:
        response = await request_backend(
            method,
            path,
            files=files,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=BACKEND_TIMEOUT,
        )
    except httpx.RequestError as error:
        raise HTTPException(
            status_code=502,
            detail="Backend service is unavailable",
        ) from error

    if response.status_code >= 400:
        raise_backend_error(response)
    return response


@router.post(
    "/requests/{request_id}/attachments",
    response_model=AttachmentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_request_attachment(
    request_id: int,
    file: UploadFile = File(...),
    user=Depends(require_roles(*ATTACHMENT_ROLES)),
):
    content = await file.read(MAX_ATTACHMENT_SIZE + 1)
    try:
        if len(content) > MAX_ATTACHMENT_SIZE:
            raise HTTPException(status_code=413, detail="Files must be 5 MB or smaller.")

        response = await backend_attachment_request(
            "POST",
            f"/internal/requests/{request_id}/attachments",
            access_token=user["token"],
            files={
                "file": (
                    file.filename or "attachment",
                    content,
                    file.content_type or "application/octet-stream",
                )
            },
        )
        return response.json()
    finally:
        await file.close()


@router.get(
    "/requests/{request_id}/attachments",
    response_model=list[AttachmentResponse],
)
async def list_request_attachments(
    request_id: int,
    user=Depends(require_roles(*ATTACHMENT_ROLES)),
):
    response = await backend_attachment_request(
        "GET",
        f"/internal/requests/{request_id}/attachments",
        access_token=user["token"],
    )
    return response.json()


@router.get("/attachments/{attachment_id}")
async def download_request_attachment(
    attachment_id: int,
    user=Depends(require_roles(*ATTACHMENT_ROLES)),
):
    response = await backend_attachment_request(
        "GET",
        f"/internal/attachments/{attachment_id}",
        access_token=user["token"],
    )
    headers = {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
    }
    if "content-disposition" in response.headers:
        headers["Content-Disposition"] = response.headers["content-disposition"]
    return Response(
        content=response.content,
        media_type=response.headers.get("content-type", "application/octet-stream"),
        headers=headers,
    )


@router.delete(
    "/attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_request_attachment(
    attachment_id: int,
    user=Depends(require_roles(*ATTACHMENT_ROLES)),
):
    await backend_attachment_request(
        "DELETE",
        f"/internal/attachments/{attachment_id}",
        access_token=user["token"],
    )
