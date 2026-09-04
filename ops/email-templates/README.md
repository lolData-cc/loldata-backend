# Auth email templates (GoTrue on the box)

The mails the box's GoTrue sends: confirmation (with the 6-digit `{{ .Token }}`
the site asks for), password recovery, magic link. `gen.py` is the source —
one layout, three mails — and the `.html` files are its output.

**Where they run:** `/opt/supabase/docker/volumes/email-templates/` on the box,
served to GoTrue by the `email-templates` nginx sidecar in
`/opt/supabase/docker/docker-compose.yml` (internal only, no ports) via
`GOTRUE_MAILER_TEMPLATES_*` / `GOTRUE_MAILER_SUBJECTS_*` on the `auth` service.

**To change a mail:** edit `gen.py`, run `python gen.py .`, scp the `.html`
files to the box path above, then `docker compose restart auth` — GoTrue
caches fetched templates in-process (its "template cache worker"), so an
edited file is not picked up until auth restarts.
