"""Small cached Secrets Manager reader used by Lambda cold starts."""

import json
import os
from functools import lru_cache

import boto3


@lru_cache(maxsize=8)
def get_secret(secret_arn: str) -> dict[str, str]:
    response = boto3.client(
        "secretsmanager",
        region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
    ).get_secret_value(SecretId=secret_arn)
    value = response.get("SecretString")
    if not value:
        raise RuntimeError("Configured secret has no SecretString value.")
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise RuntimeError("Configured secret must contain a JSON object.")
    return {str(key): str(item) for key, item in parsed.items() if item is not None}


def configured_secret_value(secret_arn_env: str, key: str, default: str = "") -> str:
    arn = os.getenv(secret_arn_env, "").strip()
    if not arn:
        return default
    return get_secret(arn).get(key, default)