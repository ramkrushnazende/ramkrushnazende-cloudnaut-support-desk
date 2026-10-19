from datetime import datetime

from pydantic import BaseModel, ConfigDict


class MfaPolicyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    require_staff_mfa: bool


class MfaPolicyResponse(BaseModel):
    require_staff_mfa: bool
    updated_at: datetime | None = None
    updated_by: int | None = None
