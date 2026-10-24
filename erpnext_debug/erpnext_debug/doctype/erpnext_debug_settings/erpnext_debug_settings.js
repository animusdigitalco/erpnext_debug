frappe.ui.form.on("ERPNext Debug Settings", {
	refresh(frm) {
		frm.add_custom_button(__("Open Debug Traces"), () => frappe.set_route("debug-traces"));
		frm.add_custom_button(__("Clear all traces"), () => {
			frappe.confirm(__("Delete all recorded traces?"), () =>
				frappe.xcall("erpnext_debug.tracer.api.clear_traces").then(() =>
					frappe.show_alert({ message: __("Traces cleared"), indicator: "green" })
				)
			);
		});
	},
	after_save() {
		frappe.show_alert({
			message: __("Saved. Reload the page for the Debug panel to pick up the change."),
			indicator: "blue",
		});
	},
});
