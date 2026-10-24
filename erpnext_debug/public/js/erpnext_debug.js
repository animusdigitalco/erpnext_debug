/* ERPNext Debug: on-screen tracer for Frappe / ERPNext.
 *
 * Server side: every request that fires document events comes back with a
 * trace ID header; the panel fetches that trace and shows the hook chain.
 *
 * Browser side: form event handlers (frappe.ui.form.on) are wrapped so each
 * run is timed and attributed to its app file or Client Script record, JS
 * errors are captured, and both are stitched onto the matching server trace.
 *
 * The same file runs in the Desk (app_include_js) and on portal pages
 * (web_include_js); the Desk-only APIs are guarded.
 */

frappe.provide("erpnext_debug");

(function () {
	const HEADER = "X-ERPNext-Debug-Trace";
	const STORAGE_KEY = "erpnext_debug:panel";
	const MAX_ROWS = 200;
	const CLIENT_BUFFER_MAX = 400;
	const CLIENT_BUFFER_MS = 20000;
	const FRAMEWORK_KINDS = new Set(["notifications", "webhooks", "server_scripts"]);
	const BLOCKING_EVENTS = new Set(["validate", "before_save", "before_submit", "before_cancel", "before_insert"]);
	const KIND_LABELS = {
		controller: "controller",
		doc_event: "hook",
		server_script: "server script",
		notifications: "notifications",
		webhooks: "webhooks",
		server_scripts: "server scripts",
		client: "browser",
		js_error: "js error",
	};

	const IS_DESK = !!(window.frappe && frappe.ui && frappe.ui.form && frappe.ui.form.on);
	const T = typeof window.__ === "function" ? window.__ : (s, args) => format(s, args);

	/* ------------------------------------------------------------------ */
	/* Small helpers that work in both Desk and portal                     */
	/* ------------------------------------------------------------------ */

	function format(s, args) {
		return String(s).replace(/\{(\d+)\}/g, (m, i) => (args && args[i] != null ? args[i] : m));
	}

	function esc(s) {
		return String(s == null ? "" : s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

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
		return cmd.split(".").slice(-2).join(".");
	}

	function slug(s) {
		return String(s || "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-");
	}

	function scrub(s) {
		return String(s || "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_");
	}

	function uid() {
		return "local-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
	}

	function get_cookie(name) {
		const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
		return m ? decodeURIComponent(m[1]) : null;
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

	function api(method, args) {
		return new Promise((resolve, reject) => {
			frappe.call({
				method: `erpnext_debug.tracer.api.${method}`,
				args: args || {},
				type: "POST",
				callback: (r) => resolve(r && r.message),
				error: (r) => reject(r),
				freeze: false,
			});
		});
	}

	function alert(message, indicator) {
		if (frappe.show_alert) frappe.show_alert({ message, indicator: indicator || "blue" });
		else console.info("[erpnext_debug]", message);
	}

	function go(route, form) {
		if (IS_DESK && frappe.set_route) {
			form ? frappe.set_route("Form", route, form) : frappe.set_route(route);
		} else {
			const url = form ? `/app/${slug(route)}/${encodeURIComponent(form)}` : `/app/${route}`;
			window.open(url, "_blank");
		}
	}

	/* ------------------------------------------------------------------ */
	/* Source attribution: which app file or Client Script a handler is in */
	/* ------------------------------------------------------------------ */

	// Frappe evaluates doctype form scripts as one blob tagged
	// "//# sourceURL=<doctype>__js" with "/* Adding apps/<app>/... */" markers
	// between files, and Client Script records as "<doctype>__custom_js" with
	// "// <Client Script name>" markers. A stack line number into either blob
	// can be mapped back to the file or record it came from.

	const marker_cache = {};
	const scrub_to_doctype = {};

	function markers_for(source_url) {
		if (marker_cache[source_url]) return marker_cache[source_url];
		const m = source_url.match(/^(.*)__(custom_)?js$/);
		if (!m) return null;
		const doctype = scrub_to_doctype[m[1]];
		if (!doctype || !frappe.get_meta) return null;
		const meta = frappe.get_meta(doctype);
		if (!meta) return null;
		const text = m[2] ? meta.__custom_js : meta.__js;
		if (!text) return null;

		const markers = [];
		const lines = text.split("\n");
		lines.forEach((line, i) => {
			let mm = line.match(/^\/\* Adding apps\/([^/]+)\/(.*) \*\/$/);
			if (mm) {
				markers.push({ line: i + 1, app: mm[1], label: mm[2].split("/").pop(), file: mm[2], kind: "file" });
				return;
			}
			if (m[2]) {
				mm = line.match(/^\/\/ (.+)$/);
				if (mm && !/^#/.test(mm[1]) && lines[i + 1] !== undefined) {
					markers.push({ line: i + 1, app: "Client Script", label: mm[1].trim(), record: mm[1].trim(), kind: "client_script" });
				}
			}
		});
		marker_cache[source_url] = markers;
		return markers;
	}

	function resolve_source(stack) {
		const lines = String(stack || "").split("\n");
		for (const line of lines) {
			if (line.indexOf("erpnext_debug") !== -1) continue;
			let m = line.match(/([a-z0-9_]+__(?:custom_)?js):(\d+):\d+/);
			if (m) {
				const markers = markers_for(m[1]);
				// new Function() wraps the body in two extra lines.
				const ln = parseInt(m[2], 10) - 2;
				if (markers && markers.length) {
					let hit = null;
					for (const mk of markers) {
						if (mk.line <= ln) hit = mk;
						else break;
					}
					if (hit) return Object.assign({ source_url: m[1] }, hit);
				}
				return {
					app: /custom_js$/.test(m[1]) ? "Client Script" : "form script",
					label: m[1],
					kind: /custom_js$/.test(m[1]) ? "client_script" : "file",
				};
			}
			m = line.match(/\/assets\/([a-z0-9_]+)\/(?:dist\/)?(?:js\/)?([^\s:)]+)/);
			if (m) {
				return { app: m[1], label: m[2].split("/").pop(), file: m[2], kind: "file" };
			}
		}
		return { app: "browser", label: "unknown source", kind: "unknown" };
	}

	/* ------------------------------------------------------------------ */
	/* Client event capture                                                */
	/* ------------------------------------------------------------------ */

	const client_buffer = [];
	const listeners = [];

	function on_client_event(fn) {
		listeners.push(fn);
	}

	function emit(ev) {
		client_buffer.push(ev);
		const cutoff = Date.now() - CLIENT_BUFFER_MS;
		while (client_buffer.length > CLIENT_BUFFER_MAX || (client_buffer.length && client_buffer[0].started_ms < cutoff && client_buffer[0].attached)) {
			client_buffer.shift();
		}
		listeners.forEach((fn) => {
			try {
				fn(ev);
			} catch (e) {
				/* never let the debugger break the page */
			}
		});
	}

	function take_client_events(doctype, name) {
		const cutoff = Date.now() - CLIENT_BUFFER_MS;
		const out = [];
		client_buffer.forEach((ev) => {
			if (ev.attached || ev.kind !== "client" || ev.started_ms < cutoff) return;
			if (ev.form_doctype !== doctype) return;
			if (ev.form_name !== name && !/^new-/.test(ev.form_name || "")) return;
			ev.attached = true;
			out.push(ev);
		});
		return out;
	}

	function wrap_form_on() {
		if (!IS_DESK || frappe.ui.form.__edbg_wrapped) return;
		const original = frappe.ui.form.on;

		const wrap = (doctype, event, fn, source) => {
			if (typeof fn !== "function") return fn;
			const wrapped = function (frm, cdt, cdn) {
				const args = arguments;
				const ev = {
					id: uid(),
					kind: "client",
					event,
					doctype,
					form_doctype: frm && frm.doctype,
					form_name: frm && frm.docname,
					cdt,
					cdn,
					source,
					app: source.app,
					label: source.label,
					started_at: new Date().toISOString(),
					started_ms: Date.now(),
					duration_ms: null,
					ok: true,
					blocked: false,
					error: null,
					stack: null,
					attached: false,
				};
				const validated_before = window.frappe && frappe.validated;
				const t0 = performance.now();
				const finish = (err) => {
					ev.duration_ms = performance.now() - t0;
					if (err) {
						ev.ok = false;
						ev.error = String((err && err.message) || err);
						ev.stack = err && err.stack ? String(err.stack) : null;
					}
					if (
						BLOCKING_EVENTS.has(event) &&
						validated_before !== false &&
						window.frappe &&
						frappe.validated === false
					) {
						ev.blocked = true;
					}
					emit(ev);
				};
				let result;
				try {
					result = fn.apply(this, args);
				} catch (e) {
					finish(e);
					throw e;
				}
				if (result && typeof result.then === "function") {
					return result.then(
						(r) => {
							finish();
							return r;
						},
						(e) => {
							finish(e);
							throw e;
						}
					);
				}
				finish();
				return result;
			};
			wrapped.__edbg_original = fn;
			return wrapped;
		};

		frappe.ui.form.on = frappe.ui.form.on_change = function (doctype, fieldname, handler) {
			scrub_to_doctype[scrub(doctype)] = doctype;
			let source;
			try {
				source = resolve_source(new Error().stack);
			} catch (e) {
				source = { app: "browser", label: "unknown source", kind: "unknown" };
			}
			if (!handler && fieldname && typeof fieldname === "object") {
				const obj = {};
				Object.keys(fieldname).forEach((key) => {
					obj[key] = wrap(doctype, key, fieldname[key], source);
				});
				return original.call(this, doctype, obj);
			}
			return original.call(this, doctype, fieldname, wrap(doctype, fieldname, handler, source));
		};
		frappe.ui.form.__edbg_wrapped = true;
	}

	let errors_installed = false;
	const recent_errors = new Map();

	function install_error_capture() {
		if (errors_installed) return;
		errors_installed = true;

		const record = (message, stack, file, line) => {
			const key = message + "|" + (file || "") + "|" + (line || "");
			const now = Date.now();
			if (recent_errors.get(key) > now - 1000) return;
			recent_errors.set(key, now);
			if (/erpnext_debug\.js/.test(file || "") || /erpnext_debug\.js/.test(stack || "")) return;
			let source;
			try {
				source = resolve_source(stack || (file ? `at ${file}:${line || 0}:0` : ""));
			} catch (e) {
				source = { app: "browser", label: file || "unknown source", kind: "unknown" };
			}
			emit({
				id: uid(),
				kind: "js_error",
				app: source.app,
				label: source.label,
				source,
				error: message,
				stack: stack || null,
				started_at: new Date().toISOString(),
				started_ms: now,
				ok: false,
				attached: false,
				route: location.pathname + location.hash,
			});
		};

		window.addEventListener("error", (e) => {
			if (!e) return;
			if (e.target && e.target !== window && !(e.error || e.message)) return; // resource load errors
			const err = e.error;
			record(
				(err && err.message) || e.message || "Script error",
				err && err.stack,
				e.filename,
				e.lineno
			);
		});
		window.addEventListener("unhandledrejection", (e) => {
			const r = e && e.reason;
			// frappe.call rejections carry the xhr; those are already server traces.
			if (r && typeof r === "object" && ("responseJSON" in r || "status" in r)) return;
			if (r && r.message === undefined && typeof r !== "string") return;
			record("Unhandled promise rejection: " + ((r && r.message) || String(r)), r && r.stack);
		});
	}

	/* ------------------------------------------------------------------ */
	/* TraceView: list of traces plus expandable timelines                 */
	/* ------------------------------------------------------------------ */

	erpnext_debug.TraceView = class TraceView {
		constructor({ parent, errors_only = false, on_count } = {}) {
			this.parent = $(parent);
			this.errors_only = errors_only;
			this.on_count = on_count;
			this.traces = new Map(); // id -> summary, full trace, or local row
			this.open = new Set();
			this.$list = $('<div class="edbg-list"></div>').appendTo(this.parent);
			this.$empty = $('<div class="edbg-empty"></div>').appendTo(this.parent);
			this.bind();
			this.render();
		}

		bind() {
			this.$list.on("click", ".edbg-row-head", (e) => this.toggle($(e.currentTarget).closest(".edbg-row").data("id")));
			this.$list.on("click", ".edbg-tb-toggle", (e) => {
				e.stopPropagation();
				$(e.currentTarget).closest(".edbg-step, .edbg-local").find(".edbg-tb").first().toggleClass("hidden");
			});
			this.$list.on("click", ".edbg-open-doc", (e) => {
				e.stopPropagation();
				const $r = $(e.currentTarget);
				go($r.data("doctype"), $r.data("name"));
			});
			this.$list.on("click", ".edbg-open-record", (e) => {
				e.stopPropagation();
				const $r = $(e.currentTarget);
				go($r.data("doctype"), $r.data("name"));
			});
		}

		ordered() {
			return Array.from(this.traces.values())
				.sort((a, b) => (b.started_ms || 0) - (a.started_ms || 0))
				.map((t) => t.id);
		}

		prune() {
			const ids = this.ordered();
			ids.slice(MAX_ROWS).forEach((id) => {
				this.traces.delete(id);
				this.open.delete(id);
			});
		}

		put(trace) {
			if (!trace.started_ms) trace.started_ms = Date.parse(trace.started_at) || Date.now();
			if (!trace.methods && trace.events) {
				trace.methods = trace.events.filter((ev) => ev.depth === 0).map((ev) => ev.method);
			}
			this.traces.set(trace.id, trace);
		}

		async refresh() {
			let rows = [];
			try {
				rows = (await api("list_traces", { limit: MAX_ROWS, errors_only: 0 })) || [];
			} catch (e) {
				/* not allowed or offline; keep local rows */
			}
			for (const [id, t] of Array.from(this.traces.entries())) {
				if (!t.local) this.traces.delete(id);
			}
			rows.forEach((t) => this.put(t));
			this.prune();
			this.render();
		}

		async add(trace_id) {
			if (this.traces.has(trace_id)) return this.traces.get(trace_id);
			let trace;
			try {
				trace = await api("get_trace", { trace_id });
			} catch (e) {
				return null;
			}
			if (!trace) return null;
			if (trace.doc) trace.client_events = take_client_events(trace.doc.doctype, trace.doc.name);
			this.put(trace);
			this.prune();
			this.render();
			return trace;
		}

		add_local(ev) {
			const row = Object.assign({}, ev, { local: true, started_ms: ev.started_ms || Date.now() });
			if (!row.id) row.id = uid();
			this.put(row);
			this.prune();
			this.render();
			return row;
		}

		async clear() {
			try {
				await api("clear_traces");
			} catch (e) {
				/* ignore */
			}
			this.traces.clear();
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
			if (!trace.local && !trace.events) {
				try {
					trace = await api("get_trace", { trace_id: id });
					this.put(trace);
				} catch (e) {
					this.open.delete(id);
					alert(T("Trace expired"), "orange");
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
			this.traces.forEach((t) => {
				if (!t.ok) errors++;
			});
			return { total: this.traces.size, errors };
		}

		render() {
			const visible = this.ordered().filter((id) => !this.errors_only || !this.traces.get(id).ok);
			this.$list.empty();
			visible.forEach((id) => this.$list.append(this.row_html(this.traces.get(id))));
			this.$empty.toggle(visible.length === 0);
			this.$empty.text(
				this.errors_only
					? T("No errors recorded. Save something that fails and it will show up here.")
					: T("No traces yet. Save a document and its hook chain will appear here.")
			);
			this.on_count && this.on_count(this.counts());
		}

		render_row(id) {
			const $old = this.$list.find(`.edbg-row[data-id="${id}"]`);
			if (!$old.length) return this.render();
			$old.replaceWith(this.row_html(this.traces.get(id)));
		}

		row_html(t) {
			if (t.local) return this.local_row_html(t);
			const open = this.open.has(t.id);
			const status = t.ok ? "ok" : "err";
			let title;
			if (t.doc) {
				title = `<span class="edbg-doctype">${esc(t.doc.doctype)}</span> <span class="edbg-docname">${esc(t.doc.name)}</span>`;
			} else {
				title = `<span class="edbg-doctype">${esc(short_cmd(t.cmd) || t.path)}</span>`;
			}
			const client_count = (t.client_events || []).length;
			const methods = (t.methods || []).length
				? `<span class="edbg-methods">${client_count ? '<span class="edbg-muted">browser → </span>' : ""}${t.methods.map(esc).join(" → ")}</span>`
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

		local_row_html(t) {
			const open = this.open.has(t.id);
			const status = t.ok && !t.blocked ? "ok" : t.blocked && t.ok ? "warn" : "err";
			let title, methods, error;
			if (t.kind === "js_error") {
				title = `<span class="edbg-doctype">${T("JS error")}</span> <span class="edbg-docname">${esc(t.label)}</span>`;
				methods = `<span class="edbg-methods edbg-muted">${esc(t.route || "")}</span>`;
				error = t.error;
			} else {
				title = `<span class="edbg-doctype">${esc(t.form_doctype || t.doctype)}</span> <span class="edbg-docname">${esc(t.form_name || "")}</span>`;
				methods = `<span class="edbg-methods"><span class="edbg-muted">browser </span>${esc(t.event)}</span>`;
				error = t.blocked && !t.error ? T("Save blocked: handler set frappe.validated = false") : t.error;
			}
			const badge = '<span class="edbg-badge edbg-badge-browser">browser</span>';
			return $(`
				<div class="edbg-row edbg-local edbg-${status} ${open ? "edbg-open" : ""}" data-id="${esc(t.id)}">
					<div class="edbg-row-head">
						<span class="edbg-dot"></span>
						<span class="edbg-time">${esc(fmt_time(t.started_at))}</span>
						<span class="edbg-title">${title} ${badge}</span>
						${methods}
						<span class="edbg-dur">${esc(fmt_ms(t.duration_ms))}</span>
						<span class="edbg-chevron">${open ? "▾" : "▸"}</span>
					</div>
					${error ? `<div class="edbg-row-error">${esc(error)}</div>` : ""}
					${open ? `<div class="edbg-detail">${this.client_event_html(t, true)}</div>` : ""}
				</div>
			`);
		}

		detail_html(t) {
			const meta = [
				t.user ? `<span>${esc(t.user)}</span>` : "",
				t.cmd ? `<span class="edbg-mono">${esc(t.cmd)}</span>` : "",
				t.status_code ? `<span>HTTP ${esc(t.status_code)}</span>` : "",
				t.doc
					? `<a class="edbg-open-doc" data-doctype="${esc(t.doc.doctype)}" data-name="${esc(t.doc.name)}">${T("Open form")}</a>`
					: "",
			]
				.filter(Boolean)
				.join('<span class="edbg-sep">·</span>');

			let client = "";
			if ((t.client_events || []).length) {
				client = `<div class="edbg-section-title">${T("Browser")}</div>
					<div class="edbg-client-events">${t.client_events.map((ev) => this.client_event_html(ev)).join("")}</div>
					<div class="edbg-section-title">${T("Server")}</div>`;
			}

			const events = (t.events || []).map((ev) => this.event_html(ev)).join("");
			const truncated = t.truncated
				? `<div class="edbg-muted edbg-note">${T("Trace truncated after {0} events", [t.event_count])}</div>`
				: "";
			return `<div class="edbg-detail"><div class="edbg-meta">${meta}</div>${client}${events}${truncated}</div>`;
		}

		client_event_html(ev, standalone) {
			const status = ev.ok && !ev.blocked ? "ok" : ev.blocked && ev.ok ? "warn" : "err";
			const src = ev.source || {};
			let where;
			if (src.kind === "client_script" && src.record) {
				where = `<a class="edbg-open-record" data-doctype="Client Script" data-name="${esc(src.record)}">${esc(src.record)}</a>`;
			} else {
				where = `<span class="edbg-mono" title="${esc(src.file || "")}">${esc(ev.label || "")}</span>`;
			}
			const tb = ev.stack
				? `<a class="edbg-tb-toggle">${T("stack")}</a><pre class="edbg-tb hidden">${esc(ev.stack)}</pre>`
				: "";
			const blocked = ev.blocked ? `<span class="edbg-badge edbg-badge-warn">frappe.validated = false</span>` : "";
			const err = !ev.ok ? `<div class="edbg-step-error">${esc(ev.error || "")} ${tb}</div>` : tb ? `<div class="edbg-step-error">${tb}</div>` : "";
			const label = ev.kind === "js_error" ? T("uncaught") : esc(ev.event || "");
			const doc = standalone && ev.cdt && ev.cdt !== ev.form_doctype
				? `<span class="edbg-muted">${esc(ev.cdt)} ${esc(ev.cdn || "")}</span>`
				: "";
			return `
				<div class="edbg-step edbg-${status}" data-kind="${esc(ev.kind)}">
					<span class="edbg-step-kind">${esc(KIND_LABELS[ev.kind] || ev.kind)}</span>
					<span class="edbg-app edbg-app-${esc(slug(ev.app))}">${esc(ev.app)}</span>
					<span class="edbg-step-label"><b>${label}</b> <span class="edbg-muted">in</span> ${where} ${doc} ${blocked}</span>
					<span class="edbg-dur">${esc(fmt_ms(ev.duration_ms))}</span>
					${err}
				</div>`;
		}

		event_html(ev) {
			const status = ev.ok ? "ok" : "err";
			const steps = ev.steps || [];
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
				step_html = `<div class="edbg-step edbg-step-quiet"><span class="edbg-step-label edbg-muted">${T("no handlers")}</span></div>`;
			}
			const err = !ev.ok && !steps.some((s) => !s.ok) ? `<div class="edbg-step-error">${esc(ev.error || "")}</div>` : "";
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
				? `<a class="edbg-tb-toggle">${T("traceback")}</a><pre class="edbg-tb hidden">${esc(s.traceback)}</pre>`
				: "";
			const err = !s.ok
				? `<div class="edbg-step-error">${esc(s.exc_type ? s.exc_type + ": " : "")}${esc(s.error || "")} ${tb}</div>`
				: "";
			const label =
				s.kind === "server_script"
					? `<a class="edbg-open-record" data-doctype="Server Script" data-name="${esc(s.label)}">${esc(s.label)}</a>`
					: `<span class="edbg-mono" title="${esc(s.label)}">${esc(s.label)}</span>`;
			return `
				<div class="edbg-step edbg-${status}" data-kind="${esc(s.kind)}">
					<span class="edbg-step-kind">${esc(kind)}</span>
					<span class="edbg-app edbg-app-${esc(slug(s.app))}">${esc(s.app)}</span>
					<span class="edbg-step-label">${label}</span>
					<span class="edbg-dur">${esc(fmt_ms(s.duration_ms))}</span>
					${err}
				</div>`;
		}
	};

	/* ------------------------------------------------------------------ */
	/* Panel: the floating overlay                                         */
	/* ------------------------------------------------------------------ */

	erpnext_debug.Panel = class Panel {
		constructor({ mode = "desk", boot = {} } = {}) {
			this.mode = mode;
			this.state = Object.assign(
				{
					open: false,
					height: 320,
					errors_only: false,
					auto_open: boot.open_on_error !== false,
					paused: false,
				},
				load_state()
			);
			this.seen = new Set();
			this.make();
			this.bind();
			this.apply_state();
			this.view.refresh();
			this.hook_requests();
			on_client_event((ev) => this.on_client_event(ev));
		}

		make() {
			this.$pill = $(`
				<button class="edbg-pill" title="${T("ERPNext Debug (Ctrl+Shift+D)")}">
					<span class="edbg-pill-dot"></span>
					<span class="edbg-pill-label">Debug</span>
					<span class="edbg-pill-count">0</span>
				</button>`).appendTo(document.body);

			this.$panel = $(`
				<div class="edbg-panel edbg-mode-${this.mode}">
					<div class="edbg-resize"></div>
					<div class="edbg-head">
						<span class="edbg-head-title">ERPNext Debug${this.mode === "web" ? ` <span class="edbg-badge">${T("portal")}</span>` : ""}</span>
						<span class="edbg-head-counts"></span>
						<span class="edbg-head-spacer"></span>
						<label class="edbg-toggle"><input type="checkbox" data-opt="errors_only"> ${T("Errors only")}</label>
						<label class="edbg-toggle"><input type="checkbox" data-opt="auto_open"> ${T("Open on error")}</label>
						<label class="edbg-toggle"><input type="checkbox" data-opt="paused"> ${T("Pause")}</label>
						<button class="edbg-btn" data-action="settings" title="${T("Settings")}">⚙</button>
						<button class="edbg-btn" data-action="page" title="${T("Open full page")}">⤢</button>
						<button class="edbg-btn" data-action="refresh" title="${T("Reload")}">↻</button>
						<button class="edbg-btn" data-action="clear" title="${T("Clear all traces")}">${T("Clear")}</button>
						<button class="edbg-btn edbg-close" data-action="close" title="${T("Close (Esc)")}">✕</button>
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
				if (action === "page") go("debug-traces");
				if (action === "settings") go("ERPNext Debug Settings", "ERPNext Debug Settings");
			});
			this.$panel.on("change", "input[data-opt]", (e) => {
				const opt = $(e.currentTarget).data("opt");
				this.state[opt] = e.currentTarget.checked;
				if (opt === "errors_only") this.view.set_errors_only(this.state.errors_only);
				save_state(this.state);
			});

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
				.text(c.errors ? T("{0} traces, {1} failed", [c.total, c.errors]) : T("{0} traces", [c.total]));
		}

		flash_and_open(id) {
			this.$pill.addClass("edbg-flash");
			setTimeout(() => this.$pill.removeClass("edbg-flash"), 1200);
			if (this.state.auto_open) {
				this.open();
				this.view.expand(id);
			}
		}

		async on_trace(trace_id, failed) {
			if (this.state.paused || this.seen.has(trace_id)) return;
			this.seen.add(trace_id);
			const trace = await this.view.add(trace_id);
			if (!trace) return;
			if (!trace.ok || failed) this.flash_and_open(trace.id);
		}

		on_client_event(ev) {
			if (this.state.paused) return;
			// Passing handlers stay in the buffer and get stitched onto the server
			// trace for the save. Only failures and blocked saves earn their own row.
			if (ev.ok && !ev.blocked) return;
			ev.attached = true;
			const row = this.view.add_local(ev);
			this.flash_and_open(row.id);
		}

		hook_requests() {
			$(document).ajaxComplete((event, xhr) => {
				let id = null;
				try {
					id = xhr.getResponseHeader(HEADER);
				} catch (e) {
					return;
				}
				if (id) this.on_trace(id, xhr.status >= 400);
			});

			const original_fetch = window.fetch;
			if (typeof original_fetch === "function" && !original_fetch.__edbg) {
				const wrapped = (...args) =>
					original_fetch.apply(window, args).then((res) => {
						try {
							const id = res.headers && res.headers.get(HEADER);
							if (id) this.on_trace(id, !res.ok);
						} catch (e) {
							/* opaque response */
						}
						return res;
					});
				wrapped.__edbg = true;
				window.fetch = wrapped;
			}
		}
	};

	/* ------------------------------------------------------------------ */
	/* Boot                                                                */
	/* ------------------------------------------------------------------ */

	if (IS_DESK) {
		// Wrap immediately so handlers registered by other app bundles are seen.
		wrap_form_on();
		$(document).on("app_ready", () => {
			const boot = (frappe.boot && frappe.boot.erpnext_debug) || null;
			if (!boot || !boot.enabled) return;
			if (frappe.user && frappe.user.has_role && !frappe.user.has_role("System Manager")) return;
			if (erpnext_debug.panel) return;
			install_error_capture();
			erpnext_debug.panel = new erpnext_debug.Panel({ mode: "desk", boot });
		});
	} else {
		// Portal / website pages. Only bother the server for logged-in users.
		const user = get_cookie("user_id");
		if (user && user !== "Guest" && window.frappe && typeof frappe.call === "function") {
			const start = () => {
				api("portal_status")
					.then((s) => {
						if (!s || !s.enabled || !s.allowed || erpnext_debug.panel) return;
						install_error_capture();
						erpnext_debug.panel = new erpnext_debug.Panel({ mode: "web", boot: s });
					})
					.catch(() => {});
			};
			if (typeof frappe.ready === "function") frappe.ready(start);
			else $(start);
		}
	}
})();
