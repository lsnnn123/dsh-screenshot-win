/**
 * dsh-screenshot-win — browser half.
 *
 * Registers two things into the Web GUI:
 *   * a camera button in the composer tool row (`conversation.input.left`) that
 *     captures a region / the whole screen / a chosen window through the node
 *     half's `/dsh-screenshot-win/capture` route and hands the picture to the composer
 *     through the shipped draft-attachment API (`ctx.conversation.createDrafts` +
 *     `inputActions.addAttachments`), so it arrives as a normal image the user sends;
 *   * an image row for the `screenshot` tool call (`tool.call.toolview` keyed by the
 *     tool name) so the model's own screenshots are visible in the conversation.
 *
 * The module only registers a lazy factory; every side effect happens in `apply`.
 * Styling uses host theme tokens (`--dsw-alias-*`) and no host Client package is
 * imported — only React, from the browser module table.
 */
window.__ModuleLoader__.load({
  id: "dsh-screenshot-win",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const NS = "dsh-screenshot-win";
    const CAPTURE_ROUTE = "/dsh-screenshot-win/capture";
    const WINDOWS_ROUTE = "/dsh-screenshot-win/windows";

    /** Fallback dictionary; the Client locale service wins when it is mounted. */
    const DICT = {
      zh: {
        "button.title": "截图：框选区域 / 整屏 / 指定窗口",
        "button.label": "截图",
        "menu.region": "框选区域",
        "menu.region.hint": "在屏幕上拖拽出矩形；直接点击某个窗口则截取该窗口",
        "menu.screen": "整个屏幕",
        "menu.screen.hint": "包含全部显示器的完整虚拟桌面",
        "menu.window": "指定某个窗口…",
        "menu.window.hint": "按窗口标题选择，即使窗口被遮挡也能截取",
        "menu.loading": "正在读取窗口…",
        "menu.back": "← 返回",
        "menu.empty": "没有可截取的窗口",
        "menu.untitled": "(无标题)",
        "menu.minimized": "已最小化",
        "status.busy": "截图中…（框选模式请在屏幕上拖拽）",
        "status.inserted": "已插入截图",
        "status.savedTo": "已保存到",
        "status.cancelled": "已取消截图",
        "status.failed": "截图失败：",
        "status.noComposer": "无法插入到输入框，截图已保存到",
        "status.listFailed": "读取窗口列表失败：",
      },
      en: {
        "button.title": "Screenshot: region / whole screen / a window",
        "button.label": "Screenshot",
        "menu.region": "Select a region",
        "menu.region.hint": "Drag a rectangle on screen; click a window to capture it",
        "menu.screen": "Whole screen",
        "menu.screen.hint": "The full virtual desktop across every monitor",
        "menu.window": "Pick a window…",
        "menu.window.hint": "Choose by title; works even when the window is covered",
        "menu.loading": "Reading windows…",
        "menu.back": "← Back",
        "menu.empty": "No capturable window",
        "menu.untitled": "(untitled)",
        "menu.minimized": "minimized",
        "status.busy": "Capturing… (drag on screen for region mode)",
        "status.inserted": "Inserted screenshot",
        "status.savedTo": "saved to",
        "status.cancelled": "Capture cancelled",
        "status.failed": "Capture failed: ",
        "status.noComposer": "Could not add it to the composer; saved to",
        "status.listFailed": "Could not read the window list: ",
      },
    };

    /** Host theme tokens (see the Client `Theme` inspection provider). */
    const T = {
      text: "var(--dsw-alias-label-primary)",
      subtle: "var(--dsw-alias-label-secondary)",
      surface: "var(--dsw-alias-bg-overlay)",
      hover: "var(--dsw-alias-bg-layer-2)",
      border: "var(--dsw-alias-border-l1)",
      error: "var(--dsw-alias-state-error-primary)",
      success: "var(--dsw-alias-state-success-primary)",
    };

    /** The plugin context, captured in `apply` for service lookups inside views. */
    let pluginCtx = null;
    /** The translator, replaced by the locale-bound one in `apply`. */
    let tr = (key) => (DICT.zh[key] ?? DICT.en[key] ?? key);

    /**
     * Map a locale tag onto one of the bundled dictionaries — `zh`, `zh-CN` and
     * `zh_Hans` all resolve to `zh`.
     * @param tag - a locale id from the locale service or the browser.
     * @returns the bundled language id, or undefined when neither dictionary covers it.
     */
    function bundledLanguage(tag) {
      if (typeof tag !== "string" || tag === "") return undefined;
      const base = tag.toLowerCase().replace(/_/g, "-").split("-")[0];
      return Object.prototype.hasOwnProperty.call(DICT, base) ? base : undefined;
    }

    /**
     * The browser's ordered language list — the same provisional source the shipped
     * locale service itself falls back to before an explicit preference exists.
     * @returns a bundled language id, or undefined.
     */
    function browserLanguage() {
      if (typeof navigator === "undefined") return undefined;
      const tags = Array.isArray(navigator.languages) && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language];
      for (const tag of tags) {
        const id = bundledLanguage(tag);
        if (id !== undefined) return id;
      }
      return undefined;
    }

    /**
     * Build the translate function for this plugin's namespace.
     *
     * The Client locale service is reached lazily, at call time rather than in
     * `apply`: a client plugin may be applied before the shipped locale plugin has
     * provided `ctx.locale`, and anything captured that early would pin the whole
     * session to one language. The bundled dictionaries remain the fallback, so the
     * menu always answers real text even with the service missing entirely.
     * @param ctx - the Client plugin context.
     * @returns a key-to-text function that always answers something readable.
     */
    function makeTranslator(ctx) {
      const ids = Object.keys(DICT);
      const registered = new Set();
      let bound = null;
      let language = browserLanguage() ?? "en";
      let ready = false;

      /** The locale service, however this context exposes it. */
      function localeService() {
        try {
          let locale = ctx === undefined || ctx === null ? undefined : ctx.locale;
          if (locale === undefined && typeof ctx?.get === "function") locale = ctx.get("locale");
          return locale ?? undefined;
        } catch {
          return undefined;
        }
      }

      /** Publish the dictionaries and bind the namespace once per module instance. */
      function connect(locale) {
        if (ready || locale === undefined) return;
        if (typeof locale.register === "function") {
          for (const id of ids) {
            if (registered.has(id)) continue;
            /* Marked before the call: a duplicate-owner throw is permanent, not transient. */
            registered.add(id);
            try {
              locale.register(NS, id, DICT[id]);
            } catch {
              /* a previous mount of this module already owns the namespace */
            }
          }
        }
        if (bound === null && typeof locale.bind === "function") {
          try {
            bound = locale.bind(NS);
          } catch {
            bound = null;
          }
        }
        ready = bound !== null && registered.size === ids.length;
      }

      return (key, params) => {
        try {
          const locale = localeService();
          connect(locale);
          /* Read on every call: the language can be switched while the page lives. */
          const snapshot = typeof locale?.getLocale === "function" ? locale.getLocale() : undefined;
          const active = snapshot === undefined || snapshot === null ? undefined : snapshot.active ?? snapshot.id;
          const id = bundledLanguage(active);
          if (id !== undefined) language = id;
        } catch {
          /* the bundled dictionaries below still serve every string */
        }
        if (bound !== null) {
          try {
            const value = bound(key, params);
            if (typeof value === "string" && value !== "" && value !== key) return value;
          } catch {
            /* fall through to the bundled dictionary */
          }
        }
        return DICT[language][key] ?? DICT.en[key] ?? key;
      };
    }

    /**
     * Absolute URL for one of this plugin's routes. The GUI is served over HTTP, but
     * the boot record is consulted first so the button also works when the shell
     * loads the page from another origin.
     * @param path - the route path.
     * @returns a URL the browser can fetch.
     */
    function routeUrl(path) {
      const boot = typeof window === "undefined" ? undefined : window.__DSH_BOOT__;
      const origin = typeof location !== "undefined" && typeof location.origin === "string" && location.origin.startsWith("http")
        ? location.origin
        : typeof boot === "object" && boot !== null && typeof boot.origin === "string" && boot.origin.startsWith("http")
          ? boot.origin
          : undefined;
      return origin === undefined ? path : `${origin.replace(/\/+$/, "")}${path}`;
    }

    /** The conversation service, when the mounted profile provides it. */
    function conversationService() {
      if (pluginCtx === null || typeof pluginCtx.get !== "function") return undefined;
      try {
        const service = pluginCtx.get("conversation");
        return service === undefined || service === null ? undefined : service;
      } catch {
        return undefined;
      }
    }

    /**
     * Hand one captured picture to the composer as a normal image draft.
     * @param file - the decoded image file.
     * @param sessionId - the session whose composer receives it.
     * @param inputActions - the composer's input actions from the slot props.
     * @returns null on success, otherwise a short reason key.
     */
    function insertDraft(file, sessionId, inputActions) {
      const conversation = conversationService();
      if (conversation === undefined || typeof conversation.createDrafts !== "function") return "conversation";
      if (inputActions === undefined || inputActions === null || typeof inputActions.addAttachments !== "function") return "inputActions";
      let drafts;
      try {
        drafts = conversation.createDrafts(sessionId, [file]);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      if (!Array.isArray(drafts) || drafts.length === 0) return "draft";
      if (inputActions.addAttachments(drafts.map((draft) => draft.id)) !== true) {
        try {
          conversation.releaseDraftAttachments(drafts);
        } catch {
          /* nothing else to undo */
        }
        return "rejected";
      }
      return null;
    }

    /**
     * Decode a `data:` URL into a File the composer accepts.
     * @param dataUrl - the base64 data URL returned by the host route.
     * @param fileName - name for the new file.
     * @param mediaType - its MIME type.
     * @returns the decoded file.
     */
    function dataUrlToFile(dataUrl, fileName, mediaType) {
      const comma = dataUrl.indexOf(",");
      const binary = atob(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new File([bytes], fileName, { type: mediaType });
    }

    const S = {
      anchor: { position: "relative", display: "inline-flex", alignItems: "center" },
      button: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        padding: 0,
        border: "none",
        borderRadius: 8,
        background: "transparent",
        color: T.subtle,
        cursor: "pointer",
      },
      menu: {
        position: "fixed",
        zIndex: 90,
        minWidth: 260,
        maxWidth: 440,
        padding: 6,
        borderRadius: 10,
        border: `1px solid ${T.border}`,
        background: T.surface,
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.28)",
        color: T.text,
        fontSize: 13,
        lineHeight: "18px",
        textAlign: "left",
      },
      item: {
        display: "block",
        width: "100%",
        padding: "7px 10px",
        border: "none",
        borderRadius: 7,
        background: "transparent",
        color: T.text,
        textAlign: "left",
        cursor: "pointer",
        fontSize: 13,
        font: "inherit",
      },
      itemDisabled: { cursor: "default", color: T.subtle },
      hint: { display: "block", color: T.subtle, fontSize: 11, marginTop: 1 },
      hintInline: { color: T.subtle, fontSize: 11, marginLeft: 6 },
      list: { maxHeight: 320, overflowY: "auto", marginTop: 4, borderTop: `1px solid ${T.border}`, paddingTop: 4 },
      rowTitle: {
        display: "inline-block",
        maxWidth: 320,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        verticalAlign: "bottom",
      },
      toast: {
        position: "fixed",
        zIndex: 90,
        maxWidth: 460,
        padding: "8px 12px",
        borderRadius: 9,
        border: `1px solid ${T.border}`,
        background: T.surface,
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.28)",
        color: T.text,
        fontSize: 12,
        wordBreak: "break-all",
      },
      caption: { fontSize: 12, color: T.subtle, wordBreak: "break-all" },
    };

    const CameraIcon = () =>
      h(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, focusable: false },
        h("path", {
          d: "M5.2 3.2 5.9 2h4.2l.7 1.2h2.1c.9 0 1.6.7 1.6 1.6v6.4c0 .9-.7 1.6-1.6 1.6H2.4c-.9 0-1.6-.7-1.6-1.6V4.8c0-.9.7-1.6 1.6-1.6h2.8Z",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinejoin: "round",
        }),
        h("circle", { cx: 8, cy: 8, r: 2.6, stroke: "currentColor", strokeWidth: 1.2 }),
      );

    //#region composer button

    /**
     * The composer camera button.
     * @param props - slot props, carrying the composer's input actions and session id.
     * @returns the button, its menu and its status toast.
     */
    function ScreenshotButton(props) {
      const inputActions = props === undefined ? undefined : props.inputActions;
      const sessionId = props === undefined ? undefined : props.sessionId;
      const [open, setOpen] = React.useState(false);
      const [anchor, setAnchor] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState(null);
      const [windows, setWindows] = React.useState(null);
      const [listing, setListing] = React.useState(false);
      const [hover, setHover] = React.useState(null);
      const buttonRef = React.useRef(null);

      React.useEffect(() => {
        if (status === null) return undefined;
        const timer = setTimeout(() => setStatus(null), 8000);
        return () => clearTimeout(timer);
      }, [status]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (buttonRef.current !== null && buttonRef.current.contains(target)) return;
          if (target instanceof Element && target.closest("[data-dsh-screenshot-win-menu]") !== null) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, [open]);

      const toggle = () => {
        const rect = buttonRef.current === null ? null : buttonRef.current.getBoundingClientRect();
        setAnchor(rect === null ? null : { left: Math.max(8, rect.left), bottom: Math.max(8, window.innerHeight - rect.top + 8) });
        setWindows(null);
        setHover(null);
        setOpen((value) => !value);
      };

      const run = async (request) => {
        setOpen(false);
        setBusy(true);
        setStatus({ kind: "busy", text: tr("status.busy") });
        try {
          const response = await fetch(routeUrl(CAPTURE_ROUTE), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...request, session_id: sessionId }),
          });
          const result = await response.json();
          if (result.ok !== true) {
            setStatus(result.cancelled === true
              ? { kind: "idle", text: tr("status.cancelled") }
              : { kind: "error", text: `${tr("status.failed")}${result.error ?? ""}` });
            return;
          }
          const file = dataUrlToFile(result.dataUrl, result.name || "screenshot.png", result.mediaType || "image/png");
          const failure = insertDraft(file, sessionId, inputActions);
          const saved = `${result.width}×${result.height} · ${tr("status.savedTo")} ${result.path}`;
          setStatus(failure === null
            ? { kind: "ok", text: `${tr("status.inserted")} · ${saved}` }
            : { kind: "error", text: `${failure === "conversation" || failure === "inputActions" || failure === "draft" || failure === "rejected" ? tr("status.noComposer") : `${tr("status.failed")}${failure}`} ${result.path}` });
        } catch (error) {
          setStatus({ kind: "error", text: `${tr("status.failed")}${error instanceof Error ? error.message : String(error)}` });
        } finally {
          setBusy(false);
        }
      };

      const loadWindows = async () => {
        setListing(true);
        try {
          const response = await fetch(routeUrl(WINDOWS_ROUTE), { cache: "no-store" });
          const result = await response.json();
          setWindows(Array.isArray(result.windows) ? result.windows : []);
        } catch (error) {
          setWindows([]);
          setStatus({ kind: "error", text: `${tr("status.listFailed")}${error instanceof Error ? error.message : String(error)}` });
        } finally {
          setListing(false);
        }
      };

      const itemStyle = (key, disabled = false) => ({
        ...S.item,
        ...(disabled ? S.itemDisabled : null),
        background: !disabled && hover === key ? T.hover : "transparent",
      });

      const entry = (key, label, hint, onClick, disabled = false, title) => h("button", {
        key,
        type: "button",
        style: itemStyle(key, disabled),
        disabled,
        title,
        onMouseEnter: () => setHover(key),
        onMouseLeave: () => setHover(null),
        onClick,
      }, label, hint === undefined ? null : h("span", { style: S.hint }, hint));

      const menu = () => {
        if (!open) return null;
        const pinned = {
          ...S.menu,
          left: anchor === null ? 12 : anchor.left,
          bottom: anchor === null ? 80 : anchor.bottom,
        };
        const items = [
          entry("region", tr("menu.region"), tr("menu.region.hint"), () => run({ mode: "region" })),
          entry("screen", tr("menu.screen"), tr("menu.screen.hint"), () => run({ mode: "screen" })),
        ];
        if (windows === null) {
          items.push(entry("window", listing ? tr("menu.loading") : tr("menu.window"), tr("menu.window.hint"), loadWindows, listing));
        } else {
          items.push(entry("back", tr("menu.back"), undefined, () => { setWindows(null); setHover(null); }));
          if (windows.length === 0) {
            items.push(h("div", { key: "empty", style: { ...S.item, ...S.itemDisabled } }, tr("menu.empty")));
          }
          for (const window of windows.slice(0, 60)) {
            const title = typeof window.title === "string" && window.title !== "" ? window.title : tr("menu.untitled");
            const hint = `${window.process ?? ""}${window.pid === undefined ? "" : ` #${window.pid}`}${window.minimized === true ? ` · ${tr("menu.minimized")}` : ""}`;
            items.push(h("button", {
              key: `hwnd-${window.hwnd}`,
              type: "button",
              style: itemStyle(`hwnd-${window.hwnd}`),
              title: `${title}\n${hint}\n${window.w}×${window.h}`,
              onMouseEnter: () => setHover(`hwnd-${window.hwnd}`),
              onMouseLeave: () => setHover(null),
              onClick: () => run({ mode: "window", hwnd: window.hwnd }),
            },
              h("span", { style: S.rowTitle }, title),
              h("span", { style: S.hint }, hint),
            ));
          }
        }
        return h("div", { "data-dsh-screenshot-win-menu": "true", style: pinned }, h("div", { style: S.list, key: "list" }, items));
      };

      const toast = () => {
        if (status === null) return null;
        const rect = buttonRef.current === null ? null : buttonRef.current.getBoundingClientRect();
        const color = status.kind === "error" ? T.error : status.kind === "ok" ? T.success : T.subtle;
        return h("div", {
          style: {
            ...S.toast,
            borderColor: status.kind === "error" ? T.error : T.border,
            color,
            left: rect === null ? 12 : Math.max(8, Math.min(rect.left, Math.max(8, window.innerWidth - 480))),
            bottom: rect === null ? 80 : Math.max(8, window.innerHeight - rect.top + 8),
          },
        }, status.text);
      };

      return h("span", { style: S.anchor, ref: buttonRef },
        h("button", {
          type: "button",
          style: { ...S.button, opacity: busy ? 0.5 : 1 },
          title: tr("button.title"),
          "aria-label": tr("button.label"),
          "aria-expanded": open,
          disabled: busy,
          onClick: toggle,
        }, h(CameraIcon, null)),
        menu(),
        toast(),
      );
    }

    //#endregion

    //#region tool row

    /**
     * Render the `screenshot` tool call with the picture it produced, dispatching the
     * shipped `tool.call.images` gallery declared as this entry's child slot.
     * @param props - the tool call view props supplied by the Tool surface.
     * @returns the row element.
     */
    function ScreenshotRow(props) {
      const block = props === undefined ? undefined : props.block;
      const content = Array.isArray(block && block.content) ? block.content : [];
      const images = [];
      let caption = "";
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "image" && part.attachment && typeof part.attachment.attachmentId === "string") {
          images.push({ attachment: part.attachment });
        } else if (part.type === "text" && typeof part.text === "string") {
          caption = caption === "" ? part.text : `${caption}\n${part.text}`;
        }
      }
      const children = [];
      if (caption !== "") {
        children.push(h("div", { key: "caption", style: { ...S.caption, marginBottom: images.length > 0 ? 8 : 0 } }, caption));
      }
      if (images.length > 0 && typeof props.renderSlot === "function") {
        children.push(props.renderSlot("tool.call.images", {
          images,
          loadImage: props.loadImage,
          align: "start",
        }));
      }
      return h("div", { style: { padding: "2px 0" } }, children);
    }

    //#endregion

    /**
     * Register the composer button and the screenshot tool row.
     * @param ctx - the Client plugin context.
     */
    function apply(ctx) {
      pluginCtx = ctx;
      tr = makeTranslator(ctx);

      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "dsh-screenshot-win",
        order: 40,
      }, ScreenshotButton));

      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
        name: "tool.call.toolview",
        key: "screenshot",
        children: { "tool.call.images": { kind: "single", scope: "session" } },
      }, ScreenshotRow));
    }

    return {
      name: NS,
      inject: ["slots"],
      apply,
    };
  },
});
