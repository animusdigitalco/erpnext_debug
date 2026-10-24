import frappe

from erpnext_debug.tracer import storage
from erpnext_debug.tracer.core import is_enabled

SUMMARY_FIELDS = (
	"id",
	"kind",
	"user",
	"path",
	"cmd",
	"http_method",
	"started_at",
	"duration_ms",
	"status_code",
	"ok",
	"exc_type",
	"error",
	"doc",
	"event_count",
	"truncated",
)


def _guard():
	frappe.only_for("System Manager")


def _summary(trace: dict) -> dict:
	out = {k: trace.get(k) for k in SUMMARY_FIELDS}
	# Top-level event methods, so a row can read "validate → on_update → on_submit".
	out["methods"] = [e["method"] for e in trace.get("events", []) if e.get("depth") == 0][:8]
	return out


@frappe.whitelist()
def status():
	_guard()
	return {
		"enabled": is_enabled(),
		"ttl": storage.ttl_seconds(),
		"max_traces": storage.max_traces(),
		"count": len(storage.list_trace_ids(storage.max_traces())),
	}


@frappe.whitelist()
def list_traces(limit: int = 100, errors_only: int = 0):
	_guard()
	limit = min(int(limit or 100), storage.max_traces())
	rows = []
	for trace_id in storage.list_trace_ids(limit):
		trace = storage.get_trace(trace_id)
		if not trace:
			continue
		if int(errors_only or 0) and trace.get("ok"):
			continue
		rows.append(_summary(trace))
	return rows


@frappe.whitelist()
def get_trace(trace_id: str):
	_guard()
	trace = storage.get_trace(trace_id)
	if not trace:
		frappe.throw(frappe._("Trace {0} has expired or does not exist").format(trace_id), frappe.DoesNotExistError)
	return trace


@frappe.whitelist()
def get_summary(trace_id: str):
	_guard()
	trace = storage.get_trace(trace_id)
	return _summary(trace) if trace else None


@frappe.whitelist()
def clear_traces():
	_guard()
	storage.clear()
	return {"ok": True}
