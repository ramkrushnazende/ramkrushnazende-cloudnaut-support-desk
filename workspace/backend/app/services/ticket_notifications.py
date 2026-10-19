"""Email notifications for support-ticket lifecycle events."""

import logging
import os
from collections.abc import Mapping
from html import escape

import boto3
from botocore.exceptions import BotoCoreError, ClientError

logger = logging.getLogger(__name__)


class TicketNotificationError(RuntimeError):
    """A ticket notification could not be sent."""


def send_ticket_confirmation_email(ticket: Mapping[str, object]) -> None:
    """Send a ticket confirmation through Amazon SES.

    The caller invokes this only after the ticket transaction has committed.
    Missing configuration and SES failures are surfaced as a dedicated error
    so the API can log them without rolling back ticket creation.
    """
    source = os.getenv("SES_FROM_EMAIL", "").strip()
    if not source:
        raise TicketNotificationError("SES_FROM_EMAIL is not configured.")

    recipient = str(ticket.get("requester_email") or "").strip()
    if not recipient:
        raise TicketNotificationError("Ticket requester email is missing.")

    ticket_id = ticket.get("id")
    requester_name = str(ticket.get("requester_name") or "there")
    title = str(ticket.get("title") or "Support request")
    category = str(ticket.get("category") or "Uncategorized")
    created_at = str(ticket.get("created_at") or "unknown")
    subject = f"Your Cloudnaut support request is confirmed · Ticket #{ticket_id}"
    body = (
        f"Hello {requester_name},\n\n"
        "Your support request was created successfully.\n\n"
        f"Ticket ID: {ticket_id}\n"
        f"Subject: {title}\n"
        f"Category: {category}\n"
        f"Created: {created_at}\n\n"
        "Our support team will review your request shortly.\n"
    )
    html_body = f"""\
<!doctype html>
<html lang="en">
  <head>
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Support request confirmed</title>
  </head>
  <body style="margin:0;background:#f3f5fb;color:#172033;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      Your Cloudnaut Support Desk request has been received and is ready for review.
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:36px 16px;background:#f3f5fb;">
      <tr><td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0"
          style="max-width:600px;background:#ffffff;border:1px solid #e1e6f0;border-radius:16px;overflow:hidden;
                 box-shadow:0 8px 28px rgba(42,55,90,.08);">
          <tr><td style="background:#101b35;padding:30px 36px;color:#ffffff;">
            <div style="font-size:12px;letter-spacing:1.8px;text-transform:uppercase;color:#9fc7ff;font-weight:700;">
              Cloudnaut Technologies
            </div>
            <h1 style="margin:12px 0 0;font-size:26px;line-height:1.25;font-weight:700;">
              Support request confirmed
            </h1>
            <p style="margin:10px 0 0;color:#c6d4ec;font-size:14px;line-height:1.5;">
              Cloudnaut Support Desk
            </p>
          </td></tr>
          <tr><td style="padding:36px;">
            <p style="margin:0 0 16px;font-size:17px;font-weight:700;">Hello {escape(requester_name)},</p>
            <p style="margin:0 0 24px;color:#526078;line-height:1.65;">
              Thank you for contacting us. Your support request has been received
              successfully and is now in our queue.
            </p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
              style="border:1px solid #dfe5f0;border-radius:12px;background:#f8faff;">
              <tr><td style="padding:16px 18px;border-bottom:1px solid #e3e8f2;color:#66738a;font-size:13px;">Ticket ID</td>
                  <td align="right" style="padding:16px 18px;border-bottom:1px solid #e3e8f2;color:#235fc1;font-weight:700;">#{escape(str(ticket_id))}</td></tr>
              <tr><td style="padding:16px 18px;border-bottom:1px solid #e3e8f2;color:#66738a;font-size:13px;">Subject</td>
                  <td align="right" style="padding:16px 18px;border-bottom:1px solid #e3e8f2;color:#172033;font-weight:700;">{escape(title)}</td></tr>
              <tr><td style="padding:16px 18px;border-bottom:1px solid #e3e8f2;color:#66738a;font-size:13px;">Category</td>
                  <td align="right" style="padding:16px 18px;border-bottom:1px solid #e3e8f2;color:#172033;font-weight:700;">{escape(category)}</td></tr>
              <tr><td style="padding:16px 18px;color:#66738a;font-size:13px;">Status</td>
                  <td align="right" style="padding:16px 18px;color:#147a61;font-weight:700;">Received</td></tr>
            </table>
            <p style="margin:24px 0 0;color:#526078;line-height:1.65;">
              Our support team will review your request shortly. Please keep your
              ticket ID for future reference.
            </p>
          </td></tr>
          <tr><td style="padding:22px 36px;background:#f8faff;color:#7a879b;font-size:12px;line-height:1.6;">
            This is an automated confirmation from Cloudnaut Support Desk.<br>
            Please do not reply to this email.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>
"""

    try:
        boto3.client(
            "ses",
            region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
        ).send_email(
            Source=source,
            Destination={"ToAddresses": [recipient]},
            Message={
                "Subject": {"Data": subject, "Charset": "UTF-8"},
                "Body": {
                    "Text": {"Data": body, "Charset": "UTF-8"},
                    "Html": {"Data": html_body, "Charset": "UTF-8"},
                },
            },
        )
    except (BotoCoreError, ClientError) as error:
        raise TicketNotificationError("Amazon SES rejected the ticket email.") from error
