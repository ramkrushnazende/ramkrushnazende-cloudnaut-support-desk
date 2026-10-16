from pydantic import BaseModel, ConfigDict, EmailStr, Field


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class TeamMemberUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=100)
    email: EmailStr | None = None
    password: str | None = Field(default=None, min_length=12, max_length=200)
    role: str | None = Field(default=None, pattern="^(admin|support|employee)$")
    is_active: bool | None = None


class TeamMemberResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    name: str
    email: EmailStr
    is_active: bool
    role: str = "support"
