import os

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


class StorageConfigurationError(RuntimeError):
    pass


class ObjectStorageError(RuntimeError):
    pass


class ObjectNotFoundError(ObjectStorageError):
    pass


# S3 error codes that mean "the object key does not exist".
_NOT_FOUND_CODES = {"NoSuchKey", "NoSuchObject", "404", "NotFound"}


class ObjectStorage:
    """Amazon S3-backed object storage for ticket attachments.

    Credentials come from the standard AWS provider chain (EC2 instance role in
    production); no access keys are read from the application. The bucket is
    created out-of-band (CDK), so this class never creates it. The public
    interface (ensure_bucket / upload / download / delete) and the exception
    hierarchy are unchanged so AttachmentService needs no modification.
    """

    def __init__(self):
        self.bucket = os.getenv("S3_BUCKET")
        if not self.bucket:
            raise StorageConfigurationError("S3_BUCKET must be configured.")
        self._region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
        # The boto3 client is created lazily on first use so that constructing
        # ObjectStorage never resolves credentials. In production the EC2
        # instance role supplies credentials via the AWS provider chain at the
        # moment of the first S3 call.
        self._client = None

    @property
    def client(self):
        if self._client is None:
            try:
                self._client = boto3.client(
                    "s3",
                    region_name=self._region,
                    config=Config(
                        retries={"max_attempts": 3, "mode": "standard"},
                        connect_timeout=5,
                        read_timeout=30,
                        signature_version="s3v4",
                    ),
                )
            except (BotoCoreError, ValueError) as error:
                raise StorageConfigurationError(
                    "Could not initialize the S3 client."
                ) from error
        return self._client

    @client.setter
    def client(self, value):
        # Allows tests to inject a fake S3 client (as the previous MinIO code did).
        self._client = value

    def ensure_bucket(self):
        """No-op by contract: the bucket is provisioned by infrastructure (CDK).

        Kept so callers (AttachmentService.upload) don't change. We do NOT
        create the bucket at runtime and intentionally avoid a HeadBucket call
        so no extra IAM permission (s3:ListBucket) is required for uploads.
        """
        return None

    def upload(self, object_key: str, content: bytes, content_type: str):
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=object_key,
                Body=content,
                ContentType=content_type,
            )
        except (ClientError, BotoCoreError) as error:
            raise ObjectStorageError("Could not upload the object to S3.") from error

    def download(self, object_key: str) -> bytes:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=object_key)
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            if code in _NOT_FOUND_CODES:
                raise ObjectNotFoundError("The S3 object does not exist.") from error
            raise ObjectStorageError("Could not retrieve the object from S3.") from error
        except BotoCoreError as error:
            raise ObjectStorageError("Could not retrieve the object from S3.") from error

        body = response["Body"]
        try:
            return body.read()
        except (BotoCoreError, OSError) as error:
            raise ObjectStorageError("Could not read the object from S3.") from error
        finally:
            body.close()

    def delete(self, object_key: str):
        try:
            self.client.delete_object(Bucket=self.bucket, Key=object_key)
        except (ClientError, BotoCoreError) as error:
            raise ObjectStorageError("Could not delete the object from S3.") from error
