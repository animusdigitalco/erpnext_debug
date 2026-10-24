import frappe
from frappe.model.document import Document

CACHE_KEY = "erpnext_debug:settings"


class ERPNextDebugSettings(Document):
	def validate(self):
		self.ttl_hours = max(int(self.ttl_hours or 6), 1)
		self.max_traces = max(int(self.max_traces or 500), 10)

	def on_update(self):
		# Settings are read on every request, so they are cached. Drop the cache
		# so the change applies to the next request on every worker.
		clear_settings_cache()


def _cache():
	c = frappe.cache
	if callable(c) and not hasattr(c, "get_value"):
		c = c()
	return c


def clear_settings_cache():
	_cache().delete_value(CACHE_KEY)


def get_settings() -> dict:
	"""Cached copy of the Single. Falls back to defaults before the DocType exists
	(for example during install, before migrate has run)."""
	defaults = {"enabled": 0, "open_on_error": 1, "ttl_hours": 6, "max_traces": 500}
	cache = _cache()
	cached = cache.get_value(CACHE_KEY)
	if cached:
		return cached
	try:
		doc = frappe.get_cached_doc("ERPNext Debug Settings")
		settings = {
			"enabled": int(doc.enabled or 0),
			"open_on_error": int(doc.open_on_error if doc.open_on_error is not None else 1),
			"ttl_hours": int(doc.ttl_hours or 6),
			"max_traces": int(doc.max_traces or 500),
		}
	except Exception:
		return defaults
	cache.set_value(CACHE_KEY, settings, expires_in_sec=300)
	return settings
