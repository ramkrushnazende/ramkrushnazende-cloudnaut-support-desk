from datetime import datetime

from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class AccessRequestCreate(BaseModel):
	model_config = ConfigDict(extra="forbid")

	role: Literal["employee", "support"]
	message: str | None = Field(default=None, max_length=1000)


class AccessRequestReview(BaseModel):
	status: str = Field(pattern="^(approved|rejected)$")
	review_note: str | None = Field(default=None, max_length=1000)


class AccessRequestResponse(BaseModel):
	model_config = ConfigDict(extra="ignore")

	id: int
	name: str
	email: EmailStr
	role: str
	message: str | None
	status: str
	created_at: datetime
	reviewed_at: datetime | None
	reviewed_by: int | None
	review_note: str | None
	provisioning_status: str | None = None
	email_verified: bool = False
