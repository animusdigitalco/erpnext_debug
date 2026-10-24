/* ERPNext Debug: on-screen hook tracer.
 *
 * Watches every request the Desk makes. When the server attaches a trace ID
 * header, the panel fetches that trace and shows the hook chain next to the
 * form that caused it. Failed saves pop the panel open; passing saves add a
 * quiet row. Close it, filter it, clear it, pause it. Ctrl+Shift+D toggles.
 */

frappe.provide("erpnext_debug");

(function () {
	const HEADER = "X-ERPNext-Debug-Trace";
	const STORAGE_KEY = "erpnext_debug:panel";
	const MAX_ROWS = 200;
	const FRAMEWORK_KINDS = new Set(["notifications", "webhooks", "server_scripts"]);
	const KIND_LABELS = {
		controller: "controller",
		doc_event: "hook",
		server_script: "server script",
		notifications: "notifications",
		webhooks: "webhooks",
		server_scripts: "server scripts",
	};

	const esc = (s) => frappe.utils.escape_html(s == null ? "" : String(s));

	function fmt_ms(ms) {
		if (ms == null) return "";
		if (ms < 1) return "<1 ms";
		if (ms < 1000) return `${Math.round(ms)} ms`;
		return `${(ms / 1000).toFixed(2)} s`;
	}

	function fmt_time(iso) {
		if (!iso) return "";
		const d = new Date(iso);
		if (isNaN(d)) return iso;
		return d.toLocaleTimeString([], { hour12: false });
	}

	function short_cmd(cmd) {
		if (!cmd) return "";
		const parts = cmd.split(".");
		return parts.slice(-2).join(".");
	}

	function load_state() {
		try {
			return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
		} catch (e) {
			return {};
		}
	}

	function save_state(state) {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		} catch (e) {
			/* private mode etc. */
		}
	}

	function call(method, args) {
		return frappe.xcall(`erpnext_debug.tracer.api.${method}`, args || {});
	}

	/* ------------------------------------------------------------------ */
	/* TraceView: the list of traces plus expandable timelines.           */
	/* Used by both the overlay panel and the Debug Traces page.          */
	/* ------------------------------------------------------------------ */

	erpnext_debug.TraceView = class TraceView {
		constructor({ parent, errors_only = false, on_count } = {}) {
			this.parent = $(parent);
			this.errors_only = errors_only;
			this.on_count = on_count;
			this.traces = new Map(); // id -> summary or full trace
			this.order = []; // newest first
			this.open = new Set();
			this.$list = $('<div class="edbg-list"></div>').appendTo(this.parent);
			this.$empty = $('<div class="edbg-empty"></div>').appendTo(this.parent);
			this.bind();
			this.render();
		}

		bind() {
			this.$list.on("click", ".edbg-row-head", (e) => {
				const id = $(e.currentTarget).closest(".edbg-row").data("id");
				this.toggle(id);
			});
			this.$list.on("click", ".edbg-tb-toggle", (e) => {
				e.stopPropagation();
				$(e.currentTarget).closest(".edbg-step").find(".edbg-tb").toggleClass("hidden");
			});
			this.$list.on("click", ".edbg-open-doc", (e) => {
				e.stopPropagation();
				const $r = $(e.currentTarget);
				frappe.set_route("Form", $r.data("doctype"), $r.data("name"));
			});
		}

		async refresh() {
			const rows = await call("list_traces", { limit: MAX_ROWS, errors_only: 0 });
			this.traces.clear();
			this.order = [];
			rows.forEach((t) => {
				this.traces.set(t.id, t);
				this.order.push(t.id);
			});
			this.render();
		}

		async add(trace_id) {
			if (this.traces.has(trace_id)) return this.traces.get(trace_id);
			let trace;
			try {
				trace = await call("get_trace", { trace_id });
			} catch (e) {
				return null;
			}
			if (!trace) return null;
			trace.methods = (trace.events || []).filter((ev) => ev.depth === 0).map((ev) => ev.method);
			this.traces.set(trace.id, trace);
			this.order.unshift(trace.id);
			if (this.order.length > MAX_ROWS) {
				const dropped = this.order.pop();
				this.traces.delete(dropped);
				this.open.delete(dropped);
			}
			this.render();
			return trace;
		}

		async clear() {
			await call("clear_traces");
			this.traces.clear();
			this.order = [];
			this.open.clear();
			this.render();
		}

		set_errors_only(flag) {
			this.errors_only = !!flag;
			this.render();
		}

		async toggle(id) {
			if (this.open.has(id)) {
				this.open.delete(id);
				this.render_row(id);
				return;
			}
			this.open.add(id);
			let trace = this.traces.get(id);
			if (!trace.events) {
				try {
					trace = await call("get_trace", { trace_id: id });
					trace.methods = (trace.events || []).filter((ev) => ev.depth === 0).map((ev) => ev.method);
					this.traces.set(id, trace);
				} catch (e) {
					this.open.delete(id);
					frappe.show_alert({ message: __("Trace expired"), indicator: "orange" });
					return;
				}
			}
			this.render_row(id);
		}

		expand(id) {
			if (!this.open.has(id)) this.toggle(id);
		}

		counts() {
			let errors = 0;
			this.order.forEach((id) => {
				if (!this.traces.get(id).ok) errors++;
			});
			return { total: this.order.length, errors };
		}

		render() {
			const visible = this.order.filter((id) => !this.errors_only || !this.traces.get(id).ok);
			this.$list.empty();
			visible.forEach((id) => this.$list.append(this.row_html(this.traces.get(id))));
			this.$empty.toggle(visible.length === 0);
			this.$empty.text(
				this.errors_only
					? __("No errors recorded. Save something that fails and it will show up here.")
					: __("No traces yet. Save a document and its hook chain will appear here.")
			);
			this.on_count && this.on_count(this.counts());
		}

		render_row(id) {
			const $old = this.$list.find(`.edbg-row[data-id="${id}"]`);
			if (!$old.length) return this.render();
			$old.replaceWith(this.row_html(this.traces.get(id)));
		}

		row_html(t) {
			const open = this.open.has(t.id);
			const status = t.ok ? "ok" : "err";
			let title;
			if (t.doc) {
				title = `<span class="edbg-doctype">${esc(t.doc.doctype)}</span> <span class="edbg-docname">${esc(t.doc.name)}</span>`;
			} else {
				title = `<span class="edbg-doctype">${esc(short_cmd(t.cmd) || t.path)}</span>`;
			}
			const methods = (t.methods || []).length
				? `<span class="edbg-methods">${t.methods.map(esc).join(" → ")}</span>`
				: `<span class="edbg-methods edbg-muted">${esc(short_cmd(t.cmd) || t.http_method || "")}</span>`;
			const err = !t.ok
				? `<div class="edbg-row-error">${esc(t.exc_type ? t.exc_type + ": " : "")}${esc(t.error || "")}</div>`
				: "";
			const kind = t.kind === "job" ? '<span class="edbg-badge edbg-badge-job">job</span>' : "";
			return $(`
				<div class="edbg-row edbg-${status} ${open ? "edbg-open" : ""}" data-id="${esc(t.id)}">
					<div class="edbg-row-head">
						<span class="edbg-dot"></span>
						<span class="edbg-time">${esc(fmt_time(t.started_at))}</span>
						<span class="edbg-title">${title} ${kind}</span>
						${methods}
						<span class="edbg-dur">${esc(fmt_ms(t.duration_ms))}</span>
						<span class="edbg-chevron">${open ? "▾" : "▸"}</span>
					</div>
					${err}
					${open ? this.detail_html(t) : ""}
				</div>
			`);
		}

		detail_html(t) {
			const meta = [
				t.user ? `<span>${esc(t.user)}</span>` : "",
				t.cmd ? `<span class="edbg-mono">${esc(t.cmd)}</span>` : "",
				t.status_code ? `<span>HTTP ${esc(t.status_code)}</span>` : "",
				t.doc
					? `<a class="edbg-open-doc" data-doctype="${esc(t.doc.doctype)}" data-name="${esc(t.doc.name)}">${__("Open form")}</a>`
					: "",
			]
				.filter(Boolean)
				.join('<span class="edbg-sep">·</span>');

			const events = (t.events || []).map((ev) => this.event_html(ev)).join("");
			const truncated = t.truncated
				? `<div class="edbg-muted edbg-note">${__("Trace truncated after {0} events", [t.event_count])}</div>`
				: "";
			return `<div class="edbg-detail"><div class="edbg-meta">${meta}</div>${events}${truncated}</div>`;
		}

		event_html(ev) {
			const status = ev.ok ? "ok" : "err";
			const steps = ev.steps || [];

			// Framework steps that did nothing get folded into one dim line.
			const quiet = steps.filter((s) => FRAMEWORK_KINDS.has(s.kind) && s.ok && (s.duration_ms || 0) < 2);
			const shown = steps.filter((s) => !quiet.includes(s));
			let step_html = shown.map((s) => this.step_html(s)).join("");
			if (quiet.length) {
				const total = quiet.reduce((a, s) => a + (s.duration_ms || 0), 0);
				step_html += `<div class="edbg-step edbg-step-quiet">
					<span class="edbg-step-kind">framework</span>
					<span class="edbg-step-label">${quiet.map((s) => KIND_LABELS[s.kind]).join(", ")}</span>
					<span class="edbg-dur">${esc(fmt_ms(total))}</span>
				</div>`;
			}
			if (!steps.length) {
				step_html = `<div class="edbg-step edbg-step-quiet"><span class="edbg-step-label edbg-muted">${__("no handlers")}</span></div>`;
			}

			const err = !ev.ok && !steps.some((s) => !s.ok)
				? `<div class="edbg-step-error">${esc(ev.error || "")}</div>`
				: "";

			return `
				<div class="edbg-event edbg-${status}" style="--edbg-depth:${ev.depth || 0}">
					<div class="edbg-event-head">
						<span class="edbg-dot"></span>
						<span class="edbg-event-method">${esc(ev.method)}</span>
						<span class="edbg-event-doc">${esc(ev.doctype)} <span class="edbg-muted">${esc(ev.name)}</span></span>
						<span class="edbg-dur">${esc(fmt_ms(ev.duration_ms))}</span>
					</div>
					${err}
					<div class="edbg-steps">${step_html}</div>
				</div>`;
		}

		step_html(s) {
			const status = s.ok ? "ok" : "err";
			const kind = KIND_LABELS[s.kind] || s.kind;
			const tb = s.traceback
				? `<a class="edbg-tb-toggle">${__("traceback")}</a><pre class="edbg-tb hidden">${esc(s.traceback)}</pre>`
				: "";
			const err = !s.ok
				? `<div class="edbg-step-error">${esc(s.exc_type ? s.exc_type + ": " : "")}${esc(s.error || "")} ${tb}</div>`
				: "";
			return `
				<div class="edbg-step edbg-${status}" data-kind="${esc(s.kind)}">
					<span class="edbg-step-kind">${esc(kind)}</span>
					<span class="edbg-app edbg-app-${esc(slug(s.app))}">${esc(s.app)}</span>
					<span class="edbg-step-label edbg-mono" title="${esc(s.label)}">${esc(s.label)}</span>
					<span class="edbg-dur">${esc(fmt_ms(s.duration_ms))}</span>
					${err}
				</div>`;
		}
	};

	function slug(s) {
		return String(s || "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-");
	}

	/* ------------------------------------------------------------------ */
	/* Panel: the floating overlay.                                       */
	/* ------------------------------------------------------------------ */

	erpnext_debug.Panel = class Panel {
		constructor() {
			this.state = Object.assign(
				{ open: false, height: 320, errors_only: false, auto_open: true, paused: false },
				load_state()
			);
			this.seen = new Set();
			this.make();
			this.bind();
			this.apply_state();
			this.view.refresh();
			this.hook_requests();
		}

		make() {
			this.$pill = $(`
				<button class="edbg-pill" title="${__("ERPNext Debug (Ctrl+Shift+D)")}">
					<span class="edbg-pill-dot"></span>
					<span class="edbg-pill-label">Debug</span>
					<span class="edbg-pill-count">0</span>
				</button>`).appendTo(document.body);

			this.$panel = $(`
				<div class="edbg-panel">
					<div class="edbg-resize"></div>
					<div class="edbg-head">
						<span class="edbg-head-title">ERPNext Debug</span>
						<span class="edbg-head-counts"></span>
						<span class="edbg-head-spacer"></span>
						<label class="edbg-toggle"><input type="checkbox" data-opt="errors_only"> ${__("Errors only")}</label>
						<label class="edbg-toggle"><input type="checkbox" data-opt="auto_open"> ${__("Open on error")}</label>
						<label class="edbg-toggle"><input type="checkbox" data-opt="paused"> ${__("Pause")}</label>
						<button class="edbg-btn" data-action="page" title="${__("Open full page")}">⤢</button>
						<button class="edbg-btn" data-action="refresh" title="${__("Reload")}">↻</button>
						<button class="edbg-btn" data-action="clear" title="${__("Clear all traces")}">${__("Clear")}</button>
						<button class="edbg-btn edbg-close" data-action="close" title="${__("Close (Esc)")}">✕</button>
					</div>
					<div class="edbg-body"></div>
				</div>`).appendTo(document.body);

			this.view = new erpnext_debug.TraceView({
				parent: this.$panel.find(".edbg-body"),
				errors_only: this.state.errors_only,
				on_count: (c) => this.update_counts(c),
			});
		}

		bind() {
			this.$pill.on("click", () => this.toggle());
			this.$panel.on("click", "[data-action]", (e) => {
				const action = $(e.currentTarget).data("action");
				if (action === "close") this.close();
				if (action === "clear") this.view.clear();
				if (action === "refresh") this.view.refresh();
				if (action === "page") frappe.set_route("debug-traces");
			});
			this.$panel.on("change", "input[data-opt]", (e) => {
				const opt = $(e.currentTarget).data("opt");
				this.state[opt] = e.currentTarget.checked;
				if (opt === "errors_only") this.view.set_errors_only(this.state.errors_only);
				save_state(this.state);
			});

			// Drag the top edge to resize.
			const $resize = this.$panel.find(".edbg-resize");
			$resize.on("mousedown", (e) => {
				e.preventDefault();
				const start_y = e.clientY;
				const start_h = this.$panel.outerHeight();
				const move = (ev) => {
					const h = Math.min(window.innerHeight - 60, Math.max(140, start_h + (start_y - ev.clientY)));
					this.state.height = h;
					this.$panel.css("height", h + "px");
				};
				const up = () => {
					$(document).off("mousemove", move).off("mouseup", up);
					save_state(this.state);
				};
				$(document).on("mousemove", move).on("mouseup", up);
			});

			$(document).on("keydown", (e) => {
				if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
					e.preventDefault();
					this.toggle();
				} else if (e.key === "Escape" && this.state.open && !$(".modal.show").length) {
					this.close();
				}
			});
		}

		apply_state() {
			this.$panel.css("height", this.state.height + "px");
			this.$panel.toggleClass("edbg-visible", !!this.state.open);
			this.$pill.toggleClass("edbg-hidden", !!this.state.open);
			this.$panel.find("input[data-opt]").each((i, el) => {
				el.checked = !!this.state[$(el).data("opt")];
			});
		}

		open() {
			this.state.open = true;
			save_state(this.state);
			this.apply_state();
		}

		close() {
			this.state.open = false;
			save_state(this.state);
			this.apply_state();
		}

		toggle() {
			this.state.open ? this.close() : this.open();
		}

		update_counts(c) {
			this.$pill.find(".edbg-pill-count").text(c.errors ? c.errors : c.total);
			this.$pill.toggleClass("edbg-has-errors", c.errors > 0);
			this.$panel
				.find(".edbg-head-counts")
				.text(c.errors ? __("{0} traces, {1} failed", [c.total, c.errors]) : __("{0} traces", [c.total]));
		}

		async on_trace(trace_id, failed) {
			if (this.state.paused || this.seen.has(trace_id)) return;
			this.seen.add(trace_id);
			const trace = await this.view.add(trace_id);
			if (!trace) return;
			if (!trace.ok || failed) {
				this.$pill.addClass("edbg-flash");
				setTimeout(() => this.$pill.removeClass("edbg-flash"), 1200);
				if (this.state.auto_open) {
					this.open();
					this.view.expand(trace.id);
				}
			}
		}

		hook_requests() {
			// jQuery: everything that goes through frappe.call / frappe.xcall.
			$(document).ajaxComplete((event, xhr) => {
				let id = null;
				try {
					id = xhr.getResponseHeader(HEADER);
				} catch (e) {
					return;
				}
				if (id) this.on_trace(id, xhr.status >= 400);
			});

			// fetch: anything newer that bypasses jQuery.
			const original_fetch = window.fetch;
			if (typeof original_fetch === "function") {
				window.fetch = (...args) =>
					original_fetch.apply(window, args).then((res) => {
						try {
							const id = res.headers && res.headers.get(HEADER);
							if (id) this.on_trace(id, !res.ok);
						} catch (e) {
							/* opaque response */
						}
						return res;
					});
			}
		}
	};

	/* ------------------------------------------------------------------ */

	$(document).on("app_ready", () => {
		const boot = (frappe.boot && frappe.boot.erpnext_debug) || null;
		if (!boot || !boot.enabled) return;
		if (!frappe.user.has_role("System Manager")) return;
		if (erpnext_debug.panel) return;
		erpnext_debug.panel = new erpnext_debug.Panel();
	});
})();
