"""Trace storage.

Traces live in Redis, not in a table. A failed save rolls back the database
transaction, which would also throw away a trace written to a table at exactly
the moment it is useful. Redis sits outside the transaction, needs no setup
on any bench, and expires old traces on its own.
"""

import frappe

INDEX_KEY = "erpnext_debug:index"
TRACE_KEY = "erpnext_debug:trace:{id}"

DEFAULT_TTL_SECONDS = 6 * 60 * 60
DEFAULT_MAX_TRACES = 500


def cache():
	# frappe.cache is a RedisWrapper object in v15+, and a function returning one in v14.
	c = frappe.cache
	if callable(c) and not hasattr(c, "set_value"):
		c = c()
	return c


def _settings() -> dict:
	from erpnext_debug.erpnext_debug.doctype.erpnext_debug_settings.erpnext_debug_settings import get_settings

	return get_settings()


def ttl_seconds() -> int:
	# site_config wins if set, otherwise the Settings form, otherwise the default.
	if frappe.conf.get("erpnext_debug_ttl"):
		return int(frappe.conf.get("erpnext_debug_ttl"))
	hours = _settings().get("ttl_hours")
	return int(hours) * 3600 if hours else DEFAULT_TTL_SECONDS


def max_traces() -> int:
	if frappe.conf.get("erpnext_debug_max_traces"):
		return int(frappe.conf.get("erpnext_debug_max_traces"))
	return int(_settings().get("max_traces") or DEFAULT_MAX_TRACES)


def save_trace(trace: dict) -> None:
	c = cache()
	c.set_value(TRACE_KEY.format(id=trace["id"]), trace, expires_in_sec=ttl_seconds())
	index = c.make_key(INDEX_KEY)
	c.lpush(index, trace["id"])
	c.ltrim(index, 0, max_traces() - 1)
	c.expire(index, ttl_seconds())


def get_trace(trace_id: str) -> dict | None:
	return cache().get_value(TRACE_KEY.format(id=trace_id))


def list_trace_ids(limit: int = 100) -> list[str]:
	c = cache()
	ids = c.lrange(c.make_key(INDEX_KEY), 0, max(limit - 1, 0))
	return [i.decode() if isinstance(i, bytes) else i for i in ids]


def clear() -> None:
	cache().delete_keys("erpnext_debug:")
