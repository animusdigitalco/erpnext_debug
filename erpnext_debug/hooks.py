app_name = "erpnext_debug"
app_title = "ERPNext Debug"
app_publisher = "Animus Digital"
app_description = (
	"On-screen hook and server script tracer for Frappe / ERPNext developers. "
	"Install on staging and local benches only."
)
app_email = "hello@animusdigital.co"
app_license = "MIT"

# Loaded into every Desk page. The overlay only activates for System Managers
# and only when the server reports tracing as enabled (see boot_session).
app_include_js = "/assets/erpnext_debug/js/erpnext_debug.js"
app_include_css = "/assets/erpnext_debug/css/erpnext_debug.css"

# Tell the Desk whether tracing is on so the overlay knows to start.
boot_session = "erpnext_debug.tracer.core.boot_session"

# Per-request lifecycle. before_request also installs the runtime patches
# (idempotent per worker) so nothing in frappe core is edited.
before_request = ["erpnext_debug.tracer.core.before_request"]
after_request = ["erpnext_debug.tracer.core.after_request"]

# Background jobs get their own traces.
before_job = ["erpnext_debug.tracer.core.before_job"]
after_job = ["erpnext_debug.tracer.core.after_job"]
