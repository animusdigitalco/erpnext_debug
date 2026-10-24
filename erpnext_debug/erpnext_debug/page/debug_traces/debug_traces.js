frappe.pages["debug-traces"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Debug Traces"),
		single_column: true,
	});

	$(wrapper).addClass("edbg-page");

	const view = new erpnext_debug.TraceView({
		parent: page.body,
		on_count: (c) => {
			page.set_indicator(
				c.errors ? __("{0} failed", [c.errors]) : __("{0} traces", [c.total]),
				c.errors ? "red" : "green"
			);
		},
	});

	page.set_primary_action(__("Refresh"), () => view.refresh(), "refresh");
	page.set_secondary_action(__("Clear"), () => {
		frappe.confirm(__("Delete all recorded traces?"), () => view.clear());
	});

	const errors_only = page.add_field({
		fieldtype: "Check",
		label: __("Errors only"),
		fieldname: "errors_only",
		change: () => view.set_errors_only(errors_only.get_value()),
	});

	frappe.xcall("erpnext_debug.tracer.api.status").then((s) => {
		if (!s.enabled) {
			page.body.prepend(
				`<div class="alert alert-warning">${__(
					"Tracing is off. Turn it on in {0}. Existing traces are still shown until they expire.",
					[`<a href="/app/erpnext-debug-settings">${__("ERPNext Debug Settings")}</a>`]
				)}</div>`
			);
		}
	});

	view.refresh();
	wrapper.edbg_view = view;
};

frappe.pages["debug-traces"].on_page_show = function (wrapper) {
	wrapper.edbg_view && wrapper.edbg_view.refresh();
};
