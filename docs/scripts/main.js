/**
 * Siggy — MyGeotab Add-In Chatbot
 *
 * A fleet intelligence advisor powered by Geotab Ace, with a custom persona,
 * curated knowledge base, and account-specific fleet context.
 */

geotab.addin.siggy = function () {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────
  var POLL_INTERVAL_MS = 2000;
  var POLL_TIMEOUT_MS = 90000;

  // ── Knowledge Base ─────────────────────────────────────────────────────
  var KNOWLEDGE_BASE = [
    "## MyGeotab Best Practices & Knowledge Base",
    "",
    "### Safety",
    "- Use Risk Management Report to identify high-risk drivers by composite safety score.",
    "- Set up harsh braking, harsh acceleration, and harsh cornering rules with appropriate thresholds.",
    "- Configure seatbelt rules for real-time alerts — seatbelt compliance directly correlates with accident severity.",
    "- Review the Safety Scorecard weekly; focus coaching on the bottom 10% of drivers.",
    "- Use in-vehicle audible alerts (buzzer/Add-In) for immediate driver feedback on speeding and harsh events.",
    "",
    "### Compliance",
    "- DVIR (Driver Vehicle Inspection Reports): ensure pre-trip and post-trip inspections are completed daily.",
    "- HOS (Hours of Service): monitor ELD compliance; set up automatic violation alerts.",
    "- IFTA fuel tax reporting: use trip data to auto-calculate jurisdiction miles.",
    "- Set up automatic exception email reports for compliance managers.",
    "",
    "### Fleet Optimization",
    "- Idle time costs ~$1/gallon wasted; create idle-time rules (typically >5 min threshold).",
    "- Use Trip History to identify route inefficiencies and unauthorized vehicle use.",
    "- Fuel efficiency monitoring: track MPG trends per vehicle and flag outliers.",
    "- Preventive maintenance schedules based on odometer or engine hours reduce breakdowns 25-30%.",
    "- Zone-based alerts: set up customer site geofences to track arrival/departure for proof of service.",
    "",
    "### EV & Sustainability",
    "- EV Suitability Assessment (EVSA): identifies vehicles that are candidates for EV replacement based on duty cycles.",
    "- Monitor EV state-of-charge and range anxiety thresholds.",
    "- Track CO2 emissions per vehicle to support sustainability reporting.",
    "- Green fleet dashboard: compare ICE vs EV total cost of ownership.",
    "",
    "### Admin & Platform",
    "- Use Groups (org structure) to control data visibility by role.",
    "- Security clearances: assign least-privilege access; review quarterly.",
    "- Custom reports: use Report Builder or MyGeotab SDK for scheduled report distribution.",
    "- Add-In marketplace: explore third-party integrations (camera, fuel card, dispatch).",
    "- API rate limits: batch calls using MultiCall; cache reference data."
  ].join("\n");

  // ── State ──────────────────────────────────────────────────────────────
  var api;
  var chatId = null;
  var fleetContext = null;
  var isSending = false;

  // ── DOM refs ───────────────────────────────────────────────────────────
  var els = {};

  function $(id) {
    return document.getElementById(id);
  }

  // ── Ace API Layer ──────────────────────────────────────────────────────

  /** Wrap api.call in a Promise. */
  function apiCall(method, params) {
    return new Promise(function (resolve, reject) {
      api.call(method, params, resolve, reject);
    });
  }

  /** Call GetAceResults via direct fetch to /apiv1 (bypasses api.call). */
  function aceCall(functionName, functionParameters) {
    return new Promise(function (resolve, reject) {
      api.getSession(function (session) {
        var server = session.server || "my.geotab.com";
        var url = "https://" + server + "/apiv1";
        var body = {
          method: "GetAceResults",
          params: {
            credentials: {
              database: session.database,
              userName: session.userName,
              sessionId: session.sessionId
            },
            serviceName: "dna-planet-orchestration",
            functionName: functionName,
            customerData: true,
            environment: "prod",
            functionParameters: functionParameters || {}
          }
        };
        console.log("[Siggy] aceCall ->", url, JSON.stringify(body).substring(0, 300));
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        })
          .then(function (r) { return r.json(); })
          .then(function (json) {
            console.log("[Siggy] aceCall raw:", JSON.stringify(json).substring(0, 500));
            if (json.error) {
              reject(new Error(json.error.message || JSON.stringify(json.error)));
              return;
            }
            // Unwrap: json.result -> apiResult.results[0]
            var outer = json.result || {};
            var apiResult = outer.apiResult || outer;
            // Check for API-level errors
            var apiErrors = (apiResult.errors && apiResult.errors.length > 0) ? apiResult.errors : null;
            if (!apiErrors) apiErrors = (outer.errors && outer.errors.length > 0) ? outer.errors : null;
            if (apiErrors) {
              reject(new Error(apiErrors[0].message || JSON.stringify(apiErrors[0])));
              return;
            }
            var results = apiResult.results || [];
            var unwrapped = results[0] || apiResult;
            console.log("[Siggy] aceCall unwrapped:", JSON.stringify(unwrapped).substring(0, 500));
            resolve(unwrapped);
          })
          .catch(reject);
      });
    });
  }

  /** Create a new Ace chat session. */
  function createChat() {
    return aceCall("create-chat", {})
      .then(function (result) {
        console.log("[Siggy] create-chat:", JSON.stringify(result));
        var id = result.chat_id || result.chatId;
        console.log("[Siggy] chat_id:", id);
        return id;
      });
  }

  /** Send a prompt to Ace. Returns the message_group_id for polling. */
  function sendPrompt(chatIdVal, prompt) {
    console.log("[Siggy] sendPrompt chat_id:", chatIdVal);
    return aceCall("send-prompt", {
      chat_id: chatIdVal,
      prompt: prompt,
      human_in_the_loop: true
    }).then(function (result) {
      console.log("[Siggy] send-prompt:", JSON.stringify(result));
      var mgId = result.message_group_id || result.messageGroupId;
      console.log("[Siggy] message_group_id:", mgId);
      return mgId;
    });
  }

  /** Poll get-message-group until response is complete. */
  function pollForResponse(chatIdVal, msgGroupId) {
    var startTime = Date.now();
    var pollCount = 0;

    return new Promise(function (resolve, reject) {
      function poll() {
        if (Date.now() - startTime > POLL_TIMEOUT_MS) {
          reject(new Error("Response timed out after " + (POLL_TIMEOUT_MS / 1000) + " seconds."));
          return;
        }

        pollCount++;
        aceCall("get-message-group", {
          chat_id: chatIdVal,
          message_group_id: msgGroupId
        }).then(function (result) {
          console.log("[Siggy] get-message-group poll #" + pollCount + ":", JSON.stringify(result).substring(0, 500));

          var data = result.data || result;

          // Status can be nested: { status: { status: "DONE" } } or flat string
          var statusObj = data.status || {};
          var status;
          if (typeof statusObj === "object") {
            status = statusObj.status || "";
          } else {
            status = String(statusObj);
          }
          status = status.toUpperCase();
          console.log("[Siggy] parsed status:", status);

          if (status === "DONE" || status === "COMPLETE" || status === "COMPLETED") {
            // Messages may be an object keyed by ID or an array
            var messages = data.messages || {};
            var responseText = "";

            if (Array.isArray(messages)) {
              for (var j = 0; j < messages.length; j++) {
                var m = messages[j];
                if (m.type === "UserPrompt" || m.role === "user") continue;
                responseText = m.reasoning || m.content || m.text || m.message || "";
                if (responseText) break;
              }
            } else {
              var msgKeys = Object.keys(messages);
              for (var i = 0; i < msgKeys.length; i++) {
                var msg = messages[msgKeys[i]];
                if (msg.type === "UserPrompt" || msg.role === "user") continue;
                responseText = msg.reasoning || msg.content || msg.text || msg.message || "";
                if (responseText) break;
              }
            }

            // Fallback
            if (!responseText) {
              responseText = data.reasoning || data.content || data.text || "No response received.";
            }
            console.log("[Siggy] response text:", responseText.substring(0, 200));
            resolve(responseText);
          } else if (status === "ERROR" || status === "FAILED") {
            reject(new Error(statusObj.message || data.message || "Ace returned an error."));
          } else {
            // Still processing — poll again
            setTimeout(poll, POLL_INTERVAL_MS);
          }
        }).catch(function (err) {
          console.error("[Siggy] poll error:", err);
          reject(err);
        });
      }

      poll();
    });
  }

  /** Ensure we have a chat session (lazy creation on first message). */
  function ensureChatId() {
    if (chatId) return Promise.resolve(chatId);
    return createChat().then(function (id) {
      chatId = id;
      return id;
    });
  }

  // ── Prompt Builder ─────────────────────────────────────────────────────

  function buildPrompt(userText) {
    var parts = [];

    parts.push("You are Siggy, a friendly and knowledgeable fleet intelligence advisor inside MyGeotab.");
    parts.push("You give clear, actionable recommendations grounded in fleet management best practices.");
    parts.push("Be conversational but concise. Use bullet points for lists. If you suggest a MyGeotab feature, mention where to find it in the UI.");
    parts.push("Do not mention that you are an AI or that you are powered by any specific model.");
    parts.push("");

    if (fleetContext) {
      parts.push("## Current Fleet Context");
      if (fleetContext.deviceCount !== null) {
        parts.push("- Total vehicles: " + fleetContext.deviceCount);
      }
      if (fleetContext.driverCount !== null) {
        parts.push("- Total drivers: " + fleetContext.driverCount);
      }
      if (fleetContext.activeRules && fleetContext.activeRules.length > 0) {
        parts.push("- Active rules: " + fleetContext.activeRules.join(", "));
      }
      parts.push("");
    }

    parts.push(KNOWLEDGE_BASE);
    parts.push("");
    parts.push("## User Question");
    parts.push(userText);

    return parts.join("\n");
  }

  // ── Fleet Context Fetcher ──────────────────────────────────────────────

  function fetchFleetContext() {
    var devicePromise = apiCall("Get", {
      typeName: "Device",
      search: {},
      resultsLimit: 1
    }).then(function () {
      // Use GetCountOf for accurate count
      return apiCall("GetCountOf", { typeName: "Device" });
    }).catch(function () { return null; });

    var userPromise = apiCall("GetCountOf", {
      typeName: "User"
    }).catch(function () { return null; });

    var rulesPromise = apiCall("Get", {
      typeName: "Rule",
      resultsLimit: 20
    }).catch(function () { return []; });

    return Promise.all([devicePromise, userPromise, rulesPromise]).then(function (results) {
      var ruleNames = [];
      if (Array.isArray(results[2])) {
        for (var i = 0; i < Math.min(results[2].length, 10); i++) {
          if (results[2][i].name) {
            ruleNames.push(results[2][i].name);
          }
        }
      }

      fleetContext = {
        deviceCount: results[0],
        driverCount: results[1],
        activeRules: ruleNames
      };
    }).catch(function (err) {
      console.warn("Siggy: could not load fleet context:", err);
      fleetContext = null;
    });
  }

  // ── Chat UI Controller ─────────────────────────────────────────────────

  /** Add a message bubble to the chat. */
  function addMessage(text, role) {
    var div = document.createElement("div");
    div.className = "siggy-msg siggy-msg-" + role;
    div.textContent = text;
    els.messages.appendChild(div);
    scrollToBottom();
    return div;
  }

  /** Scroll the messages container to the bottom. */
  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  /** Show/hide the typing indicator. */
  function showTyping(show) {
    els.typing.style.display = show ? "" : "none";
    if (show) scrollToBottom();
  }

  /** Hide the welcome message and chips after first interaction. */
  function hideWelcome() {
    if (els.welcome) {
      els.welcome.style.display = "none";
    }
    if (els.chips) {
      els.chips.style.display = "none";
    }
  }

  /** Reset chat for a new conversation. */
  function resetChat() {
    chatId = null;
    els.messages.innerHTML = "";

    // Restore welcome + chips
    els.messages.appendChild(els.welcomeNode);
    els.messages.appendChild(els.chipsNode);
    els.welcome.style.display = "";
    els.chips.style.display = "";

    isSending = false;
    showTyping(false);
    els.input.value = "";
    updateSendButton();
    els.input.focus();
  }

  /** Enable/disable the send button based on input content. */
  function updateSendButton() {
    els.send.disabled = !els.input.value.trim() || isSending;
  }

  /** Auto-resize the textarea to fit content. */
  function autoResize() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px";
  }

  // ── Send Message Flow ──────────────────────────────────────────────────

  function handleSend() {
    var text = els.input.value.trim();
    if (!text || isSending) return;

    isSending = true;
    updateSendButton();
    hideWelcome();

    // Show user message
    addMessage(text, "user");
    els.input.value = "";
    autoResize();

    // Show typing indicator
    showTyping(true);

    // Build the augmented prompt
    var augmentedPrompt = buildPrompt(text);

    // Send to Ace
    ensureChatId()
      .then(function (cid) {
        return sendPrompt(cid, augmentedPrompt);
      })
      .then(function (msgGroupId) {
        return pollForResponse(chatId, msgGroupId);
      })
      .then(function (responseText) {
        showTyping(false);
        addMessage(responseText, "assistant");
      })
      .catch(function (err) {
        showTyping(false);
        console.error("Siggy error:", err);
        addMessage("Sorry, I ran into an issue: " + (err.message || err), "error");
        // Reset chatId on error so next message tries a fresh chat
        if (err.message && err.message.indexOf("timed out") === -1) {
          chatId = null;
        }
      })
      .then(function () {
        isSending = false;
        updateSendButton();
        els.input.focus();
      });
  }

  // ── Event Handlers ─────────────────────────────────────────────────────

  function onInputKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function onChipClick(e) {
    var chip = e.target.closest(".siggy-chip");
    if (!chip) return;
    var prompt = chip.dataset.prompt;
    if (prompt) {
      els.input.value = prompt;
      updateSendButton();
      handleSend();
    }
  }

  // ── Add-In Lifecycle ───────────────────────────────────────────────────

  return {
    initialize: function (freshApi, state, callback) {
      api = freshApi;

      // Cache DOM refs
      els.messages = $("siggy-messages");
      els.typing = $("siggy-typing");
      els.input = $("siggy-input");
      els.send = $("siggy-send");
      els.newChat = $("siggy-new-chat");
      els.welcome = $("siggy-welcome");
      els.chips = $("siggy-chips");

      // Keep cloneable references for reset
      els.welcomeNode = els.welcome;
      els.chipsNode = els.chips;

      // Event listeners
      els.send.addEventListener("click", handleSend);
      els.input.addEventListener("keydown", onInputKeydown);
      els.input.addEventListener("input", function () {
        updateSendButton();
        autoResize();
      });
      els.newChat.addEventListener("click", resetChat);
      els.chips.addEventListener("click", onChipClick);

      // Fetch fleet context in background, then signal ready
      fetchFleetContext().then(function () {
        callback();
      }).catch(function () {
        callback();
      });
    },

    focus: function (freshApi) {
      api = freshApi;
      els.input.focus();
    },

    blur: function () {
      // Nothing to clean up
    }
  };
};
