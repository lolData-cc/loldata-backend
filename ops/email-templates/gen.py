"""
GoTrue email templates for the box, in the site's language.

One layout, three mails. Table-based, every style inline, no web fonts, no
box-shadow: what Gmail, Outlook and Apple Mail all agree on. Go template
tags ({{ .Token }}, {{ .ConfirmationURL }}) are the only braces in the files.
"""
import io, os, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else "."

GROUND = "#040A0C"
PLATE = "#050d10"
JADE = "#00d992"
FLASH = "#d7d8d9"
MONO = "'JetBrains Mono','SFMono-Regular',Menlo,Consolas,'Courier New',monospace"


def code_block(token):
    return f"""
              <tr>
                <td align="center" style="padding:6px 0 26px 0;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                    <tr>
                      <td align="center" bgcolor="#071a16" style="background:#071a16;border:1px solid #0f3a30;border-radius:3px;padding:18px 34px;">
                        <span style="font-family:{MONO};font-size:34px;line-height:40px;letter-spacing:0.34em;color:{JADE};font-weight:700;">{token}</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>"""


def button(label, href):
    return f"""
              <tr>
                <td align="center" style="padding:6px 0 26px 0;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                    <tr>
                      <td align="center" bgcolor="#071a16" style="background:#071a16;border:1px solid #0f3a30;border-radius:3px;">
                        <a href="{href}" style="display:inline-block;padding:14px 34px;font-family:{MONO};font-size:12px;line-height:16px;letter-spacing:0.18em;color:{JADE};text-decoration:none;text-transform:uppercase;font-weight:700;">&#9672;&nbsp; {label}</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>"""


def mail(eyebrow, title, lead, middle, note, fallback=None):
    fallback_row = ""
    if fallback:
        fallback_row = f"""
              <tr>
                <td style="padding:0 0 22px 0;font-family:{MONO};font-size:10px;line-height:16px;color:#5a6a66;">
                  {fallback}
                </td>
              </tr>"""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>{title}</title>
</head>
<body style="margin:0;padding:0;background:{GROUND};" bgcolor="{GROUND}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{GROUND}" style="background:{GROUND};border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:40px 16px 48px 16px;">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:100%;border-collapse:collapse;">

          <!-- wordmark -->
          <tr>
            <td align="left" style="padding:0 0 22px 4px;font-family:{MONO};font-size:15px;letter-spacing:0.28em;color:#6b7572;">
              lol<span style="color:{JADE};">&#9672;</span><span style="color:{FLASH};font-weight:700;">data</span>
            </td>
          </tr>

          <!-- plate -->
          <tr>
            <td bgcolor="{PLATE}" style="background:{PLATE};border:1px solid #0d2b25;border-top:1px solid {JADE};border-radius:3px;padding:34px 36px 20px 36px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">

                <tr>
                  <td style="padding:0 0 10px 0;font-family:{MONO};font-size:10px;line-height:14px;letter-spacing:0.2em;color:{JADE};text-transform:uppercase;">
                    &#9672;&nbsp; {eyebrow}
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 0 6px 0;font-family:{MONO};font-size:24px;line-height:30px;color:{FLASH};font-weight:700;">
                    {title}
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 0 22px 0;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td width="64" height="1" bgcolor="{JADE}" style="background:{JADE};font-size:0;line-height:0;">&nbsp;</td></tr></table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 0 22px 0;font-family:{MONO};font-size:13px;line-height:21px;color:#9aa5a1;">
                    {lead}
                  </td>
                </tr>
{middle}
                <tr>
                  <td style="padding:0 0 22px 0;font-family:{MONO};font-size:11px;line-height:18px;color:#5a6a66;">
                    {note}
                  </td>
                </tr>{fallback_row}
              </table>
            </td>
          </tr>

          <!-- footer -->
          <tr>
            <td align="left" style="padding:18px 4px 0 4px;font-family:{MONO};font-size:10px;line-height:16px;letter-spacing:0.08em;color:#3f4a47;">
              lolData &middot; <a href="https://loldata.cc" style="color:#3f4a47;text-decoration:none;">loldata.cc</a> &middot; your games, your runes, your record.
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""


TEMPLATES = {
    "confirmation": mail(
        eyebrow="Verification code",
        title="Confirm your email",
        lead="Enter this code on loldata.cc to finish creating your account.",
        middle=code_block("{{ .Token }}"),
        note="The code is valid for 24 hours. If you didn&#8217;t sign up for lolData, you can ignore this email &mdash; nothing happens without the code.",
        fallback="Can&#8217;t enter the code? <a href=\"{{ .ConfirmationURL }}\" style=\"color:#5a6a66;\">Confirm with this link instead</a>.",
    ),
    "recovery": mail(
        eyebrow="Password reset",
        title="Reset your password",
        lead="Someone asked to reset the password for this lolData account. If that was you, choose a new one here:",
        middle=button("Reset password", "{{ .ConfirmationURL }}"),
        note="The link is valid for 24 hours and works once. If you didn&#8217;t ask for this, ignore this email &mdash; your password stays as it is.",
        fallback="If the button doesn&#8217;t open, copy this address into your browser:<br>{{ .ConfirmationURL }}",
    ),
    "magic_link": mail(
        eyebrow="Sign in",
        title="Your sign-in link",
        lead="Press the button to sign in to lolData, or enter the code on the page you came from.",
        middle=button("Sign in", "{{ .ConfirmationURL }}") + code_block("{{ .Token }}"),
        note="Valid for 24 hours. If you didn&#8217;t request this, ignore this email.",
    ),
}

os.makedirs(OUT, exist_ok=True)
for name, html in TEMPLATES.items():
    assert html.count("{{") == html.count("}}")
    io.open(os.path.join(OUT, f"{name}.html"), "w", encoding="utf-8", newline="\n").write(html)
    # a preview with sample values, for looking at
    prev = html.replace("{{ .Token }}", "482 917".replace(" ", "")).replace("{{ .ConfirmationURL }}", "https://sb.loldata.cc/auth/v1/verify?token=…")
    io.open(os.path.join(OUT, f"preview_{name}.html"), "w", encoding="utf-8", newline="\n").write(prev)
    print(name, len(html), "byte")
