# email-service/email_service.py
import hmac
import html
import mimetypes
import os
import smtplib
from email.message import EmailMessage
from email.utils import make_msgid
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=True)

app = Flask(__name__)
from flask import jsonify

@app.get("/")
def home():
    return {"ok": True, "service": "email-service"}

@app.get("/health")
def health():
    return {"ok": True}

# if your worker calls /api/health
@app.get("/api/health")
def api_health():
    return {"ok": True}

# whatever your worker calls for sending:
@app.post("/api/send-invoice-email")
def send_invoice_email():
    ...
    return {"ok": True}allowed_origins = [
    origin.strip()
    for origin in (os.getenv("ALLOWED_ORIGIN") or "").split(",")
    if origin.strip()
]
CORS(
    app,
    resources={
        r"/": {"origins": "*"},
        r"/send-invoice-email": {"origins": allowed_origins or "*"},
        r"/health": {"origins": "*"},
    },
)

SERVICE_API_KEY = (os.getenv("SERVICE_API_KEY") or "").strip()


@app.errorhandler(HTTPException)
def handle_http_errors(err: HTTPException):
    return jsonify(ok=False, error=err.description), err.code


@app.errorhandler(Exception)
def handle_all_errors(err: Exception):
    return jsonify(ok=False, error=str(err)), 500


def env_str(name: str, default: str = "") -> str:
    value = os.getenv(name, default)
    return value.strip() if isinstance(value, str) else default


def require_api_key():
    provided = (request.headers.get("x-api-key") or "").strip()

    if not provided:
        return jsonify(ok=False, error="Missing x-api-key header"), 401

    if not SERVICE_API_KEY:
        return jsonify(ok=False, error="SERVICE_API_KEY is not configured"), 500

    if not hmac.compare_digest(provided, SERVICE_API_KEY):
        return jsonify(ok=False, error="Invalid API key"), 401

    return None


def format_money(amount: float) -> str:
    return f"${amount:,.2f}"


def is_paid_status(status: str) -> bool:
    return status.strip().lower() == "paid"


def build_subject(company_name: str, customer_name: str, status: str, job_number: str) -> str:
    prefix = "Paid receipt" if is_paid_status(status) else "Invoice"
    base = f"{prefix} from {company_name}"
    if job_number:
        return f"{base} - {job_number}"
    if customer_name:
        return f"{base} - {customer_name}"
    return base


def build_intro(company_name: str, customer_name: str, status: str) -> tuple[str, str]:
    display_name = customer_name or "Customer"

    if is_paid_status(status):
        title = "Payment Receipt"
        intro = f"This is your paid receipt from {company_name}."
    else:
        title = "Invoice"
        intro = f"This is your invoice from {company_name}."

    greeting = f"Hello {display_name},"
    return title, f"{greeting}\n\n{intro}"


def build_text_body(
    company_name: str,
    customer_name: str,
    amount: float,
    status: str,
    job_number: str,
    notes: str,
    payment_url: str,
    company_phone: str,
    reply_to_email: str,
) -> str:
    title, intro = build_intro(company_name, customer_name, status)

    lines = [
        title,
        "",
        intro,
        "",
        f"Amount: {format_money(amount)}",
        f"Status: {status or 'Unpaid'}",
    ]

    if job_number:
        lines.append(f"Job number: {job_number}")
    if notes:
        lines.append(f"Notes: {notes}")
    if not is_paid_status(status) and payment_url:
        lines.append(f"Payment link: {payment_url}")
    if company_phone:
        lines.append(f"Phone: {company_phone}")
    if reply_to_email:
        lines.append(f"Reply to: {reply_to_email}")

    lines.extend(["", "Thank you."])
    return "\n".join(lines)


def load_logo_asset(logo_path: str) -> tuple[bytes, str, str] | None:
    if not logo_path:
        return None

    path = Path(logo_path)
    if not path.is_file():
        return None

    mime_type, _ = mimetypes.guess_type(path.name)
    if not mime_type or not mime_type.startswith("image/"):
        return None

    maintype, subtype = mime_type.split("/", 1)
    if maintype != "image":
        return None

    return path.read_bytes(), subtype, path.name


def build_brand_header(company_name: str, logo_cid: str | None) -> str:
    safe_company_name = html.escape(company_name)

    if logo_cid:
        return f"""
<tr>
  <td align="left" style="padding:0 0 12px;">
    <img
      src="cid:{logo_cid}"
      alt="{safe_company_name}"
      style="display:block;width:72px;max-width:72px;height:auto;border:0;outline:none;text-decoration:none;"
    />
  </td>
</tr>
"""

    return ""


def build_detail_row(label: str, value: str) -> str:
    safe_label = html.escape(label)
    safe_value = html.escape(value)
    return f"""
<tr>
  <td style="padding:8px 0 4px;vertical-align:top;font-size:18px;line-height:1.5;color:#111827;font-weight:700;width:165px;">
    {safe_label}:
  </td>
  <td style="padding:8px 0 4px;vertical-align:top;font-size:18px;line-height:1.5;color:#111827;">
    {safe_value}
  </td>
</tr>
"""


def build_reply_row(reply_to_email: str) -> str:
    safe_reply_to = html.escape(reply_to_email)
    return f"""
<tr>
  <td style="padding:8px 0 4px;vertical-align:top;font-size:18px;line-height:1.5;color:#111827;font-weight:700;width:165px;">
    Reply to:
  </td>
  <td style="padding:8px 0 4px;vertical-align:top;font-size:18px;line-height:1.5;">
    <a href="mailto:{safe_reply_to}" style="color:#2563eb;text-decoration:underline;">
      {safe_reply_to}
    </a>
  </td>
</tr>
"""


def build_payment_link_row(payment_url: str) -> str:
    safe_url = html.escape(payment_url, quote=True)
    safe_text = html.escape(payment_url)
    return f"""
<tr>
  <td style="padding:8px 0 4px;vertical-align:top;font-size:18px;line-height:1.5;color:#111827;font-weight:700;width:165px;">
    Payment link:
  </td>
  <td style="padding:8px 0 4px;vertical-align:top;font-size:18px;line-height:1.5;">
    <a href="{safe_url}" style="color:#2563eb;text-decoration:underline;">
      {safe_text}
    </a>
  </td>
</tr>
"""


def build_html_body(
    company_name: str,
    customer_name: str,
    amount: float,
    status: str,
    job_number: str,
    notes: str,
    payment_url: str,
    company_phone: str,
    reply_to_email: str,
    logo_cid: str | None,
) -> str:
    title, intro = build_intro(company_name, customer_name, status)
    safe_title = html.escape(title)
    safe_intro = "<br><br>".join(html.escape(part) for part in intro.split("\n\n"))

    detail_rows = [
        build_detail_row("Amount", format_money(amount)),
        build_detail_row("Status", status or "Unpaid"),
    ]

    if job_number:
        detail_rows.append(build_detail_row("Job number", job_number))
    if notes:
        detail_rows.append(build_detail_row("Notes", notes))
    if not is_paid_status(status) and payment_url:
        detail_rows.append(build_payment_link_row(payment_url))
    if company_phone:
        detail_rows.append(build_detail_row("Phone", company_phone))
    if reply_to_email:
        detail_rows.append(build_reply_row(reply_to_email))

    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{safe_title}</title>
  </head>
  <body style="margin:0;padding:12px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:640px;">
      {build_brand_header(company_name, logo_cid)}
      <tr>
        <td style="padding:0 0 14px;font-size:28px;line-height:1.2;font-weight:800;color:#0b1736;">
          {safe_title}
        </td>
      </tr>
      <tr>
        <td style="padding:0 0 16px;font-size:18px;line-height:1.7;color:#111827;">
          {safe_intro}
        </td>
      </tr>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:640px;">
      {''.join(detail_rows)}
      <tr>
        <td colspan="2" style="padding:18px 0 0;font-size:18px;line-height:1.7;color:#111827;">
          Thank you.
        </td>
      </tr>
    </table>
  </body>
</html>"""


def parse_payload(payload: dict[str, Any]) -> tuple[str, str, float, str, str, str, str]:
    to_email = (payload.get("to_email") or "").strip()
    customer_name = (payload.get("customer_name") or "").strip()
    status = (payload.get("status") or "Unpaid").strip() or "Unpaid"
    job_number = (payload.get("job_number") or "").strip()
    notes = (payload.get("notes") or "").strip()
    payment_url = (payload.get("payment_url") or "").strip()

    if not to_email:
        raise ValueError("Missing to_email")

    try:
        amount = float(payload.get("amount") or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid amount") from exc

    if amount < 0:
        raise ValueError("Invalid amount")

    return to_email, customer_name, amount, status, job_number, notes, payment_url


@app.get("/")
def root():
    return jsonify(ok=True, service="aristaemail")


@app.get("/health")
def health():
    return jsonify(ok=True)


@app.post("/send-invoice-email")
def send_invoice_email():
    auth_error = require_api_key()
    if auth_error:
        return auth_error

    payload: dict[str, Any] = request.get_json(silent=True) or {}

    try:
        to_email, customer_name, amount, status, job_number, notes, payment_url = parse_payload(payload)
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400

    smtp_server = env_str("SMTP_SERVER")
    smtp_port = int(env_str("SMTP_PORT", "587"))
    smtp_username = env_str("SMTP_USERNAME")
    smtp_password = env_str("SMTP_PASSWORD")
    sender_email = env_str("SENDER_EMAIL")
    sender_name = env_str("SENDER_NAME", "Arista Plumbing")
    reply_to_email = env_str("REPLY_TO_EMAIL", sender_email)
    company_name = env_str("COMPANY_NAME", sender_name)
    company_phone = env_str("COMPANY_PHONE")
    logo_path = env_str("LOGO_PATH")

    if not all([smtp_server, smtp_username, smtp_password, sender_email]):
        return jsonify(ok=False, error="Email service is not fully configured"), 500

    logo_asset = load_logo_asset(logo_path)
    logo_cid = make_msgid(domain="arista.local")[1:-1] if logo_asset else None

    subject = build_subject(company_name, customer_name, status, job_number)
    text_body = build_text_body(
        company_name=company_name,
        customer_name=customer_name,
        amount=amount,
        status=status,
        job_number=job_number,
        notes=notes,
        payment_url=payment_url,
        company_phone=company_phone,
        reply_to_email=reply_to_email,
    )
    html_body = build_html_body(
        company_name=company_name,
        customer_name=customer_name,
        amount=amount,
        status=status,
        job_number=job_number,
        notes=notes,
        payment_url=payment_url,
        company_phone=company_phone,
        reply_to_email=reply_to_email,
        logo_cid=logo_cid,
    )

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"{sender_name} <{sender_email}>"
    msg["To"] = to_email
    if reply_to_email:
        msg["Reply-To"] = reply_to_email

    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")

    if logo_asset and logo_cid:
        logo_bytes, logo_subtype, logo_filename = logo_asset
        html_part = msg.get_payload()[-1]
        html_part.add_related(
            logo_bytes,
            maintype="image",
            subtype=logo_subtype,
            cid=f"<{logo_cid}>",
            filename=logo_filename,
            disposition="inline",
        )

    try:
        with smtplib.SMTP(smtp_server, smtp_port, timeout=30) as server:
            server.starttls()
            server.login(smtp_username, smtp_password)
            server.send_message(msg)
    except smtplib.SMTPException as exc:
        return jsonify(ok=False, error=f"SMTP error: {exc}"), 502
    except OSError as exc:
        return jsonify(ok=False, error=f"Unable to connect to the email server: {exc}"), 502

    return jsonify(ok=True, message="sent"), 200


if __name__ == "__main__":
    port = int(env_str("PORT", env_str("EMAIL_SERVICE_PORT", "5050")))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)