"""Runtime tracer.

Records, in order, everything Frappe runs when a document event fires:
the controller method, every doc_events hook from every installed app,
notifications, webhooks and server scripts. Each step gets its owning app,
its timing and, if it threw, the traceback.

Nothing in frappe core is edited. The functions below are wrapped at runtime
the first time a request or job arrives in a worker. When no trace is active
for the current request, every wrapper falls straight through to the original.
"""

import threading
import time
import traceback

import frappe
from frappe.model.document import Document

from erpnext_debug.tracer import storage

HEADER = "X-ERPNext-Debug-Trace"
MAX_EVENTS = 2000
MAX_ERROR_CHARS = 2000
MAX_TRACEBACK_CHARS = 12000

_patch_lock = threading.Lock()
_patched = False

_orig_run_method = None
_orig_hook = None
_orig_run_notifications = None
_orig_run_webhooks = None
_orig_run_server_scripts = None
_orig_execute_doc = None


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def is_enabled() -> bool:
	"""Tracing is on when a System Manager has turned it on in
	ERPNext Debug Settings. ``erpnext_debug_disabled: 1`` in site_config.json
	is a hard off switch that overrides the form.
	"""
	if frappe.conf.get("erpnext_debug_disabled"):
		return False
	from erpnext_debug.erpnext_debug.doctype.erpnext_debug_settings.erpnext_debug_settings import get_settings

	return bool(get_settings().get("enabled"))


def boot_session(bootinfo):
	if "System Manager" in frappe.get_roles():
		from erpnext_debug.erpnext_debug.doctype.erpnext_debug_settings.erpnext_debug_settings import get_settings

		settings = get_settings()
		bootinfo.erpnext_debug = {
			"enabled": is_enabled(),
			"open_on_error": bool(settings.get("open_on_error", 1)),
			"ttl": storage.ttl_seconds(),
			"header": HEADER,
		}


# ---------------------------------------------------------------------------
# Trace object
# ---------------------------------------------------------------------------


class Trace:
	def __init__(self, kind: str, path: str, cmd: str | None = None, http_method: str | None = None):
		self.data = {
			"id": frappe.generate_hash(length=12),
			"kind": kind,  # request | job
			"site": frappe.local.site,
			"user": frappe.session.user if getattr(frappe, "session", None) else None,
			"path": path,
			"cmd": cmd,
			"http_method": http_method,
			"started_at": frappe.utils.now_datetime().isoformat(timespec="milliseconds"),
			"duration_ms": None,
			"status_code": None,
			"ok": True,
			"exc_type": None,
			"error": None,
			"doc": None,
			"event_count": 0,
			"events": [],
		}
		self._t0 = time.perf_counter()
		self._stack: list[dict] = []
		self._truncated = False

	# -- events (one per Document.run_method call) --

	def push_event(self, doc, method: str) -> dict | None:
		if len(self.data["events"]) >= MAX_EVENTS:
			self._truncated = True
			self._stack.append(None)
			return None
		event = {
			"method": method,
			"doctype": doc.doctype,
			"name": doc.name,
			"depth": len(self._stack),
			"duration_ms": None,
			"ok": True,
			"error": None,
			"steps": [],
		}
		self.data["events"].append(event)
		self._stack.append(event)
		if self.data["doc"] is None and not getattr(doc, "parenttype", None):
			self.data["doc"] = {"doctype": doc.doctype, "name": doc.name}
		return event

	def pop_event(self):
		if self._stack:
			self._stack.pop()

	def current_event(self) -> dict | None:
		return self._stack[-1] if self._stack else None

	# -- finish --

	def has_content(self) -> bool:
		return bool(self.data["events"])

	def finish(self, status_code=None, exc_type=None, error=None):
		d = self.data
		d["duration_ms"] = round((time.perf_counter() - self._t0) * 1000, 2)
		d["status_code"] = status_code
		d["event_count"] = len(d["events"])
		d["truncated"] = self._truncated
		if exc_type:
			d["exc_type"] = exc_type
		if error:
			d["error"] = _clip(str(error), MAX_ERROR_CHARS)
		failed = [e for e in d["events"] if not e["ok"]]
		if failed:
			d["ok"] = False
			d["error"] = d["error"] or failed[0]["error"]
		if status_code is not None and status_code >= 400:
			d["ok"] = False
		return d


def current_trace() -> Trace | None:
	return getattr(frappe.local, "erpnext_debug_trace", None)


def _clip(text: str, limit: int) -> str:
	if text is None:
		return None
	text = str(text)
	return text if len(text) <= limit else text[:limit] + " …[truncated]"


def _mark_error(node: dict, exc: BaseException, with_traceback: bool):
	node["ok"] = False
	node["error"] = _clip(str(exc) or exc.__class__.__name__, MAX_ERROR_CHARS)
	node["exc_type"] = exc.__class__.__name__
	# Only the innermost step keeps the traceback; everything above it just notes the failure.
	if with_traceback and not getattr(exc, "_erpnext_debug_seen", False):
		node["traceback"] = _clip(traceback.format_exc(), MAX_TRACEBACK_CHARS)
		try:
			exc._erpnext_debug_seen = True
		except Exception:
			pass


def _app_of(dotted: str) -> str:
	return (dotted or "").split(".")[0] or "?"


def _record_step(trace: Trace, kind: str, label: str, app: str, func, *args, **kwargs):
	event = trace.current_event()
	step = {
		"kind": kind,
		"label": label,
		"app": app,
		"duration_ms": None,
		"ok": True,
		"error": None,
	}
	if event is not None:
		event["steps"].append(step)
	t0 = time.perf_counter()
	try:
		return func(*args, **kwargs)
	except BaseException as exc:
		_mark_error(step, exc, with_traceback=True)
		raise
	finally:
		step["duration_ms"] = round((time.perf_counter() - t0) * 1000, 3)


# ---------------------------------------------------------------------------
# Wrappers
# ---------------------------------------------------------------------------


def _traced_run_method(self, method, *args, **kwargs):
	trace = current_trace()
	if trace is None:
		return _orig_run_method(self, method, *args, **kwargs)

	event = trace.push_event(self, method)
	t0 = time.perf_counter()
	try:
		return _orig_run_method(self, method, *args, **kwargs)
	except BaseException as exc:
		if event is not None:
			_mark_error(event, exc, with_traceback=False)
		raise
	finally:
		if event is not None:
			event["duration_ms"] = round((time.perf_counter() - t0) * 1000, 2)
		trace.pop_event()


def _traced_hook(f):
	"""Replacement for ``Document.hook``.

	Mirrors frappe's composer (controller method first, then doc_events handlers
	for the doctype, then the ``*`` handlers, with the same return-value merging)
	and records each one as a step. Falls through to the original when no trace
	is active.
	"""
	original = _orig_hook(f)

	def add_to_return_value(self, new_return_value):
		if new_return_value is None:
			self._return_value = self.get("_return_value")
			return
		if isinstance(new_return_value, dict):
			if not self.get("_return_value"):
				self._return_value = {}
			self._return_value.update(new_return_value)
		else:
			self._return_value = new_return_value

	def composer(self, *args, **kwargs):
		trace = current_trace()
		if trace is None or trace.current_event() is None:
			return original(self, *args, **kwargs)

		method = f.__name__
		doc_events = frappe.get_doc_hooks()
		handlers = list(doc_events.get(self.doctype, {}).get(method, [])) + list(
			doc_events.get("*", {}).get(method, [])
		)

		# Controller method, only recorded when the controller actually defines it
		# (same test frappe uses inside run_method's inner fn).
		cls = type(self)
		if method in self.__dict__ or callable(getattr(self, method, None)):
			label = f"{cls.__module__}.{cls.__name__}.{method}"
			result = _record_step(trace, "controller", label, _app_of(cls.__module__), f, self, *args, **kwargs)
		else:
			result = f(self, *args, **kwargs)
		add_to_return_value(self, result)

		for handler in handlers:

			def run_handler(handler=handler):
				fn = frappe.get_attr(handler)
				return fn(self, method, *args, **kwargs)

			result = _record_step(trace, "doc_event", handler, _app_of(handler), run_handler)
			add_to_return_value(self, result)

		return self.__dict__.pop("_return_value", None)

	return composer


def _traced_run_notifications(self, method):
	trace = current_trace()
	if trace is None:
		return _orig_run_notifications(self, method)
	return _record_step(trace, "notifications", "Notifications", "frappe", _orig_run_notifications, self, method)


def _traced_run_webhooks(doc, method):
	trace = current_trace()
	if trace is None:
		return _orig_run_webhooks(doc, method)
	return _record_step(trace, "webhooks", "Webhooks", "frappe", _orig_run_webhooks, doc, method)


def _traced_run_server_scripts(doc, method):
	trace = current_trace()
	if trace is None:
		return _orig_run_server_scripts(doc, method)
	return _record_step(trace, "server_scripts", "Server Scripts", "frappe", _orig_run_server_scripts, doc, method)


def _traced_execute_doc(self, doc):
	trace = current_trace()
	if trace is None:
		return _orig_execute_doc(self, doc)
	return _record_step(trace, "server_script", self.name, "Server Script", _orig_execute_doc, self, doc)


# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------


def ensure_patched():
	global _patched, _orig_run_method, _orig_hook, _orig_run_notifications
	global _orig_run_webhooks, _orig_run_server_scripts, _orig_execute_doc

	if _patched:
		return
	with _patch_lock:
		if _patched:
			return

		import frappe.model.document as document_module

		_orig_run_method = Document.run_method
		_orig_hook = Document.hook
		_orig_run_notifications = Document.run_notifications
		Document.run_method = _traced_run_method
		Document.hook = staticmethod(_traced_hook)
		Document.run_notifications = _traced_run_notifications

		if hasattr(document_module, "run_webhooks"):
			_orig_run_webhooks = document_module.run_webhooks
			document_module.run_webhooks = _traced_run_webhooks

		if hasattr(document_module, "run_server_script_for_doc_event"):
			_orig_run_server_scripts = document_module.run_server_script_for_doc_event
			document_module.run_server_script_for_doc_event = _traced_run_server_scripts

		try:
			from frappe.core.doctype.server_script.server_script import ServerScript

			_orig_execute_doc = ServerScript.execute_doc
			ServerScript.execute_doc = _traced_execute_doc
		except Exception:
			pass

		_patched = True


# ---------------------------------------------------------------------------
# Request lifecycle (hooks.py)
# ---------------------------------------------------------------------------


def _is_own_request(path: str) -> bool:
	return path.startswith("/api/method/erpnext_debug.")


def before_request(*args, **kwargs):
	if not is_enabled():
		return
	ensure_patched()
	request = getattr(frappe.local, "request", None)
	if request is None or _is_own_request(request.path):
		return
	cmd = frappe.form_dict.get("cmd") if getattr(frappe.local, "form_dict", None) else None
	if not cmd and request.path.startswith("/api/method/"):
		cmd = request.path[len("/api/method/") :]
	frappe.local.erpnext_debug_trace = Trace("request", request.path, cmd=cmd, http_method=request.method)


def after_request(response=None, request=None, *args, **kwargs):
	trace = current_trace()
	if trace is None:
		return
	frappe.local.erpnext_debug_trace = None

	status = getattr(response, "status_code", None)
	resp = getattr(frappe.local, "response", None) or {}
	exc_type = resp.get("exc_type")
	error = resp.get("exception") or resp.get("_exc_source") or None

	failed = (status is not None and status >= 400) or exc_type
	if not trace.has_content() and not failed:
		return

	try:
		data = trace.finish(status_code=status, exc_type=exc_type, error=error)
		storage.save_trace(data)
		if response is not None:
			response.headers[HEADER] = data["id"]
	except Exception:
		frappe.logger("erpnext_debug").exception("failed to store trace")


# ---------------------------------------------------------------------------
# Background jobs (hooks.py)
# ---------------------------------------------------------------------------


def before_job(method=None, **kwargs):
	if not is_enabled():
		return
	ensure_patched()
	name = method if isinstance(method, str) else getattr(method, "__name__", str(method))
	frappe.local.erpnext_debug_trace = Trace("job", name, cmd=name)


def after_job(method=None, result=None, **kwargs):
	trace = current_trace()
	if trace is None:
		return
	frappe.local.erpnext_debug_trace = None
	if not trace.has_content():
		return
	try:
		storage.save_trace(trace.finish())
	except Exception:
		frappe.logger("erpnext_debug").exception("failed to store job trace")
