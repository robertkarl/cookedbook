/**
 * CookedBook Chef Chat — text-based multi-turn conversation with the recipe LLM.
 */

(function () {
  "use strict";

  if (!document.querySelector(".recipe-content")) return;

  var messages = []; // {role: "user"|"assistant", content: "..."}
  var chatOpen = false;
  var chatEl, chatMessages, chatInput, chatToggle, chatSend;

  function getRecipeText() {
    var content = document.querySelector(".recipe-content");
    if (!content) return "";
    var title = document.querySelector(".recipe h1");
    var text = "";
    if (title) text += title.textContent + "\n\n";
    text += content.innerText;
    return text;
  }

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(s));
    return div.innerHTML;
  }

  function renderMarkdown(text) {
    // Minimal markdown: **bold**, `code`, newlines, lists
    var html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\n- /g, "\n• ");
    html = html.replace(/\n/g, "<br>");
    return html;
  }

  function addMessage(role, content) {
    messages.push({ role: role, content: content });

    var bubble = document.createElement("div");
    bubble.className = "chat-msg chat-msg-" + role;
    bubble.innerHTML = role === "assistant" ? renderMarkdown(content) : escapeHtml(content);
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function sendMessage() {
    var text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";

    addMessage("user", text);

    // Show typing indicator
    var typing = document.createElement("div");
    typing.className = "chat-msg chat-msg-assistant chat-typing";
    typing.textContent = "...";
    chatMessages.appendChild(typing);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ messages: messages, recipe: getRecipeText() }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.remove();
        addMessage("assistant", data.reply);
      })
      .catch(function (err) {
        typing.remove();
        addMessage("assistant", "Error: " + err.message);
      });
  }

  function toggleChat() {
    chatOpen = !chatOpen;
    chatEl.style.display = chatOpen ? "flex" : "none";
    chatToggle.textContent = chatOpen ? "\u2715" : "\uD83D\uDCAC";
    chatToggle.setAttribute("aria-label", chatOpen ? "Close chat" : "Open chat");
    if (chatOpen) chatInput.focus();
  }

  function initChat() {
    // Toggle button (top-left of chef container, above the mic)
    chatToggle = document.createElement("button");
    chatToggle.id = "chat-toggle";
    chatToggle.type = "button";
    chatToggle.textContent = "\uD83D\uDCAC";
    chatToggle.setAttribute("aria-label", "Open chat");
    chatToggle.addEventListener("click", toggleChat);

    var chefContainer = document.getElementById("chef-container");
    if (chefContainer) {
      chefContainer.querySelector("#chef-panel").prepend(chatToggle);
    }

    // Chat panel
    chatEl = document.createElement("div");
    chatEl.id = "chat-panel";
    chatEl.style.display = "none";
    chatEl.innerHTML =
      '<div id="chat-header">Chef Chat</div>' +
      '<div id="chat-messages"></div>' +
      '<div id="chat-input-row">' +
        '<input id="chat-input" type="text" placeholder="Ask about this recipe..." autocomplete="off">' +
        '<button id="chat-send" type="button">Send</button>' +
      '</div>';
    document.body.appendChild(chatEl);

    chatMessages = document.getElementById("chat-messages");
    chatInput = document.getElementById("chat-input");
    chatSend = document.getElementById("chat-send");

    chatSend.addEventListener("click", sendMessage);
    chatInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  // Wait for auth, then for chef.js to create #chef-container
  document.addEventListener("chef-auth-ready", function () {
    setTimeout(initChat, 50);
  });
})();
