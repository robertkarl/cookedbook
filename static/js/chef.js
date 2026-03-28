/**
 * CookedBook Chef — voice assistant for hands-free recipe queries.
 *
 * Tap the big mic button → record → silence detection → send to server
 * Server: faster-whisper STT → Ollama LLM → Piper TTS → WAV back
 */

(function () {
  "use strict";

  // --- Config ---
  var wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  var CHEF_WS_URL = window.CHEF_WS_URL || (wsProto + "//" + location.host + "/ws/voice");
  var SILENCE_THRESHOLD = 0.015;
  var SILENCE_DURATION_MS = 1500;
  var MAX_RECORD_MS = 15000;
  var TARGET_SAMPLE_RATE = 16000;

  // --- State ---
  var ws = null;
  var recording = false;
  var pcmChunks = [];
  var silenceStart = 0;
  var recordStart = 0;
  var state = "idle";

  // --- DOM refs ---
  var btn = null;
  var statusEl = null;
  var transcriptEl = null;
  var answerEl = null;

  // --- WebSocket ---
  function connectWS() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(CHEF_WS_URL);
    ws.onopen = function () { console.log("[chef] WS connected"); };
    ws.onmessage = function (evt) { handleServerMessage(JSON.parse(evt.data)); };
    ws.onclose = function () {
      console.log("[chef] WS closed, reconnecting in 2s...");
      setTimeout(connectWS, 2000);
    };
    ws.onerror = function (err) { console.error("[chef] WS error", err); };
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case "status":
        setState(msg.state);
        break;
      case "transcript":
        if (transcriptEl) {
          transcriptEl.textContent = '"' + msg.text + '"';
          transcriptEl.style.display = "block";
        }
        break;
      case "answer":
        if (answerEl) {
          answerEl.textContent = msg.text;
          answerEl.style.display = "block";
        }
        break;
      case "audio":
        playWavBase64(msg.wav);
        break;
      case "error":
        console.error("[chef] Server error:", msg.message);
        if (statusEl) statusEl.textContent = msg.message;
        setState("idle");
        break;
    }
  }

  // --- Audio playback ---
  function playWavBase64(b64) {
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.decodeAudioData(bytes.buffer, function (buffer) {
      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = function () {
        ctx.close();
        setState("idle");
      };
      source.start(0);
    }, function (err) {
      console.error("[chef] Audio decode error:", err);
      ctx.close();
      setState("idle");
    });
  }

  // --- Recording: fresh mic each time ---
  function startRecording() {
    if (recording) return;

    if (transcriptEl) { transcriptEl.textContent = ""; transcriptEl.style.display = "none"; }
    if (answerEl) { answerEl.textContent = ""; answerEl.style.display = "none"; }
    setState("listening");

    var audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_SAMPLE_RATE });

    audioCtx.resume().then(function () {
      return navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: TARGET_SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
    }).then(function (stream) {
      recording = true;
      pcmChunks = [];
      silenceStart = 0;
      recordStart = Date.now();

      var source = audioCtx.createMediaStreamSource(stream);
      var processor = audioCtx.createScriptProcessor(4096, 1, 1);

      function cleanup() {
        recording = false;
        try { processor.disconnect(); } catch (e) {}
        try { source.disconnect(); } catch (e) {}
        stream.getTracks().forEach(function (t) { t.stop(); });
        try { audioCtx.close(); } catch (e) {}
      }

      processor.onaudioprocess = function (e) {
        if (!recording) return;
        var input = e.inputBuffer.getChannelData(0);
        var sum = 0;
        for (var i = 0; i < input.length; i++) sum += input[i] * input[i];
        var rms = Math.sqrt(sum / input.length);

        var pcm = new Int16Array(input.length);
        for (var j = 0; j < input.length; j++) {
          var s = Math.max(-1, Math.min(1, input[j]));
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        pcmChunks.push(pcm);

        var now = Date.now();
        if (rms < SILENCE_THRESHOLD) {
          if (silenceStart === 0) silenceStart = now;
          if (now - silenceStart > SILENCE_DURATION_MS && now - recordStart > 500) {
            cleanup();
            sendAudio();
          }
        } else {
          silenceStart = 0;
        }

        if (now - recordStart > MAX_RECORD_MS) {
          cleanup();
          sendAudio();
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      window._chefStopRecording = function () {
        if (recording) {
          cleanup();
          sendAudio();
        }
      };

    }).catch(function (err) {
      console.error("[chef] Mic error:", err);
      if (statusEl) statusEl.textContent = "Mic access denied";
      setState("idle");
    });
  }

  function sendAudio() {
    setState("transcribing");

    var totalLen = 0;
    for (var i = 0; i < pcmChunks.length; i++) totalLen += pcmChunks[i].length;
    var merged = new Int16Array(totalLen);
    var offset = 0;
    for (var j = 0; j < pcmChunks.length; j++) {
      merged.set(pcmChunks[j], offset);
      offset += pcmChunks[j].length;
    }
    pcmChunks = [];

    var bytes = new Uint8Array(merged.buffer);
    var b64 = arrayBufferToBase64(bytes);
    var recipeText = getRecipeText();

    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ audio: b64, recipe: recipeText }));
    } else {
      console.error("[chef] WebSocket not connected");
      setState("idle");
    }
  }

  function arrayBufferToBase64(bytes) {
    var binary = "";
    var len = bytes.byteLength;
    var chunkSize = 8192;
    for (var i = 0; i < len; i += chunkSize) {
      var chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
      for (var j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j]);
      }
    }
    return btoa(binary);
  }

  function getRecipeText() {
    var content = document.querySelector(".recipe-content");
    if (!content) return "";
    var title = document.querySelector(".recipe h1");
    var text = "";
    if (title) text += title.textContent + "\n\n";
    text += content.innerText;
    return text;
  }

  // --- UI state machine ---
  function setState(newState) {
    state = newState;
    if (!btn || !statusEl) return;

    switch (state) {
      case "idle":
        btn.classList.remove("chef-btn-active", "chef-btn-processing");
        btn.innerHTML = '<span class="chef-btn-icon">&#x1F3A4;</span>';
        statusEl.textContent = "Tap to ask Chef";
        break;
      case "listening":
        btn.classList.remove("chef-btn-processing");
        btn.classList.add("chef-btn-active");
        btn.innerHTML = '<span class="chef-btn-icon chef-btn-pulse">&#x1F3A4;</span>';
        statusEl.textContent = "Listening...";
        break;
      case "transcribing":
        btn.classList.remove("chef-btn-active");
        btn.classList.add("chef-btn-processing");
        btn.innerHTML = '<span class="chef-btn-icon">&#x23F3;</span>';
        statusEl.textContent = "Hearing you...";
        break;
      case "thinking":
        btn.innerHTML = '<span class="chef-btn-icon">&#x1F9D1;&#x200D;&#x1F373;</span>';
        statusEl.textContent = "Thinking...";
        break;
      case "speaking":
        btn.innerHTML = '<span class="chef-btn-icon">&#x1F50A;</span>';
        statusEl.textContent = "Chef says:";
        break;
    }
  }

  // --- Button handler ---
  function onButtonTap() {
    if (state === "listening") {
      if (window._chefStopRecording) window._chefStopRecording();
      return;
    }
    if (state !== "idle") return;

    connectWS();
    startRecording();
  }

  // --- Wake Lock ---
  function requestWakeLock() {
    if ("wakeLock" in navigator) {
      navigator.wakeLock.request("screen").catch(function () {});
    }
  }

  // --- Init ---
  function initChef() {
    var container = document.createElement("div");
    container.id = "chef-container";
    container.innerHTML =
      '<div id="chef-panel">' +
        '<button id="chef-btn" type="button"><span class="chef-btn-icon">&#x1F3A4;</span></button>' +
        '<div id="chef-status">Tap to ask Chef</div>' +
        '<div id="chef-transcript"></div>' +
        '<div id="chef-answer"></div>' +
      "</div>";
    document.body.appendChild(container);

    btn = document.getElementById("chef-btn");
    statusEl = document.getElementById("chef-status");
    transcriptEl = document.getElementById("chef-transcript");
    answerEl = document.getElementById("chef-answer");

    btn.addEventListener("click", onButtonTap);

    requestWakeLock();
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") requestWakeLock();
    });
  }

  if (localStorage.getItem("chef-enabled") !== "1") return;

  if (document.querySelector(".recipe-content")) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initChef);
    } else {
      initChef();
    }
  }
})();
