/**
 * CookedBook Chef — voice assistant for hands-free recipe queries.
 *
 * Architecture:
 *   1. User taps the big mic button (or it auto-arms after playback)
 *   2. AudioWorklet captures 16kHz 16-bit mono PCM
 *   3. Simple energy-based VAD detects silence → stops recording
 *   4. PCM sent as base64 over WebSocket to the Chef server
 *   5. Server: faster-whisper STT → Ollama LLM → Piper TTS → WAV back
 *   6. Browser plays the WAV response
 */

(function () {
  "use strict";

  // --- Config ---
  var CHEF_WS_URL = window.CHEF_WS_URL || "wss://chef.robertkarl.net/ws/voice";
  var SILENCE_THRESHOLD = 0.015;   // RMS below this = silence
  var SILENCE_DURATION_MS = 1500;  // 1.5s of silence = done talking
  var MAX_RECORD_MS = 15000;       // safety cap: 15s max recording
  var TARGET_SAMPLE_RATE = 16000;

  // --- State ---
  var ws = null;
  var audioCtx = null;
  var micStream = null;
  var workletNode = null;
  var recording = false;
  var pcmChunks = [];
  var silenceStart = 0;
  var recordStart = 0;
  var state = "idle"; // idle, listening, transcribing, thinking, speaking

  // --- DOM refs (set in init) ---
  var btn = null;
  var statusEl = null;
  var transcriptEl = null;
  var answerEl = null;

  // --- WebSocket ---
  function connectWS() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(CHEF_WS_URL);
    ws.onopen = function () {
      console.log("[chef] WS connected");
    };
    ws.onmessage = function (evt) {
      var msg = JSON.parse(evt.data);
      handleServerMessage(msg);
    };
    ws.onclose = function () {
      console.log("[chef] WS closed, reconnecting in 2s...");
      setTimeout(connectWS, 2000);
    };
    ws.onerror = function (err) {
      console.error("[chef] WS error", err);
    };
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

    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    audioCtx.decodeAudioData(bytes.buffer, function (buffer) {
      var source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.onended = function () {
        setState("idle");
      };
      source.start(0);
    }, function (err) {
      console.error("[chef] Audio decode error:", err);
      setState("idle");
    });
  }

  // --- Mic + AudioWorklet setup ---
  function initAudio(callback) {
    if (audioCtx && micStream) {
      callback();
      return;
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_SAMPLE_RATE });

    // Resume AudioContext (required by Safari on first user gesture)
    audioCtx.resume().then(function () {
      return navigator.mediaDevices.getUserMedia({ audio: { sampleRate: TARGET_SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    }).then(function (stream) {
      micStream = stream;

      // Use ScriptProcessorNode — simpler than AudioWorklet for prototype,
      // and has wider Safari support including older iPadOS.
      var source = audioCtx.createMediaStreamSource(stream);
      var processor = audioCtx.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = function (e) {
        if (!recording) return;
        var input = e.inputBuffer.getChannelData(0);
        // Compute RMS for VAD
        var sum = 0;
        for (var i = 0; i < input.length; i++) sum += input[i] * input[i];
        var rms = Math.sqrt(sum / input.length);

        // Convert float32 to int16 PCM
        var pcm = new Int16Array(input.length);
        for (var j = 0; j < input.length; j++) {
          var s = Math.max(-1, Math.min(1, input[j]));
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        pcmChunks.push(pcm);

        // Silence detection
        var now = Date.now();
        if (rms < SILENCE_THRESHOLD) {
          if (silenceStart === 0) silenceStart = now;
          if (now - silenceStart > SILENCE_DURATION_MS && now - recordStart > 500) {
            stopRecording();
          }
        } else {
          silenceStart = 0;
        }

        // Safety timeout
        if (now - recordStart > MAX_RECORD_MS) {
          stopRecording();
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination); // required for onaudioprocess to fire

      callback();
    }).catch(function (err) {
      console.error("[chef] Mic error:", err);
      if (statusEl) statusEl.textContent = "Mic access denied";
    });
  }

  // --- Recording control ---
  function startRecording() {
    if (recording) return;
    recording = true;
    pcmChunks = [];
    silenceStart = 0;
    recordStart = Date.now();
    setState("listening");
    if (transcriptEl) { transcriptEl.textContent = ""; transcriptEl.style.display = "none"; }
    if (answerEl) { answerEl.textContent = ""; answerEl.style.display = "none"; }
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    setState("transcribing");

    // Merge chunks
    var totalLen = 0;
    for (var i = 0; i < pcmChunks.length; i++) totalLen += pcmChunks[i].length;
    var merged = new Int16Array(totalLen);
    var offset = 0;
    for (var j = 0; j < pcmChunks.length; j++) {
      merged.set(pcmChunks[j], offset);
      offset += pcmChunks[j].length;
    }
    pcmChunks = [];

    // Base64 encode
    var bytes = new Uint8Array(merged.buffer);
    var b64 = arrayBufferToBase64(bytes);

    // Get recipe text from the page
    var recipeText = getRecipeText();

    // Send to server
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
    // Process in chunks to avoid call stack overflow
    var chunkSize = 8192;
    for (var i = 0; i < len; i += chunkSize) {
      var chunk = bytes.subarray(i, Math.min(i + chunkSize, len));
      for (var j = 0; j < chunk.length; j++) {
        binary += String.fromCharCode(chunk[j]);
      }
    }
    return btoa(binary);
  }

  // --- Extract recipe text from the DOM ---
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
        btn.classList.add("chef-btn-active");
        btn.classList.remove("chef-btn-processing");
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
      // Manual stop
      stopRecording();
      return;
    }
    if (state !== "idle") return;

    initAudio(function () {
      connectWS();
      startRecording();
    });
  }

  // --- Wake Lock (keep screen on while cooking) ---
  function requestWakeLock() {
    if ("wakeLock" in navigator) {
      navigator.wakeLock.request("screen").catch(function () {});
    }
  }

  // --- Init ---
  function initChef() {
    // Create the floating UI
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

    // Keep screen alive
    requestWakeLock();
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") requestWakeLock();
    });
  }

  // Only init on recipe pages
  if (document.querySelector(".recipe-content")) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initChef);
    } else {
      initChef();
    }
  }
})();
