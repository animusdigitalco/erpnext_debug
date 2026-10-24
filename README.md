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

Log in as a System Manager. A small **Debug** pill appears bottom-right.

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

Traces expire after 6 hours and the index keeps the last 500.

## Configuration (site_config.json)

| key | default | meaning |
| --- | --- | --- |
| `erpnext_debug_disabled` | `0` | Set to `1` to stop tracing on this site |
| `erpnext_debug_ttl` | `21600` | Seconds a trace is kept |
| `erpnext_debug_max_traces` | `500` | How many traces the index keeps |

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

## License

MIT
