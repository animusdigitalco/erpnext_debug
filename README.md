# ERPNext Debug

An on-screen tracer for people building on Frappe and ERPNext.

Save a document and see, in order, everything the framework ran for it: the
controller method, every `doc_events` hook from every installed app,
notifications, webhooks and server scripts. Each step shows the app that owns
it, how long it took, and if it threw, the traceback. The failing step is
highlighted, right next to the form that caused it.

It lives in a closable panel at the bottom of the Desk, the way a browser
dev tools drawer does. Failed saves pop it open. Passing saves add a quiet
row. Close it and it stays closed until you want it.

> **Staging and local benches only.** This app patches core document methods
> at runtime and records every request. Do not install it on production.

## Install

```bash
bench get-app https://github.com/animusdigitalco/erpnext_debug
bench --site your-staging-site install-app erpnext_debug
bench build --app erpnext_debug
bench restart
```

Then, as a System Manager, open **ERPNext Debug Settings** (search bar, or
`/app/erpnext-debug-settings`), tick **Enable tracing** and save. Reload and
a small **Debug** pill appears bottom-right. Tracing is off by default after
install, so nothing is recorded until someone turns it on.

## Using it

- Click the pill, or press **Ctrl+Shift+D**, to open or close the panel.
- Save, submit or cancel any document. A row appears with the doctype, the
  events that fired (`validate → on_update → on_submit`) and total time.
- Click a row to expand the timeline. Each event lists its steps with the
  owning app. Framework steps that did nothing are folded into one dim line.
- A failed step shows its error and a **traceback** link.
- **Errors only** filters the list. **Open on error** controls whether a
  failure pops the panel open. **Pause** stops new rows without clearing.
- **⤢** opens the same list as a full Desk page (`/app/debug-traces`).
- Background jobs are traced too and tagged `job`.

### Browser side

- **Client scripts.** Every `frappe.ui.form.on` handler is timed and
  attributed to the app file it came from (`erpnext / sales_invoice.js`,
  `kingsway / sales_invoice.js`) or to the **Client Script** record by name,
  with a link to open it. When a save goes to the server, the handlers that
  ran just before it (`validate`, `before_save`) appear in the same row under
  a **Browser** heading, above the server events. A handler that throws, or
  one that sets `frappe.validated = false` and blocks the save, gets its own
  row even though no request was made.
- **JS errors.** Uncaught exceptions and unhandled promise rejections show
  up as rows with the stack trace and the app that owns the file.
- **Portal pages.** The same panel loads on website and portal pages (web
  forms, customer portal) for logged-in System Managers, so a failing web
  form submit can be read on the page itself. Guests and other users never
  load anything beyond the script tag.

Browser-side rows live in the page's memory and are gone on reload; server
traces persist in Redis.

## How it works

- `before_request` installs runtime wrappers (once per worker) around
  `Document.run_method`, `Document.hook`, `run_notifications`,
  `run_webhooks`, `run_server_script_for_doc_event` and
  `ServerScript.execute_doc`. Nothing in frappe core is edited.
- Each request gets a trace object on `frappe.local`. Every `run_method`
  call becomes an event; every handler it composes becomes a step.
- `after_request` writes the trace to Redis and stamps the response with an
  `X-ERPNext-Debug-Trace` header. Redis, not a table, because a failed save
  rolls back the database transaction and would take the trace with it.
- The Desk script watches `ajaxComplete` and `fetch`, sees the header, and
  pulls the trace into the panel.
- `frappe.ui.form.on` is wrapped at load. Frappe evaluates form scripts with
  a `sourceURL` and per-file markers, so the stack at registration time maps
  each handler back to its file or Client Script record.

Traces expire after 6 hours and the index keeps the last 500.

## Configuration

**ERPNext Debug Settings** (a Single DocType, System Manager only):

| field | default | meaning |
| --- | --- | --- |
| Enable tracing | off | Master switch. Nothing is recorded or shown while off |
| Open panel automatically on errors | on | Default for new users; each user can change it in the panel |
| Keep traces for (hours) | 6 | Redis TTL per trace |
| Maximum traces kept | 500 | Oldest are dropped past this |

**site_config.json** overrides, for benches you manage by config:

| key | meaning |
| --- | --- |
| `erpnext_debug_disabled: 1` | Hard off switch. Wins over the Settings form |
| `erpnext_debug_ttl` | Seconds a trace is kept. Wins over the form |
| `erpnext_debug_max_traces` | Index size. Wins over the form |

Only users with the **System Manager** role see the panel or can call the
API. Traces contain document names and error messages, so treat them like
the Error Log.

## Compatibility

Written against Frappe v15. The wrapped functions have been stable through
v14 and v15; v16 is expected to work but is not yet verified.

## Roadmap

- Permission explainer: why a user can or cannot see a record
- Hook conflict report across installed apps
- Scheduler event traces
- Persist browser-side rows so they survive a reload

## License

MIT
