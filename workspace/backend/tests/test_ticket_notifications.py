from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from app.services import ticket_notifications


def test_ticket_confirmation_uses_ses_and_includes_ticket_details(monkeypatch):
    client = Mock()
    monkeypatch.setattr(ticket_notifications.boto3, "client", lambda *args, **kwargs: client)
    monkeypatch.setenv("AWS_REGION", "ap-south-1")
    monkeypatch.setenv("SES_FROM_EMAIL", "support@example.com")

    ticket_notifications.send_ticket_confirmation_email(
        {
            "id": 42,
            "requester_name": "Ada",
            "requester_email": "ada@example.com",
            "title": "Printer offline",
            "category": "Infrastructure",
            "created_at": "2026-10-17T18:00:00+00:00",
        }
    )

    client.send_email.assert_called_once()
    call = client.send_email.call_args.kwargs
    assert call["Source"] == "support@example.com"
    assert call["Destination"] == {"ToAddresses": ["ada@example.com"]}
    assert call["Message"]["Subject"]["Data"] == (
        "Your Cloudnaut support request is confirmed · Ticket #42"
    )
    assert "Ticket ID: 42" in call["Message"]["Body"]["Text"]["Data"]
    assert "Subject: Printer offline" in call["Message"]["Body"]["Text"]["Data"]
    assert "Category: Infrastructure" in call["Message"]["Body"]["Text"]["Data"]
    assert "<!doctype html>" in call["Message"]["Body"]["Html"]["Data"]
    assert "Support request confirmed" in call["Message"]["Body"]["Html"]["Data"]
    assert "Received" in call["Message"]["Body"]["Html"]["Data"]
    assert "Printer offline" in call["Message"]["Body"]["Html"]["Data"]


def test_ticket_confirmation_escapes_html_content(monkeypatch):
    client = Mock()
    monkeypatch.setattr(ticket_notifications.boto3, "client", lambda *args, **kwargs: client)
    monkeypatch.setenv("SES_FROM_EMAIL", "support@example.com")

    ticket_notifications.send_ticket_confirmation_email(
        {
            "id": 7,
            "requester_name": "<Admin>",
            "requester_email": "user@example.com",
            "title": "<script>alert(1)</script>",
            "category": "Security & Access",
            "created_at": "2026-10-17T18:00:00+00:00",
        }
    )

    html = client.send_email.call_args.kwargs["Message"]["Body"]["Html"]["Data"]
    assert "<script>" not in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "Security &amp; Access" in html


def test_ticket_confirmation_requires_sender(monkeypatch):
    monkeypatch.delenv("SES_FROM_EMAIL", raising=False)

    with pytest.raises(ticket_notifications.TicketNotificationError, match="SES_FROM_EMAIL"):
        ticket_notifications.send_ticket_confirmation_email(
            {"id": 1, "requester_email": "user@example.com"}
        )


def test_ticket_confirmation_wraps_ses_failures(monkeypatch):
    client = Mock()
    client.send_email.side_effect = ClientError(
        {"Error": {"Code": "MessageRejected", "Message": "rejected"}},
        "SendEmail",
    )
    monkeypatch.setattr(ticket_notifications.boto3, "client", lambda *args, **kwargs: client)
    monkeypatch.setenv("SES_FROM_EMAIL", "support@example.com")

    with pytest.raises(ticket_notifications.TicketNotificationError, match="SES"):
        ticket_notifications.send_ticket_confirmation_email(
            {"id": 1, "requester_email": "user@example.com"}
        )
