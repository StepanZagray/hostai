/*
 * HostAI model-UI bridge. Served by the gateway next to a runtime's UI and
 * included by that UI with one script tag. The frame runs with an opaque
 * origin and no network; every request reaches HostAI through the host page.
 * Protocol: docs/model-ui.md in the HostAI repository.
 */
(function () {
  "use strict";
  if (window.hostai) return;
  var parent = window.parent;
  if (!parent || parent === window) {
    // Opened outside HostAI: expose a bridge that reports the situation.
    window.hostai = standalone();
    return;
  }

  var pending = {};
  var themeListeners = [];
  var counter = 0;
  var hello = null;
  var helloWaiters = [];

  function post(message) {
    message.hostai = 1;
    parent.postMessage(message, "*");
  }

  function setTheme(theme) {
    if (theme !== "light" && theme !== "dark") return;
    bridge.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    for (var i = 0; i < themeListeners.length; i++) {
      try {
        themeListeners[i](theme);
      } catch (error) {
        /* A listener failure must not break the bridge. */
      }
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.hostai !== 1 || typeof data.type !== "string") return;
    if (data.type === "hello") {
      if (typeof data.model !== "string") return;
      bridge.model = data.model;
      bridge.scope = data.scope === "guest" ? "guest" : "owner";
      setTheme(data.theme);
      hello = { model: bridge.model, theme: bridge.theme, scope: bridge.scope };
      var waiters = helloWaiters;
      helloWaiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i](hello);
      return;
    }
    if (data.type === "theme") {
      setTheme(data.theme);
      return;
    }
    var run = typeof data.id === "string" ? pending[data.id] : null;
    if (!run) return;
    if (data.type === "event") {
      run.events.push(data.event);
      if (run.onEvent) {
        try {
          run.onEvent(data.event);
        } catch (error) {
          /* The UI's handler failed; the stream continues. */
        }
      }
    } else if (data.type === "done") {
      finish(data.id);
      run.resolve(run.events);
    } else if (data.type === "error") {
      finish(data.id);
      run.reject(new Error(typeof data.error === "string" && data.error ? data.error : "Inference failed."));
    }
  });

  function finish(id) {
    var run = pending[id];
    if (!run) return;
    delete pending[id];
    if (run.signal && run.abort) run.signal.removeEventListener("abort", run.abort);
  }

  var bridge = {
    model: null,
    theme: document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
    scope: null,
    ready: function () {
      if (hello) return Promise.resolve(hello);
      return new Promise(function (resolve) {
        helloWaiters.push(resolve);
      });
    },
    infer: function (input, options) {
      options = options || {};
      return new Promise(function (resolve, reject) {
        if (options.signal && options.signal.aborted) {
          reject(new Error("Cancelled."));
          return;
        }
        var id = "r" + ++counter + "-" + Date.now().toString(36);
        var run = {
          events: [],
          onEvent: typeof options.onEvent === "function" ? options.onEvent : null,
          resolve: resolve,
          reject: reject,
          signal: options.signal || null,
          abort: null,
        };
        if (run.signal) {
          run.abort = function () {
            if (!pending[id]) return;
            post({ type: "cancel", id: id });
            finish(id);
            reject(new Error("Cancelled."));
          };
          run.signal.addEventListener("abort", run.abort, { once: true });
        }
        pending[id] = run;
        post({ type: "infer", id: id, input: input });
      });
    },
    onTheme: function (callback) {
      if (typeof callback !== "function") return function () {};
      themeListeners.push(callback);
      return function () {
        var index = themeListeners.indexOf(callback);
        if (index >= 0) themeListeners.splice(index, 1);
      };
    },
  };

  window.hostai = bridge;
  post({ type: "ready" });

  function standalone() {
    var never = new Promise(function () {});
    return {
      model: null,
      theme: "light",
      scope: null,
      ready: function () {
        return never;
      },
      infer: function () {
        return Promise.reject(new Error("This page must be opened inside HostAI."));
      },
      onTheme: function () {
        return function () {};
      },
    };
  }
})();
